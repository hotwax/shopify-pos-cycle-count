// One logical document per key. Small documents are a single native value that
// is overwritten in place. A document overflows into extra values only when its
// root would exceed the working limit; the root is always written last and is
// the commit point, so a multi-value commit is atomic. Overflow values alternate
// between two slots (`a`/`b`), so the slot a committed root references is never
// overwritten. Records are kept in arrays: chronology never depends on key order.
const FORMAT = 'hotwax-count-3', LEGACY = 'hotwax-count-pages-1', LIMIT = 900000, SEAL = 850000;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
// UTF-8 length of a string without allocating an encoded copy.
export const utf8 = text => {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7ff) {bytes += 2; if (code >= 0xd800 && code < 0xdc00) i++;}
    else if (code > 0x7f) bytes++;
  }
  return bytes;
};
export const jsonBytes = value => utf8(JSON.stringify(value));
const sizes = new WeakMap();
const sized = record => {let bytes = sizes.get(record); if (bytes === undefined) sizes.set(record, bytes = jsonBytes(record) + 1); return bytes;};
const total = records => records.reduce((sum, record) => sum + sized(record), 0);
const token = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const slotKey = (key, n, slot) => `${key}:more:${n}${slot}`;
const storageFull = error => error?.code === 'RecordsCount' || error?.name === 'StorageError' && /count/i.test(error?.message || '');

export class CountStorage {
  constructor(native) {this.native = native; this.docs = new Map(); this.unsure = new Set();}
  get(key) {return this.native.get(key);}
  set(key, value) {return this.native.set(key, value);}
  delete(key) {return this.native.delete(key);}
  async deleteAll(keys) {for (const key of keys) await this.native.delete(key);}
  /** Delete each key; return the ones whose delete failed, to retry later. */
  async retireAll(keys) {
    const left = [];
    for (const key of keys) {try {await this.native.delete(key);} catch {left.push(key);}}
    return left;
  }
  /** Delete overflow slots no committed root references: the other slot of each
   * referenced index, every unreferenced index up to `hw`, and indices past `hw`
   * written by a commit that never reached its root. */
  async sweep(key, more = [], hw = 0) {
    const referenced = new Map(more.map(ref => [ref.n, ref.slot]));
    for (let n = 1; n <= hw; n++) for (const slot of ['a', 'b']) if (referenced.get(n) !== slot) await this.native.delete(slotKey(key, n, slot));
    for (let n = hw + 1; ; n++) {
      const a = await this.native.delete(slotKey(key, n, 'a')), b = await this.native.delete(slotKey(key, n, 'b'));
      if (!a && !b) break;
    }
  }

  /** Root header and summary only (background status and cleanup). Never writes. */
  async metadata(key) {
    const root = parse(await this.native.get(key));
    return root?.format === FORMAT && !root.removed ? {header: root.header, summary: root.summary, stamp: root.stamp} : {legacy: root != null && !root.removed};
  }
  /** Background read of a committed document. It never recovers or writes; a
   * concurrent commit makes it retry once and then report the copy as changing. */
  async peek(key) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const root = parse(await this.native.get(key));
      if (root?.format !== FORMAT || root.removed) return undefined;
      const chunks = await Promise.all(root.more.map(async ref => parse(await this.native.get(slotKey(key, ref.n, ref.slot)))));
      if (chunks.every((chunk, i) => chunk?.of === key && chunk.stamp === root.more[i].stamp))
        return {header: root.header, summary: root.summary, records: [...chunks.flatMap(chunk => chunk.data), ...root.data]};
    }
    throw new Error('The local checkpoint is changing. Retry after counting pauses.');
  }

  /** Foreground load. Finishes interrupted commits and removals, and reads older
   * formats (returned with `legacy` set) so the caller can project and save them. */
  async load(key) {
    const root = parse(await this.native.get(key));
    if (root == null) {this.docs.delete(key); return undefined;}
    this.unsure.delete(key);
    if (root.format === LEGACY || (root.format !== FORMAT && !root.removed)) {
      // A migration that stopped before its root committed may have left new slots.
      this.docs.delete(key); await this.sweep(key);
      return this.readLegacy(key, root);
    }
    // Unreferenced alternates and abandoned indices are left by interrupted commits.
    await this.sweep(key, root.removed ? [] : root.more, root.hw || 0);
    if (root.removed) {
      if (await this.retireAll(root.retire || []).then(left => left.length)) throw new Error('Saved count cleanup is not finished. Reopen to retry.');
      await this.native.delete(key); this.docs.delete(key); return undefined;
    }
    const chunks = [];
    for (const ref of root.more) {
      const chunk = parse(await this.native.get(slotKey(key, ref.n, ref.slot)));
      if (chunk?.of !== key || chunk.stamp !== ref.stamp) throw new Error('A saved count value is missing. Keep this device and contact support.');
      chunks.push({...ref, data: chunk.data});
    }
    // Retired keys of an earlier format go only once the new document reads back whole.
    const retire = root.retire?.length ? await this.retireAll(root.retire) : [];
    this.docs.set(key, {chunks, root: root.data, hw: root.hw || 0, retire});
    return {header: root.header, summary: root.summary, records: [...chunks.flatMap(chunk => chunk.data), ...root.data]};
  }

  /** Read a paged (hotwax-count-pages-1) or plain v1/v2 document written by an
   * earlier release. Its keys are listed in `retire` for removal after the new
   * root commits at the same key, so migration never duplicates a session. */
  async readLegacy(key, value) {
    if (value.format !== LEGACY) {
      const records = value.events || Object.values(value.items || {});
      const header = {...value}; delete header.events; delete header.items;
      return {header, records, legacy: true, retire: []};
    }
    const transaction = parse(await this.native.get(`${key}:transaction`));
    const owned = page => typeof page === 'string' && page.startsWith(`${key}:page:`);
    if (transaction) {
      if (transaction.format !== LEGACY || ![...transaction.created || [], ...transaction.retired || []].every(owned))
        throw new Error('Saved count recovery information is invalid. Contact support; data has been kept.');
      await this.deleteAll(value.generation === transaction.generation ? transaction.retired : transaction.created);
      await this.native.delete(`${key}:transaction`);
    }
    const names = Object.keys(value.pages || {}), pages = names.map(name => value.pages[name]);
    if (!pages.every(owned)) throw new Error('Saved count pages are invalid. Contact support; data has been kept.');
    if (value.kind === 'removed') {await this.deleteAll(pages); await this.native.delete(key); return undefined;}
    const chunks = [];
    for (let i = 0; i < pages.length; i += 4) chunks.push(...await Promise.all(pages.slice(i, i + 4).map(async page => {
      const data = await this.native.get(page);
      if (data == null) throw new Error('A saved count page is missing. Keep this device and contact support.');
      return parse(data);
    })));
    const ordered = value.kind === 'events'
      ? names.map((name, i) => [Number(name), chunks[i]]).sort((a, b) => a[0] - b[0]).flatMap(([, page]) => page)
      : chunks.flatMap(page => Object.values(page));
    return {header: value.header, records: ordered, legacy: true, retire: pages};
  }

  /**
   * Commit a document. Unchanged records must be the same objects as loaded or
   * last saved: that is how only changed values are rewritten.
   * @param {string} key
   * @param {{header:any, records:any[], keyOf:(record:any)=>any, move?:boolean, summary?:any, retire?:string[]}} doc
   *   `move` puts an updated record back in the root (items, identity pairs); events stay in place.
   */
  async save(key, {header, records, keyOf, move = false, summary, retire = []}) {
    // After an ambiguous failure, learn what actually committed before writing again.
    if (this.unsure.has(key)) await this.load(key);
    const previous = this.docs.get(key) || {chunks: [], root: [], hw: 0, retire: []};
    retire = [...new Set([...(previous.retire || []), ...retire])];
    const where = new Map(), before = new Map();
    previous.chunks.forEach((chunk, index) => chunk.data.forEach(record => {where.set(keyOf(record), index); before.set(keyOf(record), record);}));
    previous.root.forEach(record => {where.set(keyOf(record), -1); before.set(keyOf(record), record);});
    const next = previous.chunks.map(chunk => ({...chunk, data: [], changed: false}));
    const present = new Map(records.map(record => [keyOf(record), record]));
    let root = [];
    // Records keep their value unless they are new, or moved back to the root on update.
    previous.chunks.forEach((chunk, index) => chunk.data.forEach(old => {
      const current = present.get(keyOf(old));
      if (current === old) next[index].data.push(old);
      else {next[index].changed = true; if (current && !move) next[index].data.push(current);}
    }));
    for (const old of previous.root) {const current = present.get(keyOf(old)); if (current) root.push(current);}
    for (const record of records) {
      const id = keyOf(record), at = where.get(id);
      if (at === undefined || (move && at >= 0 && before.get(id) !== record)) root.push(record);
    }
    let hw = Math.max(previous.hw, ...next.map(chunk => chunk.n));
    const envelope = {format: FORMAT, stamp: '', header, ...(summary ? {summary} : {}), more: [], hw, data: []};
    // Seal the oldest root records once the root would pass the working limit.
    while (jsonBytes(envelope) + 64 * (next.length + 2) + total(root) > LIMIT) {
      let bytes = 0, count = 0;
      while (count < root.length - 1 && bytes + sized(root[count]) <= SEAL) bytes += sized(root[count++]);
      if (!count) throw new Error('A count record is too large to save on this device.');
      next.push({n: ++hw, slot: 'b', stamp: '', data: root.slice(0, count), changed: true});
      root = root.slice(count);
    }
    // A rewritten chunk can grow (events gain their product when matched): split it
    // in place so chunk order, and therefore chronology, is preserved.
    for (let i = 0; i < next.length; i++) {
      const chunk = next[i];
      if (!chunk.changed || total(chunk.data) <= LIMIT) continue;
      let bytes = 0, count = 0;
      while (count < chunk.data.length - 1 && bytes + sized(chunk.data[count]) <= SEAL) bytes += sized(chunk.data[count++]);
      next.splice(i + 1, 0, {n: ++hw, slot: 'b', stamp: '', data: chunk.data.slice(count), changed: true});
      chunk.data = chunk.data.slice(0, count);
    }
    const stamp = token(), writes = [], superseded = [];
    const kept = next.filter(chunk => chunk.data.length);
    for (const chunk of next) {
      if (!chunk.changed) continue;
      if (previous.chunks.some(old => old.n === chunk.n)) superseded.push(slotKey(key, chunk.n, chunk.slot));
      if (chunk.data.length) {
        chunk.slot = chunk.slot === 'a' ? 'b' : 'a'; chunk.stamp = stamp;
        if (total(chunk.data) > LIMIT) throw new Error('A count record is too large to save on this device.');
        writes.push([slotKey(key, chunk.n, chunk.slot), {format: FORMAT, of: key, stamp, data: chunk.data}]);
      }
    }
    const value = {...envelope, stamp, hw, more: kept.map(({n, slot, stamp: chunkStamp}) => ({n, slot, stamp: chunkStamp})), data: root,
      ...(retire.length ? {retire} : {})};
    try {
      for (const [slot, chunk] of writes) await this.native.set(slot, chunk);
      await this.native.set(key, value);
    } catch (error) {
      // A rejected write may still have been stored. Reconcile before retrying. Slots
      // written here are left alone: a late commit may still reference them, and the
      // next load sweeps them if not.
      let committed = false;
      try {committed = parse(await this.native.get(key))?.stamp === stamp;}
      catch {const failure = new Error('Storage acknowledgement was interrupted. Reopen this count to recover safely before scanning again.'); failure.recoveryRequired = true; throw failure;}
      if (!committed) {
        this.unsure.add(key);
        throw new Error(storageFull(error) ? 'This POS device has no free count storage. Finish and sync its other saved counts before adding more.'
          : error instanceof Error ? error.message : 'Unable to save this scan on the device.');
      }
    }
    // Committed: retire superseded values. Keys whose delete fails stay listed in
    // the root and are retried by the next commit or load.
    const left = await this.retireAll([...superseded, ...retire]);
    this.docs.set(key, {chunks: kept.map(({n, slot, stamp: chunkStamp, data}) => ({n, slot, stamp: chunkStamp, data})), root, hw,
      retire: left.filter(item => retire.includes(item) || !superseded.includes(item))});
  }

  /** Remove a document and its overflow. The root becomes a removal marker first,
   * so an interrupted removal is finished by the next load. */
  async removeDocument(key) {
    const root = parse(await this.native.get(key));
    if (root == null) return;
    if (root.format === FORMAT) {
      if (!root.removed) await this.native.set(key, {format: FORMAT, removed: true, hw: root.hw || 0, retire: root.retire || []});
      await this.load(key);
      return;
    }
    // Earlier formats: let the legacy reader finish any commit, then delete it all.
    const legacy = await this.readLegacy(key, root);
    if (legacy) {await this.native.set(key, {format: FORMAT, removed: true, hw: 0, retire: legacy.retire}); await this.load(key);}
  }
}
