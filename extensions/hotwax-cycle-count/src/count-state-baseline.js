// Two JSON documents. Events are durable before aggregation; item watermarks
// make replay safe when POS closes between the item write and event acknowledgement.
export const KV_LIMIT = 900000;
const clone = (value) => JSON.parse(JSON.stringify(value));
export function jsonBytes(value) {
  return unescape(encodeURIComponent(JSON.stringify(value))).length;
}
export class CountState {
  constructor(storage, owner, request, receive = () => {}) {
    this.storage = storage; this.owner = owner; this.request = request;
    this.receive = receive; this.tail = Promise.resolve(); this.active = true;
    this.eventKey = `hotwax-count:${owner}:scan-events`;
    this.itemKey = `hotwax-count:${owner}:count-items`;
  }
  serial(fn) {
    const task = this.tail.catch(() => {}).then(fn);
    this.tail = task; return task;
  }
  async write(key, value) {
    if (jsonBytes(value) > KV_LIMIT) throw new Error('Local count storage is full. Sync and finish this count before scanning more. No scan was discarded.');
    await this.storage.set(key, value);
  }
  async open(count) {
    return this.serial(async () => {
      const [events, items] = await Promise.all([this.storage.get(this.eventKey), this.storage.get(this.itemKey)]);
      if (events && events.sessionId !== count.sessionId && events.events.some(e => e.aggApplied === 0)) throw new Error('Reopen the previous count and reconcile its pending scans first.');
      if (items && items.sessionId !== count.sessionId && Object.values(items.items).some(i => i.revision !== i.syncedRevision)) throw new Error('Sync the previous count before opening another count.');
      this.count = count;
      this.events = events?.sessionId === count.sessionId ? events : {version: 1, sessionId: count.sessionId, nextId: 1, events: []};
      this.items = items?.sessionId === count.sessionId ? items : {version: 1, sessionId: count.sessionId, items: {}};
      this.items.count = {...count, items: []};
      for (const item of count.items) {
        if (!this.items.items[item.productId]) this.items.items[item.productId] = {...item,
          uuid: `${count.sessionId}:${item.productId}`, inventoryCountImportId: count.sessionId,
          productIdentifier: item.sku, status: 'active', createdAt: Date.now(), lastScanAt: 0,
          lastUpdatedAt: 0, lastSyncedAt: null, lastSyncedBatchId: null, revision: 0, syncedRevision: 0, lastEventId: 0, aggApplied: item.quantity};
      }
      await this.write(this.itemKey, this.items);
      await this.write(this.eventKey, this.events);
      this.notify();
    });
  }
  notify() {
    const items = Object.values(this.items.items);
    this.receive({...this.count, items, units: items.reduce((n, i) => n + i.quantity, 0)}, {
      events: this.events.events.length,
      pending: this.events.events.filter(e => e.aggApplied === 0).length,
      dirty: items.filter(i => i.revision !== i.syncedRevision).length,
      eventBytes: jsonBytes(this.events), itemBytes: jsonBytes(this.items),
      worker: typeof globalThis.Worker, indexedDB: typeof globalThis.indexedDB,
    });
  }
  append(job) {
    return this.serial(async () => {
      if (!this.active || !this.count?.editable) throw new Error('This count is no longer active.');
      const events = clone(this.events);
      const event = {id: events.nextId++, inventoryCountImportId: this.count.sessionId,
        scannedValue: job.code, productId: job.productId || null, locationSeqId: null,
        negatedScanEventId: null, quantity: job.source === 'correction' ? job.quantity : 1,
        mode: job.source === 'correction' ? 'set' : 'add', source: job.source,
        createdAt: Date.now(), aggApplied: 0};
      events.events.push(event);
      await this.write(this.eventKey, events); this.events = events; this.notify();
      return event.id;
    });
  }
  aggregate() {
    if (this.aggregating) return this.aggregating;
    this.aggregating = (async () => {
      while (this.active) {
        await this.tail.catch(() => {});
        const event = this.events.events.find(e => e.aggApplied === 0);
        if (!event) break;
        const cached = Object.values(this.items.items).find(i => i.productId === event.productId || i.codes?.includes(event.scannedValue));
        const product = cached || await this.request('lookup', {code: event.scannedValue});
        if (!this.active) break;
        await this.serial(async () => {
          const items = clone(this.items);
          const old = items.items[product.productId];
          if (!old || old.lastEventId < event.id) {
            const quantity = event.mode === 'set' ? event.quantity : (old?.quantity || 0) + event.quantity;
            if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) throw new Error('Count quantity must be between 0 and 1,000,000.');
            const item = {...product, ...old, productId: product.productId,
              uuid: `${this.count.sessionId}:${product.productId}`, inventoryCountImportId: this.count.sessionId,
              productIdentifier: event.scannedValue, codes: [...new Set([...(old?.codes || []), event.scannedValue])],
              quantity, aggApplied: quantity, status: 'active',
              createdAt: old?.createdAt || event.createdAt, lastScanAt: event.createdAt,
              lastUpdatedAt: event.createdAt, lastSyncedAt: old?.lastSyncedAt || null,
              lastSyncedBatchId: old?.lastSyncedBatchId || null, revision: event.id, syncedRevision: old?.syncedRevision || 0,
              lastEventId: event.id, systemQuantityOnHand: old?.systemQuantityOnHand ?? product.onHand ?? null};
            if (item.onHand != null) item.delta = quantity - item.onHand;
            items.items[product.productId] = item;
            await this.write(this.itemKey, items); this.items = items;
          }
          const events = clone(this.events);
          const applied = events.events.find(e => e.id === event.id);
          applied.productId = product.productId; applied.aggApplied = 1;
          await this.write(this.eventKey, events); this.events = events;
          this.notify();
        });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    })().finally(() => {this.aggregating = undefined;});
    return this.aggregating;
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      await this.aggregate();
      while (this.active) {
        await this.tail.catch(() => {});
        const item = Object.values(this.items.items).find(i => i.revision !== i.syncedRevision);
        if (!item) break;
        const snapshot = clone(item);
        const saved = await this.request('save', {sessionId: this.count.sessionId,
          code: snapshot.productIdentifier, quantity: snapshot.quantity});
        if (!this.active) break;
        await this.serial(async () => {
          const items = clone(this.items);
          const latest = items.items[snapshot.productId];
          latest.syncedRevision = snapshot.revision;
          latest.lastSyncedAt = Date.now();
          latest.lastSyncedBatchId = `${this.count.sessionId}:${snapshot.productId}:${snapshot.revision}`;
          if (saved.canViewOnHand && saved.onHand != null) {
            latest.onHand = saved.onHand; latest.systemQuantityOnHand = saved.onHand;
            latest.delta = latest.quantity - saved.onHand;
          }
          await this.write(this.itemKey, items); this.items = items; this.notify();
        });
      }
    })().finally(() => {this.syncing = undefined;});
    return this.syncing;
  }
  discardUnmatched() {
    if (this.aggregating) throw new Error('Wait for product matching to finish before removing a scan.');
    return this.serial(async () => {
      const event = this.events.events.find(e => e.aggApplied === 0);
      if (!event || Object.values(this.items.items).some(i => i.lastEventId >= event.id)) throw new Error('This scan must be reconciled, not discarded.');
      const events = clone(this.events);
      events.events.find(e => e.id === event.id).aggApplied = -1;
      await this.write(this.eventKey, events); this.events = events; this.notify();
    });
  }
}
