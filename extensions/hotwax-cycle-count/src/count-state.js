// A durable scan journal plus an item checkpoint. JSON strings cross the native
// bridge as one value; never acknowledge a scan before Storage API accepts it.
export const KV_LIMIT = 900000;
const copy = value => JSON.parse(JSON.stringify(value));
export const jsonBytes = value => unescape(encodeURIComponent(JSON.stringify(value))).length;
export function decodeDocument(value) {
  if (value == null) return undefined;
  const doc = typeof value === 'string' ? JSON.parse(value) : value;
  if (!doc || ![1, 2].includes(doc.version) || typeof doc.sessionId !== 'string')
    throw new Error('Saved count data cannot be read. Keep this device and contact support.');
  return doc;
}
const message = error => error instanceof Error ? error.message : 'Product could not be matched. Retry when connected.';

export class CountState {
  constructor(storage, owner, request, receive = () => {}, audit = {}, assertCanCount = () => {}) {
    this.storage = storage; this.owner = owner; this.request = request; this.receive = receive;
    this.tail = Promise.resolve(); this.active = true; this.failures = new Map(); this.enriching = new Map();
    // POS display data waiting for the next journal commit, keyed by event ID.
    this.displays = new Map(); this.displayVersion = 0; this.memo = {};
    this.eventKey = `hotwax-count:${owner}:scan-events`;
    this.itemKey = `hotwax-count:${owner}:count-items`;
    this.audit = audit;
    this.assertCanCount = assertCanCount;
  }
  serial(fn) {const task = this.tail.catch(() => {}).then(fn); this.tail = task; return task;}
  async write(key, value) {
    if (this.storage.writeDocument) {
      try {await this.storage.writeDocument(key, value); return;}
      catch (error) {if (error.recoveryRequired) this.active = false; throw error;}
    }
    const serialized = JSON.stringify(value);
    // Native storage serializes strings too; account for escaping in that value.
    if (jsonBytes(serialized) > KV_LIMIT)
      throw new Error('This device’s count storage is full. Your saved scans are safe. Sync and finish this count before scanning more.');
    await this.storage.set(key, serialized);
  }
  async open(count) {
    return this.serial(async () => {
      // Existing installations keep their original two documents in place. Moving
      // a full journal would temporarily need twice the native key quota.
      const legacy = decodeDocument(await this.storage.get(`hotwax-count:${this.owner}:count-items`));
      const legacyEvents = decodeDocument(await this.storage.get(`hotwax-count:${this.owner}:scan-events`));
      if (legacy?.sessionId !== count.sessionId && legacyEvents?.sessionId !== count.sessionId) {
        const prefix = `hotwax-count:${this.owner}:session:${encodeURIComponent(count.sessionId)}`;
        this.eventKey = `${prefix}:scan-events`; this.itemKey = `${prefix}:count-items`;
      }
      const catalogKey = `hotwax-count:${this.owner}:sessions`;
      const catalog = await this.storage.get(catalogKey) || {sessions: []};
      const entry = {sessionId:count.sessionId,workEffortId:count.workEffortId,name:count.name,
        itemKey:this.itemKey,eventKey:this.eventKey,statusId:count.statusId,updatedAt:Date.now()};
      await this.storage.set(catalogKey, {...catalog,active:count.sessionId,
        sessions:[entry,...catalog.sessions.filter(s=>s.sessionId !== count.sessionId)]});
      const saved = await Promise.all([this.storage.get(this.eventKey), this.storage.get(this.itemKey)]);
      const [events, items] = saved.map(decodeDocument);
      if (events && (!Array.isArray(events.events) || !Number.isSafeInteger(events.nextId))) throw new Error('The saved scan journal is invalid. Contact support before continuing.');
      if (items && (!items.items || Array.isArray(items.items))) throw new Error('The saved count checkpoint is invalid. Contact support before continuing.');
      if (events && events.sessionId !== count.sessionId && events.events.some(e => e.aggApplied === 0)) throw new Error('Resolve the previous count’s unmatched scans before opening another count.');
      if (items && items.sessionId !== count.sessionId && Object.values(items.items).some(i => i.revision !== i.syncedRevision)) throw new Error('Sync the previous count before opening another count.');
      this.count = count;
      this.events = events?.sessionId === count.sessionId ? events : {version: 2, sessionId: count.sessionId, nextId: 1, events: []};
      this.items = items?.sessionId === count.sessionId ? items : {version: 2, sessionId: count.sessionId, items: {}, applied: {}};
      // Version 1 processed strictly in order and used a per-product watermark.
      if (this.items.version === 1) {
        this.items.applied = {};
        for (const event of this.events.events.filter(e => e.aggApplied === 0)) {
          const item = Object.values(this.items.items).find(i => i.productId === event.productId || i.codes?.includes(event.scannedValue));
          if (item?.lastEventId >= event.id) this.items.applied[event.id] = true;
        }
      }
      this.events.version = 2; this.items.version = 2;
      this.items.applied ||= {};
      // Background never edits these documents. Apply its acknowledged revisions
      // before refreshing server quantities; newer local scans remain dirty.
      const receipts = await this.storage.get(`${this.itemKey}:receipts`);
      for (const [id, receipt] of Object.entries(receipts?.items || {})) {
        const item=this.items.items[id];
        if(item && Number.isSafeInteger(receipt.revision) && receipt.revision>item.syncedRevision && receipt.revision<=item.revision &&
          Number.isSafeInteger(receipt.quantity) && receipt.quantity>=0 && (receipt.revision!==item.revision || receipt.quantity===item.quantity))
          Object.assign(item,{syncedRevision:receipt.revision,serverQuantity:receipt.quantity,lastSyncedAt:receipt.at});
      }
      this.items.count = {...count, items: [], audit:this.audit};
      for (const item of count.items) {
        const old = this.items.items[item.productId];
        if (!old) this.items.items[item.productId] = {...item,
          uuid: `${count.sessionId}:${item.productId}`, inventoryCountImportId: count.sessionId,
          productIdentifier: item.sku, codes: [...new Set((item.codes || []).filter(Boolean))], status: 'active', createdAt: Date.now(),
          lastScanAt: 0, lastUpdatedAt: item.lastUpdatedAt || 0, lastSyncedAt: null, lastSyncedBatchId: null,
          revision: 0, syncedRevision: 0, serverQuantity: item.quantity, lastEventId: 0, lastCorrectionId: 0, aggApplied: item.quantity};
        else if (old.revision === old.syncedRevision) Object.assign(old, item, {aggApplied: item.quantity, serverQuantity: item.quantity});
      }
      if (!count.canViewOnHand) for (const item of Object.values(this.items.items)) {
        delete item.onHand; delete item.delta; delete item.systemQuantityOnHand;
      }
      await this.write(this.itemKey, this.items);
      if(receipts)await this.storage.delete(`${this.itemKey}:receipts`);
      await this.write(this.eventKey, this.events);
      this.reindex(); this.notify();
    });
  }
  reindex() {
    this.codes = new Map();
    for (const item of Object.values(this.items.items)) for (const code of item.codes || []) this.codes.set(code.toLowerCase(), item.productId);
  }
  /** Journal-derived values, recomputed only when the journal array changes. */
  journalIndex() {
    if (this.memo.journal?.events !== this.events.events) {
      const pending = [], negated = new Set();
      for (const event of this.events.events) {
        if (event.aggApplied === 0) pending.push(event);
        if (event.negatedScanEventId) negated.add(event.negatedScanEventId);
      }
      this.memo.journal = {events: this.events.events, pending, negated};
    }
    return this.memo.journal;
  }
  /** Display data for an event, including data not yet saved with a commit. */
  display(event) {
    if (event.shopifyProduct || event.manuallyMatched || event.aggApplied === -1) return event.shopifyProduct;
    return this.displays.get(event.id);
  }
  /** Copy waiting display data into a journal copy before it is written. */
  applyDisplays(events) {
    const merged = [];
    for (const [id, display] of this.displays) {
      let index = events.events.length - 1;
      while (index >= 0 && events.events[index].id !== id) index--;
      const event = events.events[index];
      if (!event || event.shopifyProduct || event.manuallyMatched || event.aggApplied === -1) {this.displays.delete(id); continue;}
      events.events[index] = {...event, shopifyProduct: display}; merged.push(id);
    }
    return merged;
  }
  async commitEvents(events) {
    const merged = this.applyDisplays(events);
    await this.write(this.eventKey, events); this.events = events;
    for (const id of merged) this.displays.delete(id);
  }
  notify() {
    // Journal appends do not rebuild the product array or search index. Item
    // commits replace the map and preserve unchanged row object identities.
    if (this.notifiedItems !== this.items.items) {
      this.notifiedItems = this.items.items;
      this.itemList = Object.values(this.items.items);
      this.itemUnits = this.itemList.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
      this.dirtyCount = this.itemList.filter(i => i.revision !== i.syncedRevision).length;
    }
    const items = this.itemList;
    const {pending} = this.journalIndex();
    const undo = this.lastUndoable();
    const lastEvent = this.events.events[this.events.events.length-1];
    const lastProduct = lastEvent && {...this.items.items[lastEvent.productId],...this.display(lastEvent)};
    this.receive({...this.count, items, units: this.itemUnits}, {
      events: this.events.events.length, pending: pending.length,
      dirty: this.dirtyCount,
      unmatched: pending.filter(e=>this.failures.has(e.id)).length,
      issues: pending.map(e => ({id: e.id, code: e.scannedValue, message: this.failures.get(e.id)?.message || 'Waiting for product matching'})),
      undoEventId: undo?.id,
      lastScan: lastEvent ? {id:lastEvent.id,code:lastEvent.scannedValue,source:lastEvent.source,
        matched:lastEvent.aggApplied===1,title:lastProduct?.title,sku:lastProduct?.sku,imageUrl:lastProduct?.imageUrl,quantity:lastProduct?.quantity,
        matchingFailed:this.failures.has(lastEvent.id),
        productId:lastEvent.productId,at:lastEvent.createdAt,discarded:lastEvent.aggApplied===-1} : null,
      eventBytes: this.storage.documentBytes?.(this.eventKey), itemBytes: this.storage.documentBytes?.(this.itemKey),
      worker: typeof globalThis.Worker, indexedDB: typeof globalThis.indexedDB,
    });
  }
  append(job) {
    // Reject at receipt and again after queued work, before the journal commit.
    try {this.assertCanCount();} catch(error) {return Promise.reject(error);}
    return this.serial(async () => {
      if (!this.active || !this.count?.editable) throw new Error('This count is no longer active.');
      this.assertCanCount();
      const code = String(job.code || '').trim();
      if (!code || code.length > 255 || /[\x00-\x1f]/.test(code)) throw new Error('Enter a valid barcode or SKU.');
      if (job.source === 'correction' && (!Number.isSafeInteger(job.quantity) || job.quantity < 0 || job.quantity > 1000000)) throw new Error('Enter a whole quantity between 0 and 1,000,000.');
      const events = {...this.events, events: [...this.events.events]};
      const event = {id: events.nextId++, inventoryCountImportId: this.count.sessionId,
        scannedValue: code, productId: job.productId || null, locationSeqId: null,
        negatedScanEventId: job.negatedScanEventId || null,
        quantity: job.source === 'correction' ? job.quantity : job.source === 'undo' ? -1 : (job.quantity ?? 1),
        ...(job.product?{product:job.product}:{}),
        mode: job.source === 'correction' ? 'set' : 'add', source: job.source,
        createdAt: Date.now(), aggApplied: 0, staffId:this.audit.staffId,deviceId:this.audit.deviceId};
      if (job.source === 'undo') {
        const original = events.events.find(e => e.id === event.negatedScanEventId);
        if (!original || original.aggApplied !== 1 || original.quantity <= 0 || original.mode !== 'add' ||
          events.events.some(e => e.negatedScanEventId === original.id) ||
          (this.items.items[original.productId]?.lastCorrectionId || 0) >= original.id)
          throw new Error('This scan can no longer be undone. Correct the product quantity instead.');
        event.productId = original.productId; event.scannedValue = original.scannedValue; event.quantity=-original.quantity;
      }
      if(!Number.isSafeInteger(event.quantity)||Math.abs(event.quantity)>1000000||(event.mode==='add'&&event.source!=='undo'&&event.quantity<=0))throw new Error('Enter a whole quantity from 1 to 1,000,000.');
      events.events.push(event);
      await this.commitEvents(events); this.notify();
      // Enrich every newly saved scan immediately, even while an older OMS batch is in flight.
      this.enrichEvent(event).catch(()=>{});
      return event.id;
    });
  }
  enrichEvent(event) {
    if (!this.request.enrichScan || event.shopifyProduct || event.product || this.displays.has(event.id) || ['undo','correction'].includes(event.source)) return Promise.resolve();
    if (this.enriching.has(event.id)) return this.enriching.get(event.id);
    // Display data shows immediately and is saved with the next journal commit
    // (normally this scan's own aggregation) instead of a separate storage write.
    const task=Promise.resolve().then(()=>this.request.enrichScan(event.scannedValue)).then(display=>{
      if (!display || !this.active) return;
      this.displays.set(event.id,display);this.displayVersion++;this.notify();
    }).catch(()=>{}).finally(()=>this.enriching.delete(event.id));
    this.enriching.set(event.id,task);return task;
  }
  aggregate(retry = false) {
    if (retry) this.failures.clear();
    if (this.aggregating) return this.aggregating;
    this.aggregating = (async () => {
      while (this.active) {
        await this.tail.catch(() => {});
        const pending = this.events.events.filter(e => e.aggApplied === 0 && (this.failures.get(e.id)?.retryAt || 0) <= Date.now()).slice(0, 25);
        if (!pending.length) break;
        await Promise.all(pending.map(event=>this.enrichEvent(event)));
        if (!this.active) break;
        const resolved = [], products = new Map(), batchErrors = new Map();
        const lookupBatch=this.request.lookupIdentityBatch||this.request.lookupBatch;
        if (lookupBatch) {
          const codes = [...new Set(pending.filter(event => !event.product && !this.items.items[event.productId || this.codes.get(event.scannedValue.toLowerCase())]).map(event => event.scannedValue))];
          // Native search can legitimately miss a POS product. Keep the proven
          // OMS display fallback instead of reducing a matched row to a barcode.
          const enrichedCodes=new Set(this.events.events.filter(e=>this.display(e)).map(e=>e.scannedValue));
          const batches=this.request.lookupIdentityBatch&&this.request.lookupBatch?
            [[codes.filter(code=>enrichedCodes.has(code)),this.request.lookupIdentityBatch],[codes.filter(code=>!enrichedCodes.has(code)),this.request.lookupBatch]]:[[codes,lookupBatch]];
          await Promise.all(batches.map(async([batch,lookup])=>{if (!batch.length)return;try {
            const result = await lookup(batch);
            for (const product of result.matches || []) products.set(product.code, product);
            for (const error of result.errors || []) batchErrors.set(error.code, error.message);
            for (const code of batch) if (!products.has(code) && !batchErrors.has(code)) batchErrors.set(code, 'Product matching was incomplete. Retry when connected.');
          } catch (error) {for (const code of batch) batchErrors.set(code, message(error));}}));
        }
        for (const event of pending) {
          if (!this.active) return;
          const cached = this.items.items[event.productId || this.codes.get(event.scannedValue.toLowerCase())] || event.product || products.get(event.scannedValue);
          try {
            if (!cached && batchErrors.has(event.scannedValue)) throw new Error(batchErrors.get(event.scannedValue));
            const product = cached || await this.request('lookup', {code: event.scannedValue});
            if (!product?.productId || typeof product.productId!=='string') throw new Error('HotWax has not identified this product yet. Retry matching.');
            products.set(event.scannedValue, product); resolved.push({event, product}); this.failures.delete(event.id);
          } catch (error) {
            const prior = this.failures.get(event.id);
            this.failures.set(event.id, {message: message(error), attempts: (prior?.attempts || 0) + 1,
              retryAt: Date.now() + Math.min(60000, 5000 * 2 ** (prior?.attempts || 0))});
          }
        }
        if (!this.active) break;
        if (resolved.length) await this.serial(async () => {
          const items = {...this.items, items: {...this.items.items}, applied: {...this.items.applied}}, events = {...this.events, events: [...this.events.events]};
          const merged = this.applyDisplays(events), rejected = [];
          // Keep only acknowledgements which the journal has not committed yet.
          items.applied = Object.fromEntries(Object.entries(items.applied).filter(([id]) => events.events.some(e => e.id === Number(id) && e.aggApplied === 0)));
          for (const {event, product} of resolved) {
            const index = events.events.findIndex(e => e.id === event.id);
            const applied = index < 0 ? null : {...events.events[index]};
            if (applied) events.events[index] = applied;
            if (!applied || applied.aggApplied !== 0) continue;
            if (!items.applied[event.id]) {
              const old = items.items[product.productId];
              // A late match before a later explicit correction must not change that correction.
              const superseded = (old?.lastCorrectionId || 0) > event.id;
              const quantity = superseded ? old.quantity : event.mode === 'set' ? event.quantity : (old?.quantity || 0) + event.quantity;
              // Keep only this scan pending with a reason; the rest of the batch still commits.
              if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) {rejected.push(event.id); continue;}
              const item = {...product, ...old, ...applied.shopifyProduct, productId: product.productId,
                isRequested: old?.isRequested ?? this.count.countType !== 'DIRECTED_COUNT',
                uuid: `${this.count.sessionId}:${product.productId}`, inventoryCountImportId: this.count.sessionId,
                productIdentifier: event.scannedValue, codes: [...new Set([...(old?.codes || []), event.scannedValue])],
                quantity, aggApplied: quantity, status: 'active', createdAt: old?.createdAt || event.createdAt,
                lastScanAt: Math.max(old?.lastScanAt || 0, event.createdAt), lastUpdatedAt: Date.now(),
                lastSyncedAt: old?.lastSyncedAt || null, lastSyncedBatchId: old?.lastSyncedBatchId || null,
                // Revisions count commits, not event IDs: late matches must remain dirty.
                revision: (old?.revision || 0) + 1, syncedRevision: old?.syncedRevision || 0, serverQuantity: old?.serverQuantity ?? null,
                lastEventId: Math.max(old?.lastEventId || 0, event.id),
                lastCorrectionId: event.mode === 'set' ? Math.max(old?.lastCorrectionId || 0, event.id) : old?.lastCorrectionId || 0};
              if (!this.count.canViewOnHand) {delete item.onHand;delete item.delta;delete item.systemQuantityOnHand;}
              else if (item.onHand != null) item.delta = quantity - item.onHand;
              items.items[product.productId] = item; items.applied[event.id] = true;
            }
            applied.productId = product.productId; applied.aggApplied = 1;
          }
          // This ordering is the crash boundary tested by interrupted-write tests.
          await this.write(this.itemKey, items); this.items = items;
          await this.write(this.eventKey, events); this.events = events;
          for (const id of merged) this.displays.delete(id);
          for (const id of rejected) this.failures.set(id, {message: 'This scan would take the product total outside 0 to 1,000,000. Remove it or correct the quantity.',
            attempts: (this.failures.get(id)?.attempts || 0) + 1, retryAt: Date.now() + 60000});
          this.reindex(); this.notify();
        });
        else this.notify();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    })().finally(() => {this.aggregating = undefined;});
    return this.aggregating;
  }
  async retryMatching(eventId) {
    if (!this.active || !this.count?.editable) throw new Error('This count is no longer active.');
    const selected = this.events.events.filter(event => eventId == null ? event.aggApplied === 0 : event.id === eventId);
    if (eventId != null && !selected.length) throw new Error('This scan is no longer available.');
    const ids = new Set(selected.map(event => event.id));
    await this.aggregate(true);
    if (!this.active) throw new Error('This count is no longer active. Your saved scans are retained.');
    const results = this.events.events.filter(event => ids.has(event.id));
    const remaining = results.filter(event => event.aggApplied === 0);
    const product = eventId != null && this.items.items[results[0]?.productId];
    return {
      matched: results.filter(event => event.aggApplied === 1).length,
      remaining: remaining.length,
      reason: remaining.length ? this.failures.get(remaining[0].id)?.message || 'Product matching is still pending. Try again when connected.' : '',
      product: product ? {title:product.title || product.sku || product.productId,quantity:product.quantity} : null,
    };
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      await this.aggregate();
      while (this.active) {
        await this.tail.catch(() => {});
        const batch = Object.values(this.items.items).filter(i => i.revision !== i.syncedRevision).slice(0, 25).map(copy);
        if (!batch.length) break;
        const result = await this.request('saveBatch', {sessionId: this.count.sessionId,
          items: batch.map(i => ({productId: i.productId, code: i.productIdentifier, quantity: i.quantity, expectedQuantity: i.serverQuantity ?? null}))});
        if (!this.active) break;
        if (!Array.isArray(result.items) || batch.some(item => !result.items.some(saved => saved.productId === item.productId && saved.quantity === item.quantity)))
          throw new Error('HotWax did not confirm every count item. Saved scans are retained; retry sync.');
        await this.serial(async () => {
          const items = {...this.items, items: {...this.items.items}};
          for (const snapshot of batch) {
            const latest = {...items.items[snapshot.productId]}, saved = result.items.find(i => i.productId === snapshot.productId);
            items.items[snapshot.productId] = latest;
            latest.syncedRevision = snapshot.revision; latest.serverQuantity = snapshot.quantity; latest.lastSyncedAt = Date.now();
            latest.lastSyncedBatchId = `${this.count.sessionId}:${snapshot.productId}:${snapshot.revision}`;
            if (result.canViewOnHand && saved.onHand != null) {latest.onHand = saved.onHand; latest.delta = latest.quantity - saved.onHand;}
          }
          await this.write(this.itemKey, items); this.items = items; this.notify();
        });
      }
    })().finally(() => {this.syncing = undefined;});
    return this.syncing;
  }
  discardUnmatched(id) {
    return this.serial(async () => {
      const event = this.events.events.find(e => e.aggApplied === 0 && (id == null || e.id === id));
      if (!event || this.items.applied[event.id]) throw new Error('This scan must be reconciled, not removed.');
      const events = {...this.events, events: this.events.events.map(e => e.id === event.id ? {...e, aggApplied: -1} : e)};
      await this.commitEvents(events); this.failures.delete(event.id); this.notify();
    });
  }
  reconcile(productId, serverQuantity, useServer = false) {
    return this.serial(async () => {
      if (!this.active || !this.count.editable) throw new Error('Reopen this count before resolving a quantity.');
      if (serverQuantity !== null && (!Number.isSafeInteger(serverQuantity) || serverQuantity < 0)) throw new Error('HotWax returned an invalid quantity.');
      if (this.events.events.some(e => e.aggApplied === 0)) throw new Error('Resolve pending scans before comparing quantities.');
      const old = this.items.items[productId];
      if (!old) throw new Error('Count product was not found.');
      const item = {...old, serverQuantity};
      if (useServer) {
        item.quantity = serverQuantity; item.aggApplied = item.quantity;
        item.revision++; item.syncedRevision = item.revision;
        // A reconciliation supersedes earlier scan undo/correction history.
        item.lastCorrectionId = this.events.nextId - 1;
        if (this.count.canViewOnHand && item.onHand != null) item.delta = item.quantity - item.onHand;
      }
      const items = {...this.items, items: {...this.items.items, [productId]: item}};
      await this.write(this.itemKey, items); this.items = items; this.notify();
    });
  }
  lastUndoable() {
    const memo = this.memo.undo;
    if (memo?.events === this.events.events && memo.items === this.items.items) return memo.event;
    const {negated} = this.journalIndex();
    let found;
    for (let i = this.events.events.length - 1; i >= 0; i--) {
      const event = this.events.events[i];
      if (event.aggApplied === 1 && event.mode === 'add' && event.quantity > 0 && !negated.has(event.id) &&
          (this.items.items[event.productId]?.lastCorrectionId || 0) < event.id) {found = event; break;}
    }
    this.memo.undo = {events: this.events.events, items: this.items.items, event: found};
    return found;
  }
  historyPage(search='',page=0,filter='all') {
    const {negated}=this.journalIndex();
    const query=search.trim().toLowerCase();
    // Filtering and sorting run once per journal, item map, display or query change;
    // re-renders and page turns reuse the ordered list.
    const memo=this.memo.history;
    let events=memo?.list;
    if(!(memo&&memo.events===this.events.events&&memo.items===this.items.items&&memo.displayVersion===this.displayVersion&&memo.query===query&&memo.filter===filter)){
      // Event chronology is independent of product order and enrichment updates.
      events=this.events.events.filter(e=>(filter!=='unmatched'||e.aggApplied===0)&&(!query||`${e.scannedValue} ${this.display(e)?.title||this.items.items[e.productId]?.title||''}`.toLowerCase().includes(query)))
        .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)||b.id-a.id);
      this.memo.history={events:this.events.events,items:this.items.items,displayVersion:this.displayVersion,query,filter,list:events};
    }
    const pages=Math.max(1,Math.ceil(events.length/40)),current=Math.min(page,pages-1);
    return {total:events.length,pages,page:current,items:events.slice(current*40,(current+1)*40).map(e=>({...e,
      title:this.display(e)?.title||this.items.items[e.productId]?.title||e.scannedValue,
      imageUrl:this.display(e)?.imageUrl||this.items.items[e.productId]?.imageUrl,
      matchingFailed:this.failures.has(e.id),
      canUndo:e.aggApplied===1&&e.mode==='add'&&e.quantity>0&&!negated.has(e.id)&&(this.items.items[e.productId]?.lastCorrectionId||0)<e.id}))};
  }
  async addBatch(entries,operationId) {
    this.assertCanCount();
    await this.serial(async()=>{
      if(!this.active||!this.count.editable)throw new Error('Reopen this session before adding quantities.');
      this.assertCanCount();
      if(!entries.length||entries.length>2000)throw new Error('Choose products to count.');
      // One journal commit makes the hand-count batch recoverable and retryable.
      if(this.events.events.some(e=>e.batchId===operationId))return;
      const events={...this.events,events:[...this.events.events]};
      for(const entry of entries){
        if(!entry.product?.productId||!Number.isSafeInteger(entry.quantity)||entry.quantity<=0||entry.quantity>1000000)throw new Error('Enter a whole quantity for every selected product.');
        if(this.count.countType==='DIRECTED_COUNT'&&!this.items.items[entry.product.productId]?.isRequested)throw new Error('Hand-count only products requested in this directed session.');
        events.events.push({id:events.nextId++,inventoryCountImportId:this.count.sessionId,scannedValue:entry.product.sku||entry.product.productId,productId:entry.product.productId,product:entry.product,
          quantity:entry.quantity,mode:'add',source:'hand-count',batchId:operationId,createdAt:Date.now(),aggApplied:0,staffId:this.audit.staffId,deviceId:this.audit.deviceId});
      }
      await this.commitEvents(events);this.notify();
    });
    await this.aggregate();
  }
  async matchUnmatched(id,product) {
    if(this.aggregating)await this.aggregating;
    await this.serial(async()=>{
      if(!this.active||!this.count.editable||!product?.productId)throw new Error('Reopen the session and choose an OMS product.');
      const event=this.events.events.find(e=>e.id===id&&e.aggApplied===0);
      if(!event||this.items.applied[id])throw new Error('This scan has already changed. Refresh the pending scans.');
      const events={...this.events,events:this.events.events.map(e=>e.aggApplied===0&&e.scannedValue===event.scannedValue&&!this.items.applied[e.id]?{...e,productId:product.productId,product,shopifyProduct:undefined,manuallyMatched:true}:e)};
      await this.commitEvents(events);this.failures.clear();this.notify();
    });
    await this.aggregate(true);
  }
  async undoScan(id,all=false) {
    this.assertCanCount();
    await this.aggregate();
    await this.serial(async()=>{
      if(!this.active||!this.count.editable)throw new Error('Reopen this session before removing scans.');
      this.assertCanCount();
      const selected=this.events.events.find(e=>e.id===id);
      if(!selected)throw new Error('This scan is no longer available.');
      const {negated}=this.journalIndex();
      const targets=this.events.events.filter(e=>(all?e.productId===selected.productId:e.id===id)&&e.aggApplied===1&&e.mode==='add'&&e.quantity>0&&!negated.has(e.id)&&(this.items.items[e.productId]?.lastCorrectionId||0)<e.id);
      if(!targets.length)throw new Error('These scans have already been reversed or replaced by a quantity correction.');
      const events={...this.events,events:[...this.events.events]};
      for(const original of targets)events.events.push({id:events.nextId++,inventoryCountImportId:this.count.sessionId,scannedValue:original.scannedValue,productId:original.productId,negatedScanEventId:original.id,quantity:-original.quantity,mode:'add',source:'undo',createdAt:Date.now(),aggApplied:0,staffId:this.audit.staffId,deviceId:this.audit.deviceId});
      await this.commitEvents(events);this.notify();
    });
    await this.aggregate();
  }
  async undoLast() {
    const event = this.lastUndoable();
    if (!event) throw new Error('There is no recent scan to undo.');
    await this.append({code: event.scannedValue, productId: event.productId, source: 'undo', negatedScanEventId: event.id});
    await this.aggregate();
  }
  async prepareSubmission() {
    await this.tail;
    await this.aggregate(true);
    await this.sync();
    if (this.events.events.some(e => e.aggApplied === 0)) throw new Error('Resolve or remove unmatched scans before sending this count for approval.');
    if (Object.values(this.items.items).some(i => i.revision !== i.syncedRevision)) throw new Error('Wait for all quantities to sync before sending this count for approval.');
  }
}
