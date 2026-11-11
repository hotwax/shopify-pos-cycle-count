import {configureDirectOms, OmsConnection, OmsLookupError, rows, text, type OmsRow} from '../../../shared/oms-connection';
import {shopFacility} from '../../../shared/oms-shop';
import {INVENTORY_OMS, type InventoryScope} from '../../../shared/store-inventory';
import {readEventSources} from './InventoryEventSources';

type Location = {
  shopId: string;
  locationId: string;
  facilityId: string;
  name: string;
  timeZone?: string;
  token: string;
};

export type Variant = {
  variantId?: string; itemId?: string; title: string; option?: string; sku?: string; barcode?: string;
  imageUrl?: string; available?: number | null;
};
export type InventoryEvent = {
  id: string; itemId: string; eventType: string; source: string; reference: string;
  at: number; syncedAt?: number; delta: number; state: string; product?: Variant;
};
export type InventoryLevel = {available: number | null; onHand: number | null; committed: number | null; checkedAt: number};
export type HotWaxLevel = {atp: number | null; reservations: number | null; onHand: number | null; checkedAt: number};
type GraphPage<Node> = {edges: {node: Node}[]; pageInfo: {hasNextPage: boolean; endCursor?: string | null}};
type Reservation = {quantity: string | number | null};
type StockItem = {
  inventoryItemId: string; productId: string; facilityId: string;
  availableToPromiseTotal: string | number | null; quantityOnHandTotal: string | number | null;
  reservations: GraphPage<Reservation>;
};
type Ledger = {details: unknown};
type Quantities = {name: string; quantity: number}[];
type ItemNode = {id: string; inventoryLevel?: {quantities: Quantities}; variant?: VariantNode};
type MediaPreview = {preview?: {image?: {url: string} | null} | null};
type VariantNode = {
  id: string; title: string; sku?: string; barcode?: string;
  product: {title: string; featuredMedia?: MediaPreview | null};
  inventoryItem?: ItemNode;
  media?: {nodes: MediaPreview[]};
};

const LEDGER = '/rest/s1/sob/shopify/locationInventoryAdjustmentDetails';
const LEVELS = 'inventoryLevel(locationId: $location) { quantities(names: ["available", "on_hand", "committed"]) { name quantity } }';
function variantFields(imageSize: number) {
  const preview = `preview { image { url(transform: {maxWidth: ${imageSize}, maxHeight: ${imageSize}}) } }`;
  return `
    id title sku
    media(first: 1) { nodes { ${preview} } }
    product { title featuredMedia { ${preview} } }
  `;
}

const CATALOG_VARIANT_FIELDS = variantFields(144);
const DETAIL_VARIANT_FIELDS = variantFields(640);
const RESERVATION_FIELDS = 'edges { node { quantity } } pageInfo { hasNextPage endCursor }';

export async function inventoryLocation(scope: InventoryScope, getSessionToken: () => Promise<string | undefined>, signal: AbortSignal): Promise<Location> {
  const token = await getSessionToken();
  if (!token || signal.aborted) throw new OmsLookupError('Your Shopify session is unavailable. Reopen Store inventory.', 401);
  configureDirectOms(INVENTORY_OMS);
  const oms = new OmsConnection({shopifySessionToken:token,shopifyLocationId:scope.locationId,signal});
  const {shop,facilityId} = await shopFacility(oms, 'https://'+scope.shopDomain, scope.locationId);
  if (!facilityId) throw new OmsLookupError('This Shopify location has no HotWax facility.');
  const facility = await oms.get('/rest/s1/admin/facilities/'+encodeURIComponent(facilityId));
  return {shopId:text(shop.shopId),locationId:scope.locationId,facilityId,name:text(facility.facilityName),
    timeZone:text(facility.facilityTimeZone),token:await oms.accessToken()};
}

function connection(location: Location, signal?: AbortSignal) {
  return new OmsConnection({shopifySessionToken:'',shopifyLocationId:location.locationId,omsToken:location.token,signal});
}

export async function recentInventoryEvents(location: Location, signal: AbortSignal) {
  const query = new URLSearchParams({
    shopId:location.shopId,shopifyLocationId:location.locationId,mode:'RECENT',pageSize:'500',pageIndex:'0',
  });
  const oms = connection(location,signal);
  const data = await oms.get<Ledger>(LEDGER+'?'+query);
  if (!Array.isArray(data.details)) throw new OmsLookupError('HotWax returned an incomplete inventory ledger.');
  const events = rows(data.details)
    .filter(row=>text(row.shopId)===location.shopId && text(row.shopifyLocationId)===location.locationId)
    .map(readEvent);
  const products = await ledgerProducts(oms,location.shopId,events);
  return events.map(event=>({...event,product:products.get(event.itemId)}));
}

export function inventoryEventSources(location: Location, events: InventoryEvent[], signal: AbortSignal) {
  return readEventSources(connection(location,signal),location.facilityId,events);
}

async function ledgerProducts(oms: OmsConnection, shopId: string, events: InventoryEvent[]) {
  const ids = [...new Set(events.map(event=>event.itemId).filter(id=>/^\d+$/.test(id)))];
  const products = new Map<string,Variant>();
  const requests = [];
  for (let start=0; start<ids.length; start+=50) {
    requests.push(oms.postRead('/rest/s1/shopify/graphql',{
      shopId,
      queryText:`query InventoryItems($ids: [ID!]!) {
        nodes(ids: $ids) { ... on InventoryItem { id variant { ${CATALOG_VARIANT_FIELDS} } } }
      }`,
      variables:{ids:ids.slice(start,start+50).map(id=>'gid://shopify/InventoryItem/'+id)},
    }));
  }
  for (const result of await Promise.allSettled(requests)) {
    if (result.status!=='fulfilled') continue;
    const nodes = (result.value.response as {nodes?: (ItemNode | null)[]} | undefined)?.nodes ?? [];
    for (const node of nodes) {
      if (!node?.variant) continue;
      const itemId = node.id.split('/').at(-1)!;
      products.set(itemId,catalogVariant(node.variant,itemId));
    }
  }
  return products;
}

function catalogVariant(node: VariantNode, itemId?: string): Variant {
  return {
    itemId,variantId:node.id.split('/').at(-1),title:node.product.title,
    option:node.title==='Default Title' ? undefined : node.title,sku:node.sku,barcode:node.barcode,
    imageUrl:node.media?.nodes[0]?.preview?.image?.url ?? node.product.featuredMedia?.preview?.image?.url,
  };
}

function readEvent(row: OmsRow): InventoryEvent {
  const itemId = text(row.shopifyInventoryItemId);
  const reference = text(row.eventReferenceId);
  const delta = Number(row.computedInventoryChange ?? 0);
  const states: Record<string,string> = {
    SmsgProduced:'Queued',SmsgSending:'Sending',SmsgError:'Needs attention',
    SmsgSent:'Synced',SmsgCancelled:'Cancelled',
  };
  const message = text(row.systemMessageId);
  const status = text(row.systemMessageStatusId);
  return {
    id:[text(row.eventTypeId),reference,itemId].join(':'),
    itemId,reference,delta,at:Number(row.createdDate),eventType:text(row.eventTypeId),
    source:text(row.eventTypeDescription || row.eventTypeId),
    state:message ? states[status] || 'Assigned' : 'Pending',
    syncedAt:message && status==='SmsgSent' && row.systemMessageProcessedDate!=null
      ? Number(row.systemMessageProcessedDate) : undefined,
  };
}

export async function searchInventory(location: Location, query: string, barcode: string, signal: AbortSignal, after?: string) {
  const quoted = JSON.stringify(query.slice(0,120).replace(/\s+/g,' '));
  const filter = barcode ? 'barcode:'+quoted : '('+quoted+' OR sku:'+quoted+' OR barcode:'+quoted+')';
  const result = await connection(location,signal).postRead('/rest/s1/shopify/graphql',{
    shopId:location.shopId,
    queryText:`query StoreInventorySearch($after: String, $filter: String!, $location: ID!) {
      productVariants(first: 20, after: $after, query: $filter) {
        nodes {
          ${CATALOG_VARIANT_FIELDS} barcode
          inventoryItem { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
        }
        pageInfo { endCursor hasNextPage }
      }
    }`,
    variables:{after:after ?? null,filter,location:'gid://shopify/Location/'+location.locationId},
  });
  const page = (result.response as {productVariants?: {
    nodes: VariantNode[]; pageInfo: {endCursor?: string; hasNextPage: boolean};
  }} | undefined)?.productVariants;
  if (!page || !Array.isArray(page.nodes)) throw new OmsLookupError('Shopify returned incomplete product results.');
  const items = page.nodes.filter(node=>!barcode || node.barcode===barcode).map(node=>({
    ...catalogVariant(node,node.inventoryItem?.id.split('/').at(-1)),
    available:node.inventoryItem?.inventoryLevel?.quantities.find(entry=>entry.name==='available')?.quantity ?? null,
  }));
  return {items,cursor:page.pageInfo.hasNextPage?page.pageInfo.endCursor:undefined};
}

export async function inventoryLevel(location: Location, item: Variant, signal: AbortSignal) {
  const byItem = Boolean(item.itemId);
  const id = byItem ? 'gid://shopify/InventoryItem/'+item.itemId : 'gid://shopify/ProductVariant/'+item.variantId;
  const selection = byItem
    ? '... on InventoryItem { id '+LEVELS+' variant { '+DETAIL_VARIANT_FIELDS+' } }'
    : '... on ProductVariant { '+DETAIL_VARIANT_FIELDS+' inventoryItem { id '+LEVELS+' } }';
  const result = await connection(location,signal).postRead('/rest/s1/shopify/graphql',{
    shopId:location.shopId,
    queryText:'query StoreInventory($id: ID!, $location: ID!) { node(id: $id) { '+selection+' } }',
    variables:{id,location:'gid://shopify/Location/'+location.locationId},
  });
  const node = (result.response as {node?: ItemNode | VariantNode} | undefined)?.node;
  if (!node) throw new OmsLookupError('Shopify did not return inventory for this item.');
  const variant = byItem ? (node as ItemNode).variant : node as VariantNode;
  const inventoryItem = byItem ? node as ItemNode : variant?.inventoryItem;
  const quantities = inventoryItem?.inventoryLevel?.quantities ?? [];
  const quantity = (name: string) => quantities.find(entry=>entry.name===name)?.quantity ?? null;
  const itemId = inventoryItem?.id.split('/').at(-1) ?? item.itemId;
  const product = variant ? catalogVariant(variant,itemId) : item;
  const level: InventoryLevel = {available:quantity('available'),onHand:quantity('on_hand'),committed:quantity('committed'),checkedAt:Date.now()};
  return {product:{...product,sku:product.sku || item.sku,imageUrl:product.imageUrl ?? item.imageUrl},level};
}

function inventoryQuantity(value: string | number | null) {
  if (value==null || value==='') return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : null;
}

async function reservedQuantity(oms: OmsConnection, item: StockItem) {
  let page = item.reservations;
  let total = 0;
  while (true) {
    for (const edge of page.edges) {
      const quantity = inventoryQuantity(edge.node.quantity);
      if (quantity===null) throw new OmsLookupError('HotWax returned an incomplete reservation.');
      total += quantity;
    }
    if (!page.pageInfo.hasNextPage) return total;
    const after = page.pageInfo.endCursor;
    if (!after) throw new OmsLookupError('HotWax returned incomplete reservation results.');

    const result = await oms.graphqlRead<{inventoryItem: StockItem | null}>(`query StoreReservations($id: ID!, $after: String!) {
      inventoryItem(inventoryItemId: $id) {
        inventoryItemId productId facilityId
        reservations(first: 50, after: $after) { ${RESERVATION_FIELDS} }
      }
    }`,{id:item.inventoryItemId,after});
    const next = result.inventoryItem;
    if (!next || next.productId!==item.productId || next.facilityId!==item.facilityId ||
        next.reservations.pageInfo.endCursor===after) {
      throw new OmsLookupError('HotWax returned incomplete reservation results.');
    }
    page = next.reservations;
  }
}

export async function hotWaxInventoryLevel(location: Location, variantId: string, itemId: string | undefined, signal: AbortSignal): Promise<HotWaxLevel> {
  const oms = connection(location,signal);
  type Mapping = {shopId: string; shopifyProductId: string; shopifyInventoryItemId: string; productId: string};
  const {shopifyShopProducts} = await oms.graphqlRead<{shopifyShopProducts: GraphPage<Mapping>}>(`query StoreVariantMapping($filter: String!) {
    shopifyShopProducts(first: 2, query: $filter) {
      edges { node { shopId shopifyProductId shopifyInventoryItemId productId } }
      pageInfo { hasNextPage }
    }
  }`,{filter:`shopId:${JSON.stringify(location.shopId)} shopifyProductId:${JSON.stringify(variantId)}`});
  const mapping = shopifyShopProducts.edges[0]?.node;
  if (!mapping || shopifyShopProducts.edges.length!==1 || shopifyShopProducts.pageInfo.hasNextPage ||
      mapping.shopId!==location.shopId || mapping.shopifyProductId!==variantId || !mapping.productId ||
      (itemId && mapping.shopifyInventoryItemId!==itemId)) {
    throw new OmsLookupError('This variant does not have one confirmed HotWax product mapping.');
  }

  type FacilityStock = {productId: string; facilityId: string; inventoryItem: StockItem | null};
  const {productFacilities} = await oms.graphqlRead<{productFacilities: GraphPage<FacilityStock>}>(`query StoreFacilityStock($filter: String!) {
    productFacilities(first: 2, query: $filter) {
      edges { node {
        productId facilityId
        inventoryItem {
          inventoryItemId productId facilityId availableToPromiseTotal quantityOnHandTotal
          reservations(first: 50) { ${RESERVATION_FIELDS} }
        }
      } }
      pageInfo { hasNextPage }
    }
  }`,{filter:`facilityId:${JSON.stringify(location.facilityId)} productId:${JSON.stringify(mapping.productId)}`});
  const stock = productFacilities.edges[0]?.node;
  if (!stock || productFacilities.edges.length!==1 || productFacilities.pageInfo.hasNextPage ||
      stock.productId!==mapping.productId || stock.facilityId!==location.facilityId) {
    throw new OmsLookupError('HotWax has no confirmed inventory record for this product at this store.');
  }

  const item = stock.inventoryItem;
  const checkedAt = Date.now();
  if (!item) return {atp:0,reservations:0,onHand:0,checkedAt};
  if (item.productId!==stock.productId || item.facilityId!==stock.facilityId) {
    throw new OmsLookupError('HotWax returned inventory for a different product or store.');
  }
  const reservations = await reservedQuantity(oms,item).catch(()=>null);
  return {atp:inventoryQuantity(item.availableToPromiseTotal),reservations,
    onHand:inventoryQuantity(item.quantityOnHandTotal),checkedAt};
}
