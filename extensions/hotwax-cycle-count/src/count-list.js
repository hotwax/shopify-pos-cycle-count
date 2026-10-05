export const PRODUCT_PAGE_SIZE = 40;
const matchesView = (item, view) => view === 'all' || (view === 'countedAll' ? item.quantity != null : view === 'uncounted' ? item.isRequested !== false && item.quantity == null : view === 'undirected' ? item.isRequested === false : item.quantity != null && item.isRequested !== false);

// Search text is indexed once per product identity, not rebuilt on each scan.
// Assigned order stays stable. Updated timestamps are read afresh when sorting;
// filtered IDs only need rebuilding when search text or filter membership changes.
export class CountListIndex {
  constructor() {this.records = new Map(); this.ids = []; this.queries = new Map();}
  update(items) {
    let membershipChanged = this.ids.length !== items.length;
    const ids = [];
    for (const item of items) {
      const previous = this.records.get(item.productId);
      const identity = `${item.title || ''}\n${item.sku || ''}\n${item.primary || ''}\n${item.secondary || ''}\n${(item.codes || []).join('\n')}`;
      if (!previous || previous.identity !== identity || (previous.item.quantity == null) !== (item.quantity == null) || previous.item.isRequested !== item.isRequested) membershipChanged = true;
      this.records.set(item.productId, {item, identity, search:previous?.identity === identity ? previous.search : identity.toLowerCase()});
      ids.push(item.productId);
    }
    if (membershipChanged) {
      const present = new Set(ids);
      const previousIds = new Set(this.ids);
      this.ids = [...this.ids.filter(id=>present.has(id)), ...ids.filter(id=>!previousIds.has(id))];
      for (const id of this.records.keys()) if (!present.has(id)) this.records.delete(id);
      this.queries.clear();
    }
  }
  /** Product IDs in the view whose indexed text matches, in assigned order. */
  list(search = '', view = 'all') {
    const query = search.trim().toLowerCase(), key = `${view}:${query}`;
    if (!this.queries.has(key)) {
      if (this.queries.size > 8) this.queries.clear();
      this.queries.set(key, this.ids.filter(id => {const record = this.records.get(id); return matchesView(record.item,view) && record.search.includes(query);}));
    }
    return this.queries.get(key);
  }
  /** Products whose identifier or a barcode equals the query exactly. */
  exact(search) {
    const query = search.trim().toLowerCase();
    return query ? this.ids.filter(id => {const item = this.records.get(id).item; return String(item.productIdentifier || '').toLowerCase() === query || (item.codes || []).some(code => String(code).toLowerCase() === query);}) : [];
  }
  /** Sort a whole result set (never just the rendered page). */
  sort(ids, sort) {
    if (sort === 'assigned') return ids;
    return ids.filter(id => this.records.has(id)).sort((a,b)=>{const left=this.records.get(a).item,right=this.records.get(b).item;return sort==='alphabetic'?String(left.primary||left.title||left.sku||a).localeCompare(String(right.primary||right.title||right.sku||b))||a.localeCompare(b):(right.lastUpdatedAt||0)-(left.lastUpdatedAt||0)||a.localeCompare(b);});
  }
  page(search = '', view = 'all', page = 0, sort = 'assigned') {return this.slice(this.sort(this.list(search, view), sort), page);}
  slice(ids, page = 0) {
    const pages = Math.max(1,Math.ceil(ids.length / PRODUCT_PAGE_SIZE));
    const current = Math.min(Math.max(0,page),pages-1);
    return {total:ids.length,pages,page:current,items:ids.slice(current*PRODUCT_PAGE_SIZE,(current+1)*PRODUCT_PAGE_SIZE).map(id=>this.records.get(id).item)};
  }
}
