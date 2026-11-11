import {configureDirectOms, OmsConnection, OmsLookupError, rows, text, type OmsRow} from '../../../shared/oms-connection';
import {shopFacility} from '../../../shared/oms-shop';
import {INVENTORY_OMS, type InventoryScope} from '../../../shared/store-inventory';
import {BASE, validId} from '../../../shared/oms-count';
import {productSearchDetails} from '../../../shared/oms-count-products';
import {reviewRows} from '../../../shared/oms-count-workflows';
import {readEventSources} from './InventoryEventSources';

export type Location = {
  shopId: string;
  productStoreId: string;
  locationId: string;
  facilityId: string;
  name: string;
  token: string;
};

export type Variant = {
  variantId?: string; itemId?: string; title: string; option?: string; sku?: string; barcode?: string;
  imageUrl?: string; available?: number | null; hotWaxProductId?: string;
};
export type InventoryEvent = {
  id: string; itemId: string; eventType: string; source: string; reference: string;
  at: number; syncedAt?: number; delta: number; state: string; product?: Variant;
  messageId: string; messageType: string; messageAt: number; reset: boolean;
};
export type InventoryLevel = {available: number | null; onHand: number | null; committed: number | null; checkedAt: number};
export type HotWaxLevel = {atp: number | null; reservations: number | null; onHand: number | null; checkedAt: number};
export type ProposedVariance = {
  id: string; product: Variant & {hotWaxProductId: string}; countName: string; counted: number; delta: number;
  lastUpdatedAt: number | null;
};
type GraphPage<Node> = {edges: {node: Node}[]; pageInfo: {hasNextPage: boolean; endCursor?: string | null}};
type Reservation = {quantity: string | number | null};
type StockItem = {
  inventoryItemId: string; productId: string; facilityId: string;
  availableToPromiseTotal: string | number | null; quantityOnHandTotal: string | number | null;
  reservations: GraphPage<Reservation>;
};
type Ledger = {details: unknown; hasMore?: boolean; detailCount?: number};
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
const LOCATION_MESSAGE = 'ShopifyLocationInventoryAdjustment';
const SYSTEM_MESSAGES = '/rest/s1/admin/systemMessages/';
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
  return {shopId:text(shop.shopId),productStoreId:text(shop.productStoreId),locationId:scope.locationId,
    facilityId,name:text(facility.facilityName),token:await oms.accessToken()};
}

export function inventoryConnection(location: Location, signal?: AbortSignal, readBudgetMs?: number) {
  return new OmsConnection({
    shopifySessionToken:'',shopifyLocationId:location.locationId,omsToken:location.token,signal,readBudgetMs,
  });
}

function locationLedgerPage(oms: OmsConnection, location: Location, pageIndex: number) {
  const query = new URLSearchParams({
    shopId:location.shopId,shopifyLocationId:location.locationId,mode:'RECENT',pageSize:'500',pageIndex:String(pageIndex),
  });
  return oms.get<Ledger>(LEDGER+'?'+query);
}

export async function recentInventoryEvents(location: Location, signal: AbortSignal, itemId?: string) {
  const oms = inventoryConnection(location,signal);
  const data = await locationLedgerPage(oms,location,0);
  if (!Array.isArray(data.details)) throw new OmsLookupError('HotWax returned an incomplete inventory ledger.');
  const events = rows(data.details)
    .filter(row=>text(row.shopId)===location.shopId && text(row.shopifyLocationId)===location.locationId &&
      (!itemId || text(row.shopifyInventoryItemId)===itemId))
    .map(readEvent);
  if (itemId) return events;
  const products = await ledgerProducts(oms,location.shopId,events);
  return events.map(event=>({...event,product:products.get(event.itemId)}));
}

export async function productSyncEvents(location: Location, itemId: string, signal: AbortSignal) {
  const oms = inventoryConnection(location,signal);
  const events: InventoryEvent[] = [];
  const seen = new Set<string>();
  let expectedCount: number | undefined;
  for (let index = 0; ; index++) {
    const page = await locationLedgerPage(oms,location,index);
    const entries = rows(page.details);
    if (!Array.isArray(page.details) || entries.length!==page.details.length ||
        !Number.isSafeInteger(page.detailCount) || typeof page.hasMore!=='boolean' ||
        (expectedCount!==undefined && page.detailCount!==expectedCount) || (page.hasMore && !entries.length)) {
      throw new OmsLookupError('HotWax could not verify the complete location ledger.');
    }
    expectedCount = page.detailCount;
    for (const row of entries) {
      const event = readEvent(row);
      const key = row.shopifyInventoryAdjustmentId && row.shopifyInventoryAdjustmentSeqId!=null
        ? JSON.stringify([row.shopifyInventoryAdjustmentId,row.shopifyInventoryAdjustmentSeqId])
        : JSON.stringify([event.id,event.at]);
      if (text(row.shopId)!==location.shopId || text(row.shopifyLocationId)!==location.locationId ||
          !event.itemId || !event.reference || seen.has(key)) {
        throw new OmsLookupError('The location ledger changed while loading.');
      }
      seen.add(key);
      if (text(row.shopifyInventoryItemId)!==itemId) continue;
      if (event.state==='Synced' || event.state==='Cancelled') continue;
      if (inventoryQuantity(row.computedInventoryChange)===null || !Number.isFinite(event.at) ||
          (event.eventType.endsWith('_RESET') && row.resetInventoryLevel==null)) {
        throw new OmsLookupError('A pending inventory change has incomplete quantities.');
      }
      events.push(event);
    }
    if (!page.hasMore) {
      if (seen.size!==expectedCount) throw new OmsLookupError('The location ledger changed while loading.');
      return events;
    }
  }
}

export function queuedInventoryBatches(events: InventoryEvent[]) {
  const batches = events.filter(event=>event.state==='Queued' && event.messageType===LOCATION_MESSAGE && event.messageId);
  batches.sort((left,right)=>left.messageAt-right.messageAt);
  return [...new Set(batches.map(event=>event.messageId))];
}

export type BatchProgress = {messageId: string; state: 'Sending' | 'Synced'; syncedAt?: number};

function batchMatchesItem(message: OmsRow, itemId: string, locationId: string) {
  if (message.isOutgoing!=='Y' || message.systemMessageTypeId!==LOCATION_MESSAGE) return false;
  try {
    const payload = JSON.parse(text(message.messageText));
    const input = payload.variables?.input;
    const targets = input?.changes ?? input?.quantities;
    const target = Array.isArray(targets) && targets.length===1 ? targets[0] : null;
    return target?.inventoryItemId==='gid://shopify/InventoryItem/'+itemId &&
      target?.locationId==='gid://shopify/Location/'+locationId;
  } catch {
    return false;
  }
}

export async function pushInventoryBatches(
  location: Location, itemId: string, reviewedIds: string[], inScope: () => boolean, signal: AbortSignal,
  onProgress: (progress: BatchProgress) => void,
) {
  const events = await recentInventoryEvents(location,signal,itemId);
  const messageIds = queuedInventoryBatches(events).filter(id=>reviewedIds.includes(id));
  const confirmed = new Set<string>();
  function confirm(messageId: string, syncedAt?: number) {
    if (confirmed.has(messageId)) return;
    confirmed.add(messageId);
    onProgress({messageId,state:'Synced',syncedAt});
  }
  for (const event of events) {
    if (event.state==='Synced' && event.messageType===LOCATION_MESSAGE && reviewedIds.includes(event.messageId)) {
      confirm(event.messageId,event.syncedAt);
    }
  }
  let error = '';
  for (const id of messageIds) {
    if (signal.aborted || !inScope()) break;
    const path = SYSTEM_MESSAGES+validId(id);
    const oms = inventoryConnection(location,signal);
    try {
      const batch = await oms.get(path);
      if (text(batch.systemMessageId)!==id || !batchMatchesItem(batch,itemId,location.locationId)) {
        error = 'The queued batch could not be matched to this product and store.';
        break;
      }
      if (batch.statusId==='SmsgSent') {
        confirm(id,inventoryQuantity(batch.processedDate) ?? undefined);
        continue;
      }
      if (batch.statusId!=='SmsgProduced') {
        error = 'The batch changed state. Refresh its status before trying again.';
        break;
      }
      if (signal.aborted || !inScope()) break;
      onProgress({messageId:id,state:'Sending'});
      let sendDenied = false;
      try {
        await oms.mutate(path+'/send',{systemMessageId:id});
      } catch (cause) {
        // The sender can complete after the request fails or times out.
        sendDenied = cause instanceof OmsLookupError && cause.status===403;
      }
      if (signal.aborted || !inScope()) break;
      const result = await inventoryConnection(location,signal).get(path);
      if (text(result.systemMessageId)!==id || result.statusId!=='SmsgSent') {
        error = sendDenied ? 'Your HotWax account cannot send this batch.'
          : 'Shopify delivery could not be confirmed. Refresh to check the batch.';
        break;
      }
      confirm(id,inventoryQuantity(result.processedDate) ?? undefined);
    } catch (cause) {
      error = cause instanceof OmsLookupError && cause.status===403
        ? 'Your HotWax account cannot access this batch.'
        : 'HotWax could not verify the batch. Refresh to check its status.';
      break;
    }
  }
  if (!error && confirmed.size!==reviewedIds.length) error = 'Some batches changed status. Refresh to check them.';
  return {sent:confirmed.size,error};
}

export function inventoryEventSources(location: Location, events: InventoryEvent[], signal: AbortSignal) {
  return readEventSources(inventoryConnection(location,signal),location.facilityId,events);
}

export async function proposedVariances(location: Location, signal: AbortSignal, productId?: string) {
  const oms = inventoryConnection(location,signal);
  const pageSize = 20;
  const awaitingApproval = 'CYCLE_CNT_CMPLTD';
  const counts = new Map<string, OmsRow>();
  for (let index = 0; ; index++) {
    const query = new URLSearchParams({
      facilityId:location.facilityId,statusId:awaitingApproval,pageSize:String(pageSize),
      pageIndex:String(index),orderByField:'-createdDate,workEffortId',
    });
    const result = await oms.get(`${BASE}/workEfforts?${query}`);
    const page = rows(result.cycleCounts);
    if (!Array.isArray(result.cycleCounts) || page.length!==result.cycleCounts.length) {
      throw new OmsLookupError('HotWax returned an incomplete list of submitted counts.');
    }
    for (const count of page) {
      const id = text(count.workEffortId);
      validId(id);
      if (text(count.facilityId)!==location.facilityId || count.statusId!==awaitingApproval || counts.has(id)) {
        throw new OmsLookupError('Submitted counts changed while loading. Refresh to try again.');
      }
      counts.set(id,count);
    }
    if (page.length<pageSize) break;
  }

  const byCount = await Promise.all([...counts].map(async ([id,count])=>{
    const proposals: ProposedVariance[] = [];
    const seen = new Set<string>();
    for (const row of await reviewRows(id,oms,productId)) {
      const hotWaxProductId = text(row.productId);
      validId(hotWaxProductId);
      if (text(row.workEffortId)!==id || text(row.facilityId)!==location.facilityId ||
          (productId && hotWaxProductId!==productId) || seen.has(hotWaxProductId)) {
        throw new OmsLookupError('Count reviews changed while loading. Refresh to try again.');
      }
      seen.add(hotWaxProductId);
      if (row.decisionOutcomeEnumId || row.quantity==null) continue;
      // Use the proposal the admin sees in HotWax's count review.
      const delta = inventoryQuantity(row.proposedVarianceQuantity);
      const counted = inventoryQuantity(row.quantity);
      if (delta===null || counted===null) throw new OmsLookupError('HotWax returned an incomplete variance.');
      if (delta===0) continue;
      const sku = text(row.internalName);
      const title = text(row.productName || sku || hotWaxProductId);
      const image = text(row.detailImageUrl);
      proposals.push({
        id:id+':'+hotWaxProductId,product:{hotWaxProductId,title,sku,imageUrl:/^https:\/\//i.test(image)?image:undefined},
        countName:text(count.workEffortName || count.description || id),counted,delta,
        lastUpdatedAt:inventoryQuantity(count.lastUpdatedStamp),
      });
    }
    return proposals;
  }));
  const proposals = byCount.flat();
  const missingImages = [...new Set(proposals.filter(({product})=>!product.imageUrl)
    .map(({product})=>product.hotWaxProductId))];
  if (!missingImages.length) return proposals;

  const imageLookup = inventoryConnection(location,signal);
  const requests = [];
  for (let offset = 0; offset < missingImages.length; offset += 200) {
    requests.push(productSearchDetails(missingImages.slice(offset,offset+200),{
      barcode:'',primary:'SKU',secondary:'productId',
    },imageLookup));
  }
  const images = new Map<string,string>();
  for (const result of await Promise.allSettled(requests)) {
    if (result.status!=='fulfilled') continue;
    for (const [id,product] of result.value) {
      if (/^https:\/\//i.test(product.imageUrl)) images.set(id,product.imageUrl);
    }
  }
  return proposals.map(proposal=>{
    const {product} = proposal;
    const imageUrl = product.imageUrl ?? images.get(product.hotWaxProductId);
    return {...proposal,product:{...product,imageUrl}};
  });
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
    messageId:message,messageType:text(row.systemMessageTypeId),messageAt:Number(row.systemMessageInitDate ?? row.createdDate),
    reset:row.resetInventoryLevel==='Y',
    syncedAt:message && status==='SmsgSent' && row.systemMessageProcessedDate!=null
      ? Number(row.systemMessageProcessedDate) : undefined,
  };
}

export async function searchInventory(location: Location, query: string, barcode: string, signal: AbortSignal, after?: string) {
  const quoted = JSON.stringify(query.slice(0,120).replace(/\s+/g,' '));
  const filter = barcode ? 'barcode:'+quoted : '('+quoted+' OR sku:'+quoted+' OR barcode:'+quoted+')';
  const result = await inventoryConnection(location,signal).postRead('/rest/s1/shopify/graphql',{
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
  const result = await inventoryConnection(location,signal).postRead('/rest/s1/shopify/graphql',{
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

function inventoryQuantity(value: unknown) {
  if ((typeof value!=='number' && typeof value!=='string') || value==='') return null;
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

export async function shopifyVariantForHotWaxProduct(location: Location, product: Variant, signal: AbortSignal) {
  const productId = text(product.hotWaxProductId);
  const query = new URLSearchParams({shopId:location.shopId,pageSize:'2'});
  const result = await inventoryConnection(location,signal).get<unknown>(
    '/rest/s1/sob/products/'+validId(productId)+'/shopifyShopProducts?'+query,
  );
  const matches = rows(result);
  if (!Array.isArray(result) || matches.length!==result.length) {
    throw new OmsLookupError('HotWax returned an incomplete Shopify product mapping.');
  }
  if (!matches.length) return;
  const mapping = matches[0];
  const variantId = text(mapping.shopifyProductId);
  const itemId = text(mapping.shopifyInventoryItemId);
  if (matches.length!==1 || text(mapping.shopId)!==location.shopId || text(mapping.productId)!==productId ||
      !/^\d+$/.test(variantId) || (itemId && !/^\d+$/.test(itemId))) {
    throw new OmsLookupError('This product does not have one confirmed Shopify variant mapping.');
  }
  return {...product,variantId,itemId:itemId || undefined};
}

export async function hotWaxProductForVariant(location: Location, variantId: string, itemId: string | undefined, signal: AbortSignal) {
  const oms = inventoryConnection(location,signal);
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
  return mapping.productId;
}

export async function hotWaxInventoryLevel(location: Location, productId: string, signal: AbortSignal): Promise<HotWaxLevel> {
  const oms = inventoryConnection(location,signal);
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
  }`,{filter:`facilityId:${JSON.stringify(location.facilityId)} productId:${JSON.stringify(productId)}`});
  const stock = productFacilities.edges[0]?.node;
  if (!stock || productFacilities.edges.length!==1 || productFacilities.pageInfo.hasNextPage ||
      stock.productId!==productId || stock.facilityId!==location.facilityId) {
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
