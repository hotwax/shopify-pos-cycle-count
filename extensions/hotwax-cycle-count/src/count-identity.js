// Shopify variant ID -> HotWax product ID, shared by every session and operator
// of one shop and OMS connection on this device. Pairs come only from HotWax
// (its ShopifyShopProduct mapping in product search results), never from
// Shopify's own search. Only the modal runtime writes it.
export const IDENTITY_KEY = 'hotwax-count:identity';
const LIMIT = 20000;

export class IdentityMap {
  constructor(storage) {this.storage = storage; this.records = new Map(); this.scope = null; this.dirty = false; this.queue = Promise.resolve();}
  /** Load the pairs for this scope; a different shop or OMS starts empty. */
  load(scope) {
    const key = `${scope.shop}|${scope.oms}`;
    // Return the same native read on another open, even if the first screen was
    // cancelled. An unfinished map is never treated as loaded.
    if (this.scope === key) return this.loading;
    this.records = new Map(); this.scope = key; this.dirty = false;
    return this.loading=this.storage.load(IDENTITY_KEY).then(doc=>{
      if (this.scope === key && doc && !doc.legacy && doc.header?.scope === key)
        for (const record of doc.records) this.records.set(record[0], record);
    }).catch(()=>{ /* An unreadable map is rebuilt from HotWax results. */ });
  }
  get(variantId) {return variantId == null ? undefined : this.records.get(Number(variantId))?.[1];}
  add(variantId, productId) {
    const id = Number(variantId);
    if (!this.scope || !Number.isSafeInteger(id) || id <= 0 || typeof productId !== 'string' || !productId || this.get(id) === productId) return;
    this.records.delete(id); this.records.set(id, [id, productId]);
    while (this.records.size > LIMIT) this.records.delete(this.records.keys().next().value);
    this.dirty = true;
  }
  /** Save new pairs at most every 30 s. A pair not yet saved only costs a later
   * HotWax lookup, so the map is never written inside a count commit. */
  schedule() {
    if (!this.dirty || this.timer) return;
    this.timer = setTimeout(() => {this.timer = null; this.save().catch(() => {});}, 30000);
    this.timer.unref?.();
  }
  flush() {clearTimeout(this.timer); this.timer = null; return this.save().catch(() => {});}
  save() {
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.dirty || !this.scope) return;
      this.dirty = false;
      try {await this.storage.save(IDENTITY_KEY, {header: {scope: this.scope}, records: [...this.records.values()], keyOf: record => record[0], move: true});}
      catch (error) {this.dirty = true; throw error;}
    });
    return this.queue;
  }
}
