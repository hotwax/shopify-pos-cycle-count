import {OmsConnection, OmsLookupError, rows, text, type OmsRow} from '../../../shared/oms-connection';
import {inventoryConnection, limited, shopifyRead as readShopify, type InventoryEvent, type InventoryLevel, type Location} from './Inventory';

const shopifyRead = <T,>(oms: OmsConnection, shopId: string, queryText: string, variables: OmsRow) =>
  readShopify<T>(oms,shopId,queryText,variables,'Shopify could not complete the POS order read.');

const HOUR = 60 * 60 * 1000;
type Page<T> = {nodes: T[]; pageInfo: {hasNextPage: boolean; endCursor: string | null}};
type Order = {id: string; name: string; createdAt: string; cancelledAt: string | null;
  sourceName: string; retailLocation: {id: string} | null};
type OrderLine = {id: string; quantity: number; currentQuantity: number; variant: {id: string} | null};
type Assignment = {id: string; status: string; assignedLocation: {location: {id: string} | null} | null;
  deliveryMethod: {methodType: string} | null};
type AssignedLine = {lineItem: {id: string}; totalQuantity: number; remainingQuantity: number};
type SalesImpact = {atp: number; onHand: number};
type StoreSale = {id: string; name: string; createdAt: number; cancelled: boolean; synced: boolean; impact: SalesImpact | null};
export type StoreSales = {checkedAt: number; windowMs: number; orders: StoreSale[]; pendingCount: number; impact: SalesImpact | null};
/** With the product's SKU, a day of POS orders: an import running hours behind still counts. */
const SKU_WINDOW = 24 * HOUR;

/** Shopify's quantities once every unsent change for this item is delivered, oldest batch first.
 * A change whose delivery record was purged is left out and counted in `unknown`. */
export function projectShopify(level: InventoryLevel, events: InventoryEvent[]) {
  if (events.some(event=>event.state==='Sending' || event.state==='Error')) {
    throw new OmsLookupError('A change for this product is being sent or needs attention, so the result after sync is not shown.');
  }
  const known = events.filter(event=>event.state==='Queued' || event.state==='Unbatched');
  const pending = [...known].sort((a,b)=>{
    if (a.state!==b.state) return a.state==='Queued' ? -1 : 1;
    return a.state==='Queued' ? a.messageAt-b.messageAt : a.at-b.at;
  });
  let {available,onHand} = level;
  for (const event of pending) {
    const change = event.reset && available!==null ? event.delta-available : event.delta;
    if (event.reset && available===null) onHand = null;
    available = event.reset ? event.delta : available===null ? null : available+change;
    if (onHand!==null) onHand += change;
  }
  return {available,onHand,unknown:events.length-known.length};
}

async function readPages<T>(read: (after: string | null) => Promise<Page<T> | null | undefined>) {
  const result: T[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page = await read(after);
    if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage!=='boolean') {
      throw new OmsLookupError('Shopify returned an incomplete order page.');
    }
    result.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return result;
    after = page.pageInfo.endCursor;
    if (!after || cursors.has(after) || !page.nodes.length) {
      throw new OmsLookupError('Shopify order pagination did not advance.');
    }
    cursors.add(after);
  }
}

async function orderHeaders(oms: OmsConnection, location: Location, checkedAt: number, windowMs: number, sku?: string) {
  const from = new Date(checkedAt-windowMs).toISOString();
  const to = new Date(checkedAt).toISOString();
  const filter = `source_name:pos location_id:${location.locationId} created_at:>='${from}' created_at:<='${to}'`+
    (sku ? ' sku:'+JSON.stringify(sku) : '');
  const orders = await readPages<Order>(async after=>{
    const response = await shopifyRead<{orders: Page<Order>}>(oms,location.shopId,
      `query StoreRecentPosOrders($filter: String!, $after: String) {
        orders(first: 50, after: $after, query: $filter, sortKey: CREATED_AT, reverse: true) {
          nodes { id name createdAt cancelledAt sourceName retailLocation { id } }
          pageInfo { hasNextPage endCursor }
        }
      }`,{filter,after});
    return response.orders;
  });
  const verified = new Map<string,Order>();
  for (const order of orders) {
    const at = Date.parse(order.createdAt);
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(order.id) ||
        order.sourceName!=='pos' || order.retailLocation?.id!=='gid://shopify/Location/'+location.locationId ||
        !Number.isFinite(at) || at<checkedAt-windowMs || at>checkedAt || verified.has(order.id)) {
      throw new OmsLookupError('Shopify returned an order outside the requested store or time window.');
    }
    verified.set(order.id,order);
  }
  return [...verified.values()];
}

async function importedOrderIds(oms: OmsConnection, productStoreId: string, orderIds: string[]) {
  const imported = new Set<string>();
  const response = await oms.postRead('/rest/s1/admin/search/query',{
    collection:'enterpriseSearch', query:'*:*', fields:'externalOrderId,productStoreId,orderId',
    filter:['docType:ORDER','orderTypeId:SALES_ORDER','productStoreId:'+JSON.stringify(productStoreId),
      'externalOrderId:('+orderIds.map(id=>JSON.stringify(id)).join(' OR ')+')'],
    params:{rows:200},
  });
  const outer = response.response as OmsRow | undefined;
  const result = (outer?.response || outer) as OmsRow | undefined;
  if (!Array.isArray(result?.docs) || !Number.isFinite(Number(result.numFound))) {
    throw new OmsLookupError('HotWax order search returned incomplete results.');
  }
  for (const row of rows(result.docs)) {
    const id = text(row.externalOrderId);
    if (row.productStoreId===productStoreId && row.orderId && orderIds.includes(id)) imported.add(id);
  }

  const misses = orderIds.filter(id=>!imported.has(id));
  if (!misses.length) return imported;
  // An order can be in the OMS before the Solr document is indexed.
  const {orders} = await oms.graphqlRead<{orders: {
    edges: {node: {orderId: string; externalId: string; productStoreId: string; orderTypeId: string}}[];
    pageInfo: {hasNextPage: boolean};
  }}>(`query StoreImportedPosOrders($first: Int!, $filter: String!) {
    orders(first: $first, query: $filter) {
      edges { node { orderId externalId productStoreId orderTypeId } }
      pageInfo { hasNextPage }
    }
  }`,{first:misses.length+1,filter:`externalId:${misses.join(',')} productStoreId:${JSON.stringify(productStoreId)} orderTypeId:SALES_ORDER`});
  if (!Array.isArray(orders?.edges) || orders.pageInfo?.hasNextPage!==false) {
    throw new OmsLookupError('HotWax could not verify every order missing from search.');
  }
  for (const {node} of orders.edges) {
    if (!node || !node.orderId || node.productStoreId!==productStoreId ||
        node.orderTypeId!=='SALES_ORDER' || !misses.includes(node.externalId)) {
      throw new OmsLookupError('HotWax returned an order outside the requested shop.');
    }
    imported.add(node.externalId);
  }
  return imported;
}

async function saleImpact(oms: OmsConnection, location: Location, id: string, variantId: string) {
  const lines = await readPages<OrderLine>(async after=>{
    const response = await shopifyRead<{order: {lineItems: Page<OrderLine>} | null}>(oms,location.shopId,
      `query StorePosOrderLines($id: ID!, $after: String) {
        order(id: $id) {
          lineItems(first: 60, after: $after) {
            nodes { id quantity currentQuantity variant { id } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,{id,after});
    return response.order?.lineItems;
  });
  const selected = lines.filter(line=>line.variant?.id==='gid://shopify/ProductVariant/'+variantId);
  if (!selected.length) return {atp:0,onHand:0};
  if (selected.some(line=>line.quantity!==line.currentQuantity)) {
    throw new OmsLookupError('A matching line was edited or refunded.');
  }
  const quantities = new Map(selected.map(line=>[line.id,line.currentQuantity]));
  const assigned = new Map<string,number>();
  const assignments = await readPages<Assignment>(async after=>{
    const response = await shopifyRead<{order: {fulfillmentOrders: Page<Assignment>} | null}>(oms,location.shopId,
      `query StorePosOrderAssignments($id: ID!, $after: String) {
        order(id: $id) {
          fulfillmentOrders(first: 30, after: $after) {
            nodes { id status deliveryMethod { methodType } assignedLocation { location { id } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,{id,after});
    return response.order?.fulfillmentOrders;
  });
  let atp = 0, onHand = 0;
  for (const assignment of assignments) {
    if (assignment.status==='CANCELLED') continue;
    const items = await readPages<AssignedLine>(async after=>{
      const response = await shopifyRead<{fulfillmentOrder: {lineItems: Page<AssignedLine>} | null}>(oms,location.shopId,
        `query StorePosAssignedItems($id: ID!, $after: String) {
          fulfillmentOrder(id: $id) {
            lineItems(first: 60, after: $after) {
              nodes { lineItem { id } totalQuantity remainingQuantity }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,{id:assignment.id,after});
      return response.fulfillmentOrder?.lineItems;
    });
    for (const item of items) {
      const lineId = item.lineItem.id;
      if (!quantities.has(lineId)) continue;
      const assignedLocation = assignment.assignedLocation?.location?.id;
      const method = assignment.deliveryMethod?.methodType;
      const {totalQuantity,remainingQuantity} = item;
      if (!assignedLocation || !method || assignment.status==='INCOMPLETE' ||
          !Number.isSafeInteger(totalQuantity) || !Number.isSafeInteger(remainingQuantity) ||
          remainingQuantity<0 || remainingQuantity>totalQuantity) {
        throw new OmsLookupError('The selected product has an incomplete fulfillment assignment.');
      }
      assigned.set(lineId,(assigned.get(lineId) ?? 0)+totalQuantity);
      if (assignedLocation!=='gid://shopify/Location/'+location.locationId) continue;
      atp += totalQuantity;
      onHand += method==='RETAIL' ? totalQuantity : totalQuantity-remainingQuantity;
    }
  }
  if ([...quantities].some(([lineId,quantity])=>(assigned.get(lineId) ?? 0)!==quantity)) {
    throw new OmsLookupError('Shopify fulfillment assignments did not account for every unit.');
  }
  return {atp,onHand};
}

export async function recentStoreSales(location: Location, variantId: string | undefined, signal: AbortSignal,
  checkedAt=Date.now(), sku?: string): Promise<StoreSales> {
  if (!location.productStoreId) throw new OmsLookupError('The Shopify shop has no HotWax product store mapping.');
  const oms = inventoryConnection(location,signal,45000);
  const windowMs = sku ? SKU_WINDOW : HOUR;
  const orders = await orderHeaders(oms,location,checkedAt,windowMs,sku);
  const externalId = (order: Order) => order.id.split('/').at(-1)!;
  const lookups = [];
  for (let start = 0; start < orders.length; start += 50) {
    lookups.push(importedOrderIds(oms,location.productStoreId,orders.slice(start,start+50).map(externalId)));
  }
  const imported = new Set((await Promise.all(lookups)).flatMap(ids=>[...ids]));
  // Each unimported order costs a few Shopify reads; keep only a few in flight.
  const sales = await limited(orders,4,async order=>{
    const synced = imported.has(externalId(order));
    const cancelled = Boolean(order.cancelledAt);
    const impact = synced ? null : cancelled ? {atp:0,onHand:0} : variantId
      ? await saleImpact(oms,location,order.id,variantId).catch(()=>null) : null;
    return {id:order.id,name:order.name,createdAt:Date.parse(order.createdAt),cancelled,synced,impact};
  });
  const pending = sales.filter(order=>!order.synced);
  const impact = pending.reduce<SalesImpact | null>((total,order)=>total && order.impact ? {
    atp:total.atp+order.impact.atp,onHand:total.onHand+order.impact.onHand,
  } : null,{atp:0,onHand:0});
  return {checkedAt,windowMs,orders:sales,pendingCount:pending.length,impact};
}
