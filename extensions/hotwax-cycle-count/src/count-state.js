// A durable scan journal plus an item checkpoint. Never acknowledge a scan before
// Storage API accepts it. Both documents hold only identity, quantities and
// replay state; names and images live in bounded runtime caches and are fetched
// again (Shopify by variant, or HotWax) after reopening.
import {CountStorage} from './count-storage';
import {controlFor, readMailbox} from './count-control';

const copy = value => JSON.parse(JSON.stringify(value));
const message = error => error instanceof Error ? error.message : 'Product could not be matched. Retry when connected.';
// `null` stays meaningful for quantities: not counted is different from an explicit zero.
const NULLABLE = new Set(['quantity','serverQuantity']);
const pick = (value, fields) => {const out = {}; for (const field of fields) if (value[field] != null || (value[field] === null && NULLABLE.has(field))) out[field] = value[field]; return out;};
const EVENT_FIELDS = ['id','scannedValue','quantity','mode','source','createdAt','aggApplied','productId','variantId','negatedScanEventId','batchId','manuallyMatched','staffId','deviceId'];
const ITEM_FIELDS = ['productId','variantId','codes','productIdentifier','quantity','isRequested','revision','syncedRevision','serverQuantity','lastCorrectionId','lastUpdatedAt','lastSyncedAt','seq'];
/** The persisted projections: no names, images or embedded product objects. */
export const slimEvent = event => pick(event, EVENT_FIELDS);
export const slimItem = item => pick(item, ITEM_FIELDS);
const DISPLAY_FIELDS = ['title','sku','primary','secondary','imageUrl'];
const CACHE_LIMIT = 3000;
const remember = (map, key, value) => {map.delete(key); map.set(key, value); if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);};
const codesOf = values => [...new Set(values.filter(Boolean).map(String))];
const token = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class CountState {
  constructor(storage, owner, request, receive = () => {}, audit = {}, assertCanCount = () => {}, options = {}) {
    this.storage = storage instanceof CountStorage ? storage : new CountStorage(storage);
    this.native = this.storage.native; this.owner = owner; this.request = request; this.receive = receive;
    this.control = options.control || controlFor(this.native, owner); this.identity = options.identity || null;
    this.tail = Promise.resolve(); this.active = true; this.failures = new Map(); this.enriching = new Map();
    // Runtime only: HotWax display by product, Shopify display by variant, and the
    // variant a scan resolved to before its next journal commit saves it.
    // This count's own products keep their HotWax display for the whole session;
    // other products share a bounded cache.
    this.memberDisplay = new Map(); this.omsDisplay = new Map(); this.shopDisplay = new Map(); this.scanVariants = new Map(); this.missing = new Map();
    this.views = new WeakMap(); this.displayVersion = 0; this.memo = {}; this.retire = {events: [], items: []};
    this.eventKey = `hotwax-count:${owner}:scan-events`;
    this.itemKey = `hotwax-count:${owner}:count-items`;
    this.audit = audit;
    this.assertCanCount = assertCanCount;
  }
  serial(fn) {const task = this.tail.catch(() => {}).then(fn); this.tail = task; return task;}
  async save(kind, doc) {
    const header = {...doc}; delete header[kind];
    const records = kind === 'events' ? doc.events : Object.values(doc.items);
    try {
      await this.storage.save(kind === 'events' ? this.eventKey : this.itemKey, {header, records,
        keyOf: kind === 'events' ? event => event.id : item => item.productId, move: kind === 'items', retire: this.retire[kind],
        summary: kind === 'events' ? {pendingCount: records.filter(event => event.aggApplied === 0).length, eventCount: records.length} : undefined});
      this.retire[kind] = [];
    } catch (error) {if (error.recoveryRequired) this.active = false; throw error;}
  }
  async commitEvents(events) {
    const merged = this.applyVariants(events);
    await this.save('events', events); this.events = events;
    for (const id of merged) this.scanVariants.delete(id);
  }
  /** Keep HotWax display for a product in memory. `pair` also records its
   * Shopify variant in the shared map; only countable HotWax search results and
   * this count's own products are trusted for that. */
  remember(product, pair, member) {
    const id = product && product.productId;
    if (!id) return;
    if (member == null) member = !!(this.items && this.items.items[id]);
    const old = this.displayOf(id), next = {...old};
    for (const field of DISPLAY_FIELDS) if (product[field]) next[field] = product[field];
    if (this.count && this.count.canViewOnHand && product.onHand != null) next.onHand = product.onHand;
    if (member || this.memberDisplay.has(id)) {this.omsDisplay.delete(id); this.memberDisplay.set(id, next);}
    else remember(this.omsDisplay, id, next);
    // Only products HotWax reports as countable may answer a later scan without its lookup.
    if (pair && product.countable === true && product.shopifyVariantId != null && this.identity) this.identity.add(product.shopifyVariantId, id);
    this.displayVersion++;
  }
  displayOf(productId) {return this.memberDisplay.get(productId) ?? this.omsDisplay.get(productId);}
  rememberVariant(variantId, display) {
    if (variantId == null || !display) return;
    remember(this.shopDisplay, Number(variantId), {title: display.title, sku: display.sku, imageUrl: display.imageUrl});
    this.displayVersion++;
  }
  /** An item with whatever display is known: Shopify first for names and images,
   * HotWax for its identifiers, and the saved identifier as the placeholder. */
  view(item) {
    if (!item) return item;
    const oms = this.displayOf(item.productId), shop = item.variantId != null ? this.shopDisplay.get(item.variantId) : undefined;
    const cached = this.views.get(item);
    if (cached && cached.oms === oms && cached.shop === shop) return cached.view;
    const fallback = item.productIdentifier || item.productId, o = oms || {}, s = shop || {};
    const onHand = this.count && this.count.canViewOnHand ? o.onHand : undefined;
    const view = {...item, title: s.title || o.title || fallback, sku: o.sku || s.sku || fallback,
      primary: o.primary || s.sku || fallback, secondary: o.secondary || item.productId, imageUrl: s.imageUrl || o.imageUrl,
      ...(onHand != null ? {onHand, delta: item.quantity == null ? null : item.quantity - onHand} : {})};
    this.views.set(item, {oms, shop, view});
    return view;
  }
  variantOf(event) {return event.manuallyMatched ? undefined : event.variantId ?? this.scanVariants.get(event.id);}
  /** Display for an event's own scan (its Shopify variant), when known. */
  display(event) {const variantId = this.variantOf(event); return variantId == null ? undefined : this.shopDisplay.get(Number(variantId));}
  /** Save each scan's resolved Shopify variant with the next journal commit. */
  applyVariants(events) {
    const merged = [];
    for (const [id, variantId] of this.scanVariants) {
      let index = events.events.length - 1;
      while (index >= 0 && events.events[index].id !== id) index--;
      const event = events.events[index];
      if (!event || event.variantId != null || event.manuallyMatched) {this.scanVariants.delete(id); continue;}
      events.events[index] = {...event, variantId}; merged.push(id);
    }
    return merged;
  }
  /** Fetch Shopify display for visible variants that are not cached yet. */
  async hydrate(variantIds) {
    const now = Date.now();
    const ids = [...new Set(variantIds.filter(id => id != null).map(Number))]
      .filter(id => !this.shopDisplay.has(id) && !(this.missing.get(id) > now)).slice(0, 100);
    // Display found elsewhere (product search) still reaches the rendered rows.
    if (!ids.length || !this.request.variants) {if (this.items && this.notifiedVersion !== this.displayVersion) this.notify(); return;}
    for (let i = 0; i < ids.length; i += 50) {
      const found = await this.request.variants(ids.slice(i, i + 50)).catch(() => null);
      if (!found || !this.active) return;
      for (const id of ids.slice(i, i + 50)) if (!found.has(id)) this.missing.set(id, now + 300000);
      for (const [id, display] of found) remember(this.shopDisplay, id, display);
    }
    this.displayVersion++; this.notify();
  }
  async open(count) {
    return this.serial(async () => {
      this.count = count;
      // Earlier releases kept one session in unprefixed keys. Keep using that
      // pair for its own session; other sessions get their own keys.
      const legacyItems = await this.storage.load(this.itemKey), legacyEvents = await this.storage.load(this.eventKey);
      const readable = doc => !doc || (typeof doc.header?.sessionId === 'string' && [1, 2].includes(doc.header?.version));
      if (!readable(legacyItems) || !readable(legacyEvents)) throw new Error('Saved count data cannot be read. Keep this device and contact support.');
      const mine = legacyItems?.header?.sessionId === count.sessionId || legacyEvents?.header?.sessionId === count.sessionId;
      let itemsDoc = legacyItems, eventsDoc = legacyEvents;
      if (mine) {
        // A pair split across two sessions keeps the other session's unsynced work.
        if (legacyEvents && legacyEvents.header?.sessionId !== count.sessionId) {
          if (legacyEvents.records.some(e => e.aggApplied === 0)) throw new Error('Resolve the previous count’s unmatched scans before opening another count.');
          eventsDoc = undefined; this.retire.events = legacyEvents.retire || [];
        }
        if (legacyItems && legacyItems.header?.sessionId !== count.sessionId) {
          if (legacyItems.records.some(i => i.revision !== i.syncedRevision)) throw new Error('Sync the previous count before opening another count.');
          itemsDoc = undefined; this.retire.items = legacyItems.retire || [];
        }
      } else {
        const prefix = `hotwax-count:${this.owner}:session:${encodeURIComponent(count.sessionId)}`;
        this.eventKey = `${prefix}:scan-events`; this.itemKey = `${prefix}:count-items`;
        [eventsDoc, itemsDoc] = [await this.storage.load(this.eventKey), await this.storage.load(this.itemKey)];
      }
      await this.control.upsertSession({sessionId: count.sessionId, workEffortId: count.workEffortId, name: count.name,
        itemKey: this.itemKey, eventKey: this.eventKey, statusId: count.statusId, updatedAt: Date.now()});
      for (const doc of [eventsDoc, itemsDoc]) if (doc && (doc.header?.sessionId !== count.sessionId || ![1, 2].includes(doc.header?.version)))
        throw new Error('Saved count data cannot be read. Keep this device and contact support.');
      if (eventsDoc && (!Number.isSafeInteger(eventsDoc.header.nextId) || eventsDoc.records.some(e => !Number.isSafeInteger(e?.id))))
        throw new Error('The saved scan journal is invalid. Contact support before continuing.');
      if (itemsDoc && itemsDoc.records.some(i => typeof i?.productId !== 'string')) throw new Error('The saved count checkpoint is invalid. Contact support before continuing.');
      if (eventsDoc) this.retire.events = eventsDoc.retire || [];
      if (itemsDoc) this.retire.items = itemsDoc.retire || [];
      // Older documents carried display data; keep it in memory, never on disk.
      const eventRecords = eventsDoc?.legacy ? eventsDoc.records.map(event => {
        if (event.product) this.remember(event.product);
        const variantId = event.shopifyProduct?.shopifyVariantId;
        if (variantId != null) this.rememberVariant(variantId, event.shopifyProduct);
        // A pending event's embedded product was its identity; keep that as its product ID.
        return slimEvent({...event, productId: event.productId ?? event.product?.productId, variantId: event.variantId ?? variantId});
      }) : eventsDoc?.records || [];
      const legacyRecords = itemsDoc?.legacy ? itemsDoc.records : [];
      for (const item of legacyRecords) {this.remember(item, false, true); if (item.shopifyVariantId != null) this.rememberVariant(item.shopifyVariantId, item);}
      const itemRecords = itemsDoc?.legacy ? legacyRecords.map(item => slimItem({...item, variantId: item.variantId ?? item.shopifyVariantId})) : itemsDoc?.records || [];
      const items = {...(itemsDoc?.header || {version: 2, sessionId: count.sessionId, applied: {}}), items: Object.fromEntries(itemRecords.map(item => [item.productId, item]))};
      // Version 1 processed strictly in order and used a per-product watermark.
      if (items.version === 1) {
        items.applied = {};
        for (const event of eventRecords.filter(e => e.aggApplied === 0)) {
          const item = legacyRecords.find(i => i.productId === event.productId || i.codes?.includes(event.scannedValue));
          if (item?.lastEventId >= event.id) items.applied[event.id] = true;
        }
      }
      items.version = 2; items.applied ||= {}; items.docId ||= token();
      // Only acknowledgements of scans still pending in the journal can matter.
      const pendingIds = new Set(eventRecords.filter(e => e.aggApplied === 0).map(e => String(e.id)));
      items.applied = Object.fromEntries(Object.entries(items.applied).filter(([id]) => pendingIds.has(id)));
      // Ids must stay above every saved event and correction for ordering checks.
      const nextId = [...eventRecords.map(e => e.id), ...itemRecords.map(i => i.lastCorrectionId || 0), ...Object.keys(items.applied).map(Number)]
        .reduce((max, id) => Math.max(max, id + 1), eventsDoc?.header?.nextId || 1);
      this.events = {...(eventsDoc?.header || {}), version: 2, sessionId: count.sessionId, nextId, events: eventRecords};
      // Receipts are the background's sync acknowledgements. Apply them before
      // refreshing server quantities; newer local scans remain dirty.
      const legacyReceiptKey = `${this.itemKey}:receipts`;
      const legacyReceipts = await this.native.get(legacyReceiptKey);
      const box = (await readMailbox(this.native, this.owner)).receipts[count.sessionId];
      // A receipt belongs to one checkpoint document: revisions restart if it is recreated.
      const receipts = {...legacyReceipts?.items, ...(box?.docId === items.docId ? box.items : {})};
      for (const [id, receipt] of Object.entries(receipts)) {
        const item = items.items[id];
        if (item && Number.isSafeInteger(receipt.revision) && receipt.revision > item.syncedRevision && receipt.revision <= item.revision &&
          Number.isSafeInteger(receipt.quantity) && receipt.quantity >= 0 && (receipt.revision !== item.revision || receipt.quantity === item.quantity))
          items.items[id] = {...item, syncedRevision: receipt.revision, serverQuantity: receipt.quantity, lastSyncedAt: receipt.at};
      }
      const meta = {...count, audit: this.audit}; delete meta.items; delete meta.units;
      items.count = meta;
      // Products keep the order they were assigned in, across reopening.
      let seq = itemRecords.reduce((max, item) => Math.max(max, item.seq || 0), 0);
      for (const id of Object.keys(items.items)) if (items.items[id].seq == null) items.items[id] = {...items.items[id], seq: ++seq};
      for (const detail of count.items) {
        this.remember(detail, true, true);
        const old = items.items[detail.productId], variantId = detail.shopifyVariantId ?? old?.variantId;
        if (!old) items.items[detail.productId] = slimItem({seq: ++seq, productId: detail.productId, variantId, productIdentifier: detail.sku || detail.productId,
          codes: codesOf(detail.codes || []), quantity: detail.quantity, isRequested: detail.isRequested, lastUpdatedAt: detail.lastUpdatedAt || 0,
          revision: 0, syncedRevision: 0, serverQuantity: detail.quantity, lastCorrectionId: 0});
        else if (old.revision === old.syncedRevision) {
          const codes = codesOf([...(detail.codes || []), ...(old.codes || [])]);
          if (old.quantity !== detail.quantity || old.serverQuantity !== detail.quantity || old.variantId !== variantId ||
            (detail.isRequested != null && old.isRequested !== detail.isRequested) || codes.length !== (old.codes || []).length)
            items.items[detail.productId] = slimItem({...old, quantity: detail.quantity, serverQuantity: detail.quantity, variantId, codes,
              isRequested: detail.isRequested ?? old.isRequested, lastUpdatedAt: detail.lastUpdatedAt ?? old.lastUpdatedAt});
        }
      }
      this.items = items; this.seq = seq;
      await this.save('items', this.items);
      if (legacyReceipts) await this.native.delete(legacyReceiptKey);
      await this.save('events', this.events);
      this.identity?.schedule();
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
  notify() {
    // Journal appends do not rebuild the product array or search index. Item
    // commits replace the map and preserve unchanged row object identities.
    if (this.notifiedItems !== this.items.items || this.notifiedVersion !== this.displayVersion) {
      if (this.notifiedItems !== this.items.items) {
        this.itemList = Object.values(this.items.items).sort((a, b) => (a.seq || 0) - (b.seq || 0));
        this.itemUnits = this.itemList.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
        this.dirtyCount = this.itemList.filter(i => i.revision !== i.syncedRevision).length;
      }
      this.notifiedItems = this.items.items; this.notifiedVersion = this.displayVersion;
      this.itemViews = this.itemList.map(item => this.view(item));
    }
    const {pending} = this.journalIndex();
    const undo = this.lastUndoable();
    const lastEvent = this.events.events[this.events.events.length-1];
    const lastProduct = lastEvent && {...this.view(this.items.items[lastEvent.productId]), ...this.display(lastEvent)};
    this.receive({...this.count, items: this.itemViews, units: this.itemUnits}, {
      events: this.events.events.length, pending: pending.length,
      dirty: this.dirtyCount,
      unmatched: pending.filter(e=>this.failures.has(e.id)).length,
      issues: pending.map(e => ({id: e.id, code: e.scannedValue, message: this.failures.get(e.id)?.message || 'Waiting for product matching'})),
      undoEventId: undo?.id,
      lastScan: lastEvent ? {id:lastEvent.id,code:lastEvent.scannedValue,source:lastEvent.source,variantId:this.variantOf(lastEvent),
        matched:lastEvent.aggApplied===1,title:lastProduct?.title,sku:lastProduct?.sku,imageUrl:lastProduct?.imageUrl,quantity:lastProduct?.quantity,
        matchingFailed:this.failures.has(lastEvent.id),
        productId:lastEvent.productId,at:lastEvent.createdAt,discarded:lastEvent.aggApplied===-1} : null,
    });
  }
  /** Durably record a scan. Scans arriving while a write is in flight share the
   * next journal write; each is acknowledged only once that write is stored. */
  append(job) {
    // Reject at receipt and again after queued work, before the journal commit.
    try {this.assertCanCount();} catch(error) {return Promise.reject(error);}
    return new Promise((resolve, reject) => {
      (this.appends ||= []).push({job, resolve, reject});
      if (this.appends.length === 1) this.serial(() => this.flushAppends());
    });
  }
  async flushAppends() {
    const queued = this.appends, events = {...this.events, events: [...this.events.events]}, accepted = [];
    this.appends = [];
    for (const {job, resolve, reject} of queued) {
      try {const event = this.buildEvent(job, events); events.events.push(event); accepted.push({event, resolve, reject});}
      catch (error) {reject(error);}
    }
    if (!accepted.length) return;
    try {await this.commitEvents(events);}
    catch (error) {for (const {reject} of accepted) reject(error); return;}
    this.notify();
    for (const {event, resolve} of accepted) {
      // Enrich every newly saved scan immediately, even while an older OMS batch is in flight.
      this.enrichEvent(event).catch(()=>{});
      resolve(event.id);
    }
  }
  buildEvent(job, events) {
    if (!this.active || !this.count?.editable) throw new Error('This count is no longer active.');
    this.assertCanCount();
    const code = String(job.code || '').trim();
    if (!code || code.length > 255 || /[\x00-\x1f]/.test(code)) throw new Error('Enter a valid barcode or SKU.');
    if (job.source === 'correction' && (!Number.isSafeInteger(job.quantity) || job.quantity < 0 || job.quantity > 1000000)) throw new Error('Enter a whole quantity between 0 and 1,000,000.');
    // Undo events are written only by undoScan, which checks what they reverse.
    const event = slimEvent({scannedValue: code, productId: job.productId || null,
      quantity: job.source === 'correction' ? job.quantity : (job.quantity ?? 1),
      mode: job.source === 'correction' ? 'set' : 'add', source: job.source,
      createdAt: Date.now(), aggApplied: 0, staffId:this.audit.staffId,deviceId:this.audit.deviceId});
    if(!Number.isSafeInteger(event.quantity)||Math.abs(event.quantity)>1000000||(event.mode==='add'&&event.quantity<=0))throw new Error('Enter a whole quantity from 1 to 1,000,000.');
    if (job.product) this.remember(job.product);
    return {id: events.nextId++, ...event};
  }
  enrichEvent(event) {
    if (!this.request.enrichScan || event.productId || event.variantId != null || this.scanVariants.has(event.id) || ['undo','correction'].includes(event.source)) return Promise.resolve();
    if (this.enriching.has(event.id)) return this.enriching.get(event.id);
    // The exact Shopify variant for the barcode gives display data at once and
    // its variant ID, which is saved with the next journal commit.
    const task=Promise.resolve().then(()=>this.request.enrichScan(event.scannedValue)).then(display=>{
      if (!display || !this.active || display.shopifyVariantId == null) return;
      this.rememberVariant(display.shopifyVariantId, display);
      this.scanVariants.set(event.id, Number(display.shopifyVariantId)); this.notify();
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
        const local = event => this.items.items[event.productId || this.codes.get(event.scannedValue.toLowerCase())] ||
          (event.productId ? {productId: event.productId} : null);
        // Only scans not resolved here wait for Shopify: their variant may skip the OMS lookup.
        await Promise.all(pending.map(event => local(event) ? (this.enrichEvent(event).catch(() => {}), null) : this.enrichEvent(event)));
        if (!this.active) break;
        const resolved = [], products = new Map(), batchErrors = new Map();
        // Known locally, chosen explicitly, or mapped from its Shopify variant: no OMS lookup.
        const known = event => local(event) ||
          (this.identity?.get(this.variantOf(event)) ? {productId: this.identity.get(this.variantOf(event))} : null);
        const lookupBatch=this.request.lookupIdentityBatch||this.request.lookupBatch;
        if (lookupBatch) {
          const unresolved = pending.filter(event => !known(event));
          const codes = [...new Set(unresolved.map(event => event.scannedValue))];
          // Native search can legitimately miss a POS product. Keep the proven
          // OMS display fallback instead of reducing a matched row to a barcode.
          const enrichedCodes=new Set(unresolved.filter(e=>this.display(e)).map(e=>e.scannedValue));
          const batches=this.request.lookupIdentityBatch&&this.request.lookupBatch?
            [[codes.filter(code=>enrichedCodes.has(code)),this.request.lookupIdentityBatch],[codes.filter(code=>!enrichedCodes.has(code)),this.request.lookupBatch]]:[[codes,lookupBatch]];
          await Promise.all(batches.map(async([batch,lookup])=>{if (!batch.length)return;try {
            const result = await lookup(batch);
            for (const product of result.matches || []) {products.set(product.code, product); this.remember(product, true);}
            for (const error of result.errors || []) batchErrors.set(error.code, error.message);
            for (const code of batch) if (!products.has(code) && !batchErrors.has(code)) batchErrors.set(code, 'Product matching was incomplete. Retry when connected.');
          } catch (error) {for (const code of batch) batchErrors.set(code, message(error));}}));
        }
        for (const event of pending) {
          if (!this.active) return;
          const cached = known(event) || products.get(event.scannedValue);
          try {
            if (!cached && batchErrors.has(event.scannedValue)) throw new Error(batchErrors.get(event.scannedValue));
            const product = cached || await this.request('lookup', {code: event.scannedValue});
            if (!product?.productId || typeof product.productId!=='string') throw new Error('HotWax has not identified this product yet. Retry matching.');
            if (!cached) this.remember(product, true);
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
          const merged = this.applyVariants(events), rejected = [];
          // Keep only acknowledgements which the journal has not committed yet.
          items.applied = Object.fromEntries(Object.entries(items.applied).filter(([id]) => events.events.some(e => e.id === Number(id) && e.aggApplied === 0)));
          for (const {event, product} of resolved) {
            const index = events.events.findIndex(e => e.id === event.id);
            const applied = index < 0 ? null : {...events.events[index]};
            if (applied) events.events[index] = applied;
            if (!applied || applied.aggApplied !== 0) continue;
            if (!items.applied[event.id]) {
              const old = items.items[product.productId] || {}, corrected = old.lastCorrectionId || 0;
              // A late match before a later explicit correction must not change that correction.
              const quantity = corrected > event.id ? old.quantity : event.mode === 'set' ? event.quantity : (old.quantity || 0) + event.quantity;
              // Keep only this scan pending with a reason; the rest of the batch still commits.
              if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) {rejected.push(event.id); continue;}
              items.items[product.productId] = slimItem({...old, seq: old.seq ?? ++this.seq, productId: product.productId,
                variantId: old.variantId ?? product.shopifyVariantId ?? this.variantOf(applied),
                isRequested: old.isRequested ?? this.count.countType !== 'DIRECTED_COUNT',
                productIdentifier: event.scannedValue, codes: codesOf([...(old.codes || []), event.scannedValue]),
                quantity, lastUpdatedAt: Date.now(),
                // Revisions count commits, not event IDs: late matches must remain dirty.
                revision: (old.revision || 0) + 1, syncedRevision: old.syncedRevision || 0, serverQuantity: old.serverQuantity ?? null,
                lastCorrectionId: event.mode === 'set' ? Math.max(corrected, event.id) : corrected});
              items.applied[event.id] = true;
            }
            applied.productId = product.productId; applied.aggApplied = 1;
          }
          // This ordering is the crash boundary tested by interrupted-write tests.
          await this.save('items', items); this.items = items;
          await this.save('events', events); this.events = events;
          for (const id of merged) this.scanVariants.delete(id);
          for (const id of rejected) this.failures.set(id, {message: 'This scan would take the product total outside 0 to 1,000,000. Remove it or correct the quantity.',
            attempts: (this.failures.get(id)?.attempts || 0) + 1, retryAt: Date.now() + 60000});
          this.identity?.schedule();
          // Products new to the count keep their display for the session.
          for (const {product} of resolved) if (this.items.items[product.productId]) this.remember(product, false, true);
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
    const product = eventId != null && this.view(this.items.items[results[0]?.productId]);
    return {
      matched: results.filter(event => event.aggApplied === 1).length,
      remaining: remaining.length,
      reason: remaining.length ? this.failures.get(remaining[0].id)?.message || 'Product matching is still pending. Try again when connected.' : '',
      product: product ? {title:product.title,quantity:product.quantity} : null,
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
            const saved = result.items.find(i => i.productId === snapshot.productId);
            items.items[snapshot.productId] = {...items.items[snapshot.productId], syncedRevision: snapshot.revision, serverQuantity: snapshot.quantity, lastSyncedAt: Date.now()};
            if (result.canViewOnHand && saved.onHand != null) this.remember({productId: snapshot.productId, onHand: saved.onHand});
          }
          await this.save('items', items); this.items = items; this.notify();
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
        item.quantity = serverQuantity;
        item.revision++; item.syncedRevision = item.revision;
        // A reconciliation supersedes earlier scan undo/correction history.
        item.lastCorrectionId = this.events.nextId - 1;
      }
      const items = {...this.items, items: {...this.items.items, [productId]: slimItem(item)}};
      await this.save('items', items); this.items = items; this.notify();
    });
  }
  /** A matched scan that adds units, not yet reversed or replaced by a later correction. */
  undoable(e, negated) {
    const item = this.items.items[e.productId];
    return e.aggApplied === 1 && e.mode === 'add' && e.quantity > 0 && !negated.has(e.id) && (item && item.lastCorrectionId || 0) < e.id;
  }
  lastUndoable() {
    const memo = this.memo.undo;
    if (memo?.events === this.events.events && memo.items === this.items.items) return memo.event;
    const {negated} = this.journalIndex();
    let found;
    for (let i = this.events.events.length - 1; i >= 0; i--) {
      const event = this.events.events[i];
      if (this.undoable(event, negated)) {found = event; break;}
    }
    this.memo.undo = {events: this.events.events, items: this.items.items, event: found};
    return found;
  }
  historyPage(search='',page=0,filter='all') {
    const {negated}=this.journalIndex();
    const query=search.trim().toLowerCase();
    const title=e=>this.display(e)?.title||(this.items.items[e.productId]?this.view(this.items.items[e.productId]).title:'');
    // Filtering and ordering run once per journal, item map, display or query change;
    // re-renders and page turns reuse the ordered list. Event IDs are the true
    // chronology, independent of product order, enrichment and device clocks.
    const memo=this.memo.history;
    let events=memo?.list;
    if(!(memo&&memo.events===this.events.events&&memo.items===this.items.items&&memo.displayVersion===this.displayVersion&&memo.query===query&&memo.filter===filter)){
      events=this.events.events.filter(e=>(filter!=='unmatched'||e.aggApplied===0)&&(!query||`${e.scannedValue} ${title(e)}`.toLowerCase().includes(query)))
        .sort((a,b)=>b.id-a.id);
      this.memo.history={events:this.events.events,items:this.items.items,displayVersion:this.displayVersion,query,filter,list:events};
    }
    const pages=Math.max(1,Math.ceil(events.length/40)),current=Math.min(page,pages-1);
    return {total:events.length,pages,page:current,items:events.slice(current*40,(current+1)*40).map(e=>{
      const own=this.display(e),item=this.items.items[e.productId]&&this.view(this.items.items[e.productId]);
      return {...e,variantId:this.variantOf(e)??item?.variantId,title:own?.title||item?.title||e.scannedValue,imageUrl:own?.imageUrl||item?.imageUrl,
        matchingFailed:this.failures.has(e.id),
        canUndo:this.undoable(e,negated)};
    })};
  }
  /**
   * @param {{product:{productId:string,identifier?:string,sku?:string,shopifyVariantId?:number,variantId?:number},quantity:number}[]} entries
   */
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
        const product=entry.product;
        if(!product?.productId||!Number.isSafeInteger(entry.quantity)||entry.quantity<=0||entry.quantity>1000000)throw new Error('Enter a whole quantity for every selected product.');
        if(this.count.countType==='DIRECTED_COUNT'&&!this.items.items[product.productId]?.isRequested)throw new Error('Hand-count only products requested in this directed session.');
        this.remember(product,true);
        events.events.push(slimEvent({id:events.nextId++,scannedValue:product.identifier||product.sku||product.productId,productId:product.productId,
          variantId:product.shopifyVariantId??product.variantId,quantity:entry.quantity,mode:'add',source:'hand-count',batchId:operationId,createdAt:Date.now(),aggApplied:0,staffId:this.audit.staffId,deviceId:this.audit.deviceId}));
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
      this.remember(product,true);
      // The scan's Shopify variant described the barcode, not the chosen product.
      const events={...this.events,events:this.events.events.map(e=>{
        if(e.aggApplied!==0||e.scannedValue!==event.scannedValue||this.items.applied[e.id])return e;
        this.scanVariants.delete(e.id);
        const matched={...e,productId:product.productId,manuallyMatched:true};delete matched.variantId;return matched;
      })};
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
      const targets=this.events.events.filter(e=>(all?e.productId===selected.productId:e.id===id)&&this.undoable(e,negated));
      if(!targets.length)throw new Error('These scans have already been reversed or replaced by a quantity correction.');
      const events={...this.events,events:[...this.events.events]};
      for(const original of targets)events.events.push(slimEvent({id:events.nextId++,scannedValue:original.scannedValue,productId:original.productId,negatedScanEventId:original.id,quantity:-original.quantity,mode:'add',source:'undo',createdAt:Date.now(),aggApplied:0,staffId:this.audit.staffId,deviceId:this.audit.deviceId}));
      await this.commitEvents(events);this.notify();
    });
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

/** A saved session's count header and items, for reopening it offline or
 * migrating it without HotWax. Items are slim; nothing in them pairs a variant. */
export async function readSavedSession(storage, entry) {
  const doc = await storage.load(entry.itemKey);
  return doc?.header?.count && doc.header.sessionId === entry.sessionId ? {...doc.header.count, items: doc.records.map(slimItem)} : null;
}
