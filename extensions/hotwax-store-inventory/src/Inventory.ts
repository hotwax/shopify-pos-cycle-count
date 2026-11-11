import {configureDirectOms, OmsConnection, OmsLookupError, rows, text, type OmsRow} from '../../../shared/oms-connection';
import {shopFacility} from '../../../shared/oms-shop';
import {INVENTORY_OMS, type InventoryScope} from '../../../shared/store-inventory';

type Location = {
  shopId: string;
  locationId: string;
  name: string;
  timeZone?: string;
  token: string;
};

export type Variant = {variantId?: string; itemId?: string; title: string; option?: string; sku?: string; barcode?: string; imageUrl?: string};
export type InventoryEvent = {id: string; itemId: string; source: string; reference: string; at: number; delta: number; state: string; product?: Variant};
export type InventoryLevel = {available: number | null; onHand: number | null; committed: number | null; checkedAt: number};
type Ledger = {details: unknown; hasMore?: boolean};
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
const VARIANT_FIELDS = 'id title sku product { title }';
const SEARCH_IMAGE = 'preview { image { url(transform: {maxWidth: 144, maxHeight: 144}) } }';

export async function inventoryLocation(scope: InventoryScope, getSessionToken: () => Promise<string | undefined>, signal: AbortSignal): Promise<Location> {
  const token = await getSessionToken();
  if (!token || signal.aborted) throw new OmsLookupError('Your Shopify session is unavailable. Reopen Store inventory.', 401);
  configureDirectOms(INVENTORY_OMS);
  const oms = new OmsConnection({shopifySessionToken:token,shopifyLocationId:scope.locationId,signal});
  const {shop,facilityId} = await shopFacility(oms, 'https://'+scope.shopDomain, scope.locationId);
  if (!facilityId) throw new OmsLookupError('This Shopify location has no HotWax facility.');
  const facility = await oms.get('/rest/s1/admin/facilities/'+encodeURIComponent(facilityId));
  return {shopId:text(shop.shopId),locationId:scope.locationId,name:text(facility.facilityName),
    timeZone:text(facility.facilityTimeZone),token:await oms.accessToken()};
}

function connection(location: Location, signal?: AbortSignal) {
  return new OmsConnection({shopifySessionToken:'',shopifyLocationId:location.locationId,omsToken:location.token,signal});
}

export async function inventoryEvents(location: Location, mode: 'RECENT' | 'UNASSIGNED_NONZERO', page: number, signal: AbortSignal) {
  const query = new URLSearchParams({shopId:location.shopId,shopifyLocationId:location.locationId,mode,pageSize:'20',pageIndex:String(page)});
  const oms = connection(location,signal);
  const data = await oms.get<Ledger>(LEDGER+'?'+query);
  if (!Array.isArray(data.details)) throw new OmsLookupError('HotWax returned an incomplete inventory ledger.');
  const events = rows(data.details)
    .filter(row=>text(row.shopId)===location.shopId && text(row.shopifyLocationId)===location.locationId)
    .map(readEvent);
  const products = await ledgerProducts(oms,location.shopId,events).catch(()=>new Map<string,Variant>());
  return {events:events.map(event=>({...event,product:products.get(event.itemId)})),hasMore:data.hasMore===true};
}

async function ledgerProducts(oms: OmsConnection, shopId: string, events: InventoryEvent[]) {
  const ids = [...new Set(events.map(event=>event.itemId).filter(id=>/^\d+$/.test(id)))];
  const products = new Map<string,Variant>();
  if (!ids.length) return products;

  const result = await oms.postRead('/rest/s1/shopify/graphql',{
    shopId,
    queryText:'query InventoryItems($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id variant { '+VARIANT_FIELDS+' } } } }',
    variables:{ids:ids.map(id=>'gid://shopify/InventoryItem/'+id)},
  });
  const nodes = (result.response as {nodes?: (ItemNode | null)[]} | undefined)?.nodes ?? [];
  for (const node of nodes) {
    if (!node?.variant) continue;
    const itemId = node.id.split('/').at(-1)!;
    products.set(itemId,{
      itemId,variantId:node.variant.id.split('/').at(-1),title:node.variant.product.title,
      option:node.variant.title==='Default Title' ? undefined : node.variant.title,sku:node.variant.sku,
    });
  }
  return products;
}

function readEvent(row: OmsRow): InventoryEvent {
  const itemId = text(row.shopifyInventoryItemId);
  const reference = text(row.eventReferenceId);
  const delta = Number(row.computedInventoryChange ?? 0);
  const states: Record<string,string> = {
    SmsgProduced:'Ready to send',SmsgSending:'Sending',SmsgError:'Needs attention',
    SmsgSent:'Sent',SmsgCancelled:'Cancelled',
  };
  const message = text(row.systemMessageId);
  const status = text(row.systemMessageStatusId);
  return {
    id:[text(row.eventTypeId),reference,itemId].join(':'),
    itemId,reference,delta,at:Number(row.createdDate),
    source:text(row.eventTypeDescription || row.eventTypeId),
    state:message ? states[status] || 'Assigned' : delta ? 'Queued' : 'No change',
  };
}

export async function searchInventory(location: Location, query: string, barcode: string, signal: AbortSignal, after?: string) {
  const quoted = JSON.stringify(query.slice(0,120).replace(/\s+/g,' '));
  const filter = barcode ? 'barcode:'+quoted : '('+quoted+' OR sku:'+quoted+' OR barcode:'+quoted+')';
  const result = await connection(location,signal).postRead('/rest/s1/shopify/graphql',{
    shopId:location.shopId,
    queryText:`query StoreInventorySearch($after: String, $filter: String!) {
      productVariants(first: 20, after: $after, query: $filter) {
        nodes {
          id title sku barcode inventoryItem { id }
          media(first: 1) { nodes { ${SEARCH_IMAGE} } }
          product { title featuredMedia { ${SEARCH_IMAGE} } }
        }
        pageInfo { endCursor hasNextPage }
      }
    }`,
    variables:{after:after ?? null,filter},
  });
  const page = (result.response as {productVariants?: {
    nodes: VariantNode[]; pageInfo: {endCursor?: string; hasNextPage: boolean};
  }} | undefined)?.productVariants;
  if (!page || !Array.isArray(page.nodes)) throw new OmsLookupError('Shopify returned incomplete product results.');
  const items = page.nodes.filter(node=>!barcode || node.barcode===barcode).map(node=>({
    title:node.product.title,option:node.title==='Default Title'?undefined:node.title,sku:node.sku,barcode:node.barcode,
    variantId:node.id.split('/').at(-1),itemId:node.inventoryItem?.id.split('/').at(-1),
    imageUrl:node.media?.nodes[0]?.preview?.image?.url ?? node.product.featuredMedia?.preview?.image?.url,
  }));
  return {items,cursor:page.pageInfo.hasNextPage?page.pageInfo.endCursor:undefined};
}

export async function inventoryLevel(location: Location, item: Variant, signal: AbortSignal) {
  const byItem = Boolean(item.itemId);
  const id = byItem ? 'gid://shopify/InventoryItem/'+item.itemId : 'gid://shopify/ProductVariant/'+item.variantId;
  const selection = byItem
    ? '... on InventoryItem { id '+LEVELS+' variant { '+VARIANT_FIELDS+' } }'
    : '... on ProductVariant { '+VARIANT_FIELDS+' inventoryItem { id '+LEVELS+' } }';
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
  const product: Variant = {
    variantId:variant?.id.split('/').at(-1) ?? item.variantId,
    itemId:inventoryItem?.id.split('/').at(-1) ?? item.itemId,
    title:variant?.product.title ?? item.title,
    option:variant?.title==='Default Title' ? undefined : variant?.title ?? item.option,
    sku:variant?.sku || item.sku,
  };
  const level: InventoryLevel = {available:quantity('available'),onHand:quantity('on_hand'),committed:quantity('committed'),checkedAt:Date.now()};
  return {product,level};
}
