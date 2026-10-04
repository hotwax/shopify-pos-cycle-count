// Keep the two logical documents, but only send changed pages over the POS bridge.
// A small transaction record makes interrupted copy-on-write commits recoverable.
// Shopify allows 100 storage entries per extension, so item pages grow with the
// document: one page up to 400 products, doubling as needed. Documents written
// before buckets were sized (no manifest.buckets) keep their original 16 pages.
const PAGE_EVENTS = 800, ITEMS_PER_BUCKET = 400, LEGACY_BUCKETS = 16, MAX_BUCKETS = 64, MAX_VALUE_BYTES = 900000;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const size = value => unescape(encodeURIComponent(JSON.stringify(value))).length;
const format = 'hotwax-count-pages-1';
const bucket = (key, buckets) => {let hash = 0; for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash % buckets;};
const isManifest = value => value?.format === format;

export class CountStorage {
  constructor(native) {this.native = native; this.cache = new Map(); this.clean = new Set();}
  async metadata(key) {
    const value=parse(await this.native.get(key));
    if(isManifest(value))return {generation:value.generation,kind:value.kind,header:value.header,summary:value.summary};
    return {generation:null,header:value};
  }
  async peek(key) {
    // Background readers must never recover, retire pages, or change this cache.
    const raw=await this.native.get(key),manifest=parse(raw);
    if(!isManifest(manifest))return manifest;
    if(manifest.kind==='removed')return undefined;
    if(!['events','items'].includes(manifest.kind))throw new Error('Unknown saved count format.');
    const chunks={},names=Object.keys(manifest.pages);
    for(let i=0;i<names.length;i+=4)await Promise.all(names.slice(i,i+4).map(async name=>{
      const page=manifest.pages[name];
      if(typeof page!=='string'||!page.startsWith(`${key}:page:`))throw new Error('Invalid saved count page.');
      const value=await this.native.get(page);
      if(typeof value!=='string')throw new Error('The local checkpoint is changing. Retry after counting pauses.');
      chunks[name]=parse(value);
    }));
    if(parse(await this.native.get(key))?.generation!==manifest.generation)throw new Error('The local checkpoint changed. Retry sync.');
    return {...manifest.header,...(manifest.kind==='events'?{events:names.sort((a,b)=>Number(a)-Number(b)).flatMap(name=>chunks[name])}:{items:Object.assign({},...names.map(name=>chunks[name]))})};
  }
  async recover(key) {
    const transaction = parse(await this.native.get(`${key}:transaction`));
    if (!transaction) {this.clean.add(key); return;}
    if (transaction.format !== format || !Array.isArray(transaction.created) || !Array.isArray(transaction.retired) ||
        [...transaction.created, ...transaction.retired].some(page => typeof page !== 'string' || !page.startsWith(`${key}:page:`)))
      throw new Error('Saved count recovery information is invalid. Contact support; data has been kept.');
    const current = parse(await this.native.get(key));
    const committed = isManifest(current) && current.generation === transaction.generation;
    for (const page of committed ? transaction.retired : transaction.created) await this.native.delete(page);
    await this.native.delete(`${key}:transaction`);
    this.clean.add(key);
  }
  async get(key) {
    if (!/:(scan-events|count-items)$/.test(key)) return this.native.get(key);
    await this.recover(key);
    const manifest = parse(await this.native.get(key));
    if (!isManifest(manifest)) {this.cache.delete(key); return manifest;}
    if (manifest.kind === 'removed') {
      const pages = Object.values(manifest.pages || {});
      if (pages.some(page => typeof page !== 'string' || !page.startsWith(`${key}:page:`))) throw new Error('Invalid cleanup page reference; data kept.');
      for (const page of pages) await this.native.delete(page);
      await this.native.delete(key); this.cache.delete(key); return undefined;
    }
    if (!['events', 'items'].includes(manifest.kind) || !manifest.pages || typeof manifest.pages !== 'object')
      throw new Error('Saved count pages are invalid. Contact support; data has been kept.');
    const chunks = {};
    // Four outstanding reads keep reload responsive without flooding the native bridge.
    const names = Object.keys(manifest.pages);
    for (let i = 0; i < names.length; i += 4) await Promise.all(names.slice(i, i + 4).map(async name => {
      const pageKey = manifest.pages[name];
      if (typeof pageKey !== 'string' || !pageKey.startsWith(`${key}:page:`)) throw new Error('Invalid saved count page reference.');
      const value = await this.native.get(pageKey);
      if (typeof value !== 'string') throw new Error('A saved count page is missing. Keep this device and contact support.');
      chunks[name] = value;
    }));
    this.cache.set(key, {manifest, chunks});
    const doc = {...manifest.header};
    if (manifest.kind === 'events') doc.events = names.sort((a,b)=>Number(a)-Number(b)).flatMap(name => parse(chunks[name]));
    else doc.items = Object.assign({}, ...names.map(name => parse(chunks[name])));
    return doc;
  }
  documentBytes(key) {return Object.values(this.cache.get(key)?.bytes || {}).reduce((sum, value) => sum + value, 0);}
  async set(key, value) {return this.native.set(key, value);}
  async delete(key) {return this.native.delete(key);}
  async removeDocument(key) {
    if (!/:(scan-events|count-items)$/.test(key)) throw new Error('Invalid count document.');
    await this.recover(key);
    const manifest = parse(await this.native.get(key));
    const retired = isManifest(manifest) ? Object.values(manifest.pages) : [];
    if (retired.some(page => typeof page !== 'string' || !page.startsWith(`${key}:page:`))) throw new Error('Invalid count page reference; data kept.');
    // Reuse the existing manifest slot so cleanup still works at the 100-entry limit.
    // Keeping this tombstone until pages are removed makes interruption recoverable.
    if (manifest == null) return;
    await this.native.set(key, JSON.stringify({format, kind: 'removed', pages: Object.fromEntries(retired.map((page, index) => [index, page]))}));
    await this.get(key);
  }
  async writeDocument(key, doc) {
    const kind = key.endsWith(':scan-events') ? 'events' : 'items';
    if (!this.cache.has(key)) await this.get(key);
    // A prior cleanup can be retried without changing the acknowledged document.
    // After a clean commit this needs no bridge read.
    if (!this.clean.has(key)) await this.recover(key);
    const previous = this.cache.get(key), header = {...doc}; delete header[kind];
    const summary=kind==='events'?{pendingCount:doc.events.filter(event=>event.aggApplied===0).length,eventCount:doc.events.length}:undefined;
    const layout = buckets => {
      const chunks = {}, references = {}, bytes = {};
      if (kind === 'events') {
        for (let i = 0; i < doc.events.length; i += PAGE_EVENTS) {
          const name = String(i / PAGE_EVENTS), values = doc.events.slice(i, i + PAGE_EVENTS);
          references[name] = values;
          chunks[name] = previous?.references?.[name]?.length === values.length && values.every((event, index) => previous.references[name][index] === event)
            ? previous.chunks[name] : JSON.stringify(values);
        }
      } else {
        const groups = {}, sameLayout = previous?.manifest?.buckets === buckets;
        for (const [id, item] of Object.entries(doc.items)) (groups[bucket(id, buckets)] ||= {})[id] = item;
        for (const [name, items] of Object.entries(groups)) {
          references[name] = items;
          const old = sameLayout ? previous?.references?.[name] : undefined;
          chunks[name] = old && Object.keys(old).length === Object.keys(items).length && Object.entries(items).every(([id, item]) => old[id] === item)
            ? previous.chunks[name] : JSON.stringify(items);
        }
      }
      // Unchanged pages were sized when written; only measure new content.
      for (const [name, value] of Object.entries(chunks)) bytes[name] = previous?.chunks[name] === value ? previous?.bytes?.[name] : size(value);
      return {chunks, references, bytes, buckets};
    };
    let buckets;
    if (kind === 'items') {
      const count = Object.keys(doc.items).length;
      buckets = previous?.manifest?.kind === 'items' ? previous.manifest.buckets || LEGACY_BUCKETS : 1;
      while (buckets < MAX_BUCKETS && buckets * ITEMS_PER_BUCKET < count) buckets *= 2;
    }
    let pagesLayout = layout(buckets);
    while (kind === 'items' && buckets < MAX_BUCKETS && Object.values(pagesLayout.bytes).some(value => value > MAX_VALUE_BYTES))
      pagesLayout = layout(buckets *= 2);
    const {chunks, references, bytes} = pagesLayout;
    if (Object.values(bytes).some(value => value > MAX_VALUE_BYTES)) throw new Error('A count page is full. Saved scans are safe; sync and finish this count.');
    const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pages = {}, writes = [];
    for (const [name, value] of Object.entries(chunks)) {
      if (previous?.chunks[name] === value && previous.manifest?.pages?.[name]) pages[name] = previous.manifest.pages[name];
      else {const page = `${key}:page:${generation}:${name}`; pages[name] = page; writes.push([page, value]);}
    }
    const kept = new Set(Object.values(pages));
    const retired = Object.values(previous?.manifest?.pages || {}).filter(page => !kept.has(page));
    const transaction = {format, generation, created: writes.map(([key])=>key), retired};
    const manifest = {format, generation, kind, header, pages, ...(summary?{summary}:{}), ...(buckets?{buckets}:{})};
    // A manifest-only change creates and retires no page, so it needs no transaction record.
    const journaled = writes.length > 0 || retired.length > 0;
    let committed = false;
    try {
      if (journaled) {this.clean.delete(key); await this.native.set(`${key}:transaction`, JSON.stringify(transaction));}
      for (const [page, value] of writes) await this.native.set(page, value);
      await this.native.set(key, JSON.stringify(manifest));
      committed = true;
    } catch (error) {
      // A timed-out write may have committed. Reconcile before deleting or retrying.
      try {
        const actual = parse(await this.native.get(key));
        committed = isManifest(actual) && actual.generation === generation;
        if (!committed) await this.recover(key);
      } catch {
        const failure = new Error('Storage acknowledgement was interrupted. Reopen this count to recover safely before scanning again.');
        failure.recoveryRequired = true; throw failure;
      }
      if (!committed) throw new Error(error?.code === 'RecordsCount' ? 'This POS device has no free count storage. Finish and sync its other saved counts before adding more.' : error instanceof Error ? error.message : 'Unable to save this scan on the device.');
    }
    this.cache.set(key, {manifest, chunks, references, bytes});
    if (!journaled) return;
    // The manifest is durable, so this commit's own transaction is known to be
    // committed: retire its pages directly. Cleanup failure must not turn success
    // into a duplicate scan; the next write or reopen finishes it.
    try {
      for (const page of retired) await this.native.delete(page);
      await this.native.delete(`${key}:transaction`);
      this.clean.add(key);
    } catch {}
  }
}
