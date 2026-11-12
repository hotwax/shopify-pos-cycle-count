import {configureDirectOms, OmsConnection, OmsLookupError, rows, text, type OmsRow} from '../../../shared/oms-connection';
import {shopFacility} from '../../../shared/oms-shop';
import {type InventoryScope} from '../../../shared/store-inventory';
import {getShopOmsUrl} from '../../../shared/oms-shop-config';
import {LOCAL_OMS_PREVIEW} from '../../../shared/oms-build-config';
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
  session: OmsSession;
  /** The staff member's HotWax account has STORE_INV_PUSH. */
  canPush: boolean;
};
export type OmsSession = {token: () => Promise<string>};

export type Variant = {
  variantId?: string; itemId?: string; title: string; option?: string; sku?: string; barcode?: string;
  imageUrl?: string; available?: number | null; hotWaxProductId?: string;
};
/** Where an event's delivery stands. Waiting covers events not yet batched and queued batches. */
export type EventState = 'Unbatched' | 'Queued' | 'Sending' | 'Sent' | 'Cancelled' | 'Error' | 'Missing';
export type InventoryEvent = {
  id: string; itemId: string; eventType: string; source: string; reference: string;
  at: number; syncedAt?: number; delta: number; state: EventState; product?: Variant;
  messageId: string; messageType: string; messageAt: number; reset: boolean;
  adjustmentId: string;
  failCount: number; lastAttemptAt?: number;
};
export type EventFilter = {
  status: 'unsent' | 'attention' | 'all'; eventType?: string; since?: number; oldestFirst?: boolean;
};
export const DEFAULT_FILTER: EventFilter = {status:'unsent'};
export type InventorySyncSummary = {
  checkedAt: number;
  pendingCount: number;
  attentionCount: number;
  /** Creation time of the oldest change not yet delivered to Shopify. */
  oldestPendingAt: number | null;
  syncedCount: number;
  averageSyncMs: number | null;
  byType: {eventType: string; label: string; count: number; added: number; removed: number}[];
  hasResets: boolean;
};
export type InventoryLevel = {available: number | null; onHand: number | null; committed: number | null; checkedAt: number};
export type HotWaxLevel = {atp: number | null; reservations: number | null; onHand: number | null; checkedAt: number};
export type ProposedVariance = {
  id: string; product: Variant & {hotWaxProductId: string; inShopify: boolean}; countName: string; counted: number; delta: number;
  lastUpdatedAt: number | null;
};
type GraphPage<Node> = {edges: {node: Node}[]; pageInfo: {hasNextPage: boolean; endCursor?: string | null}};
type Reservation = {quantity: string | number | null};
type StockItem = {
  inventoryItemId: string; productId: string; facilityId: string;
  availableToPromiseTotal: string | number | null; quantityOnHandTotal: string | number | null;
  reservations: GraphPage<Reservation>;
};
type Quantities = {name: string; quantity: number}[];
type ItemNode = {id: string; inventoryLevel?: {quantities: Quantities}; variant?: VariantNode};
type MediaPreview = {preview?: {image?: {url: string} | null} | null};
type VariantNode = {
  id: string; title: string; sku?: string; barcode?: string;
  product: {title: string; featuredMedia?: MediaPreview | null};
  inventoryItem?: ItemNode;
  media?: {nodes: MediaPreview[]};
};

/** This store's inventory changes: the physical-location ledger. */
const LEDGER = '/rest/s1/sob/shopify/locationInventoryAdjustmentDetails';
/** Before shopify-connector v4.6.0, one message per location and item. */
const LOCATION_MESSAGE = 'ShopifyLocationInventoryAdjustment';
/** From v4.6.0, one message per event: every change in it, including other products and locations. */
const EVENT_MESSAGE = 'ShopifyInventoryAdjustment';
const PUSHABLE = new Set([LOCATION_MESSAGE,EVENT_MESSAGE]);
const SYSTEM_MESSAGES = '/rest/s1/admin/systemMessages/';
export const PUSH_PERMISSION = 'STORE_INV_PUSH';
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
/** OMS tokens last two hours by default; renew well before that on a register left open. */
const RENEW_AFTER = 60*60*1000;

/** An OMS token that renews itself through the Shopify session once it is an hour old. */
export function omsSession(first: string, login: () => Promise<string>, now: () => number = Date.now): OmsSession {
  let current = {token:Promise.resolve(first),at:now()};
  return {token() {
    if (now()-current.at>=RENEW_AFTER) {
      const token = login();
      const renewal = {token,at:now()};
      current = renewal;
      // A failed renewal is retried by the next read rather than kept.
      token.catch(()=>{if (current===renewal) current = {token,at:-Infinity};});
    }
    return current.token;
  }};
}

export async function inventoryLocation(scope: InventoryScope, getSessionToken: () => Promise<string | undefined>, signal: AbortSignal): Promise<Location> {
  const sessionToken = async () => {
    const token = await getSessionToken();
    if (!token) throw new OmsLookupError('Your Shopify session is unavailable. Reopen Store inventory.', 401);
    return token;
  };
  const token = await sessionToken();
  if (signal.aborted) throw new OmsLookupError('Store inventory was closed while opening.', 401);
  // The shop's OMS address from its HotWax setup (App Home), the same setting Cycle count uses.
  configureDirectOms(await getShopOmsUrl(signal, LOCAL_OMS_PREVIEW), LOCAL_OMS_PREVIEW);
  const oms = new OmsConnection({shopifySessionToken:token,shopifyLocationId:scope.locationId,signal});
  const [{shop,facilityId},permissions] = await Promise.all([
    shopFacility(oms, 'https://'+scope.shopDomain, scope.locationId),
    oms.get('/rest/s1/admin/user/permissions?'+new URLSearchParams({viewSize:'20',permissionIds:PUSH_PERMISSION})),
  ]);
  if (!facilityId) throw new OmsLookupError('This Shopify location has no HotWax facility.');
  const facility = await oms.get('/rest/s1/admin/facilities/'+encodeURIComponent(facilityId));
  const login = async () => new OmsConnection({shopifySessionToken:await sessionToken(),shopifyLocationId:scope.locationId}).accessToken();
  return {shopId:text(shop.shopId),productStoreId:text(shop.productStoreId),locationId:scope.locationId,
    facilityId,name:text(facility.facilityName),session:omsSession(await oms.accessToken(),login),
    canPush:rows(permissions.docs).some(row=>text(row.permissionId)===PUSH_PERMISSION)};
}

export function inventoryConnection(location: Location, signal?: AbortSignal, readBudgetMs?: number) {
  return new OmsConnection({
    shopifySessionToken:'',shopifyLocationId:location.locationId,omsLogin:location.session.token,signal,readBudgetMs,
  });
}

// The ledger is an entity list (shopify-connector v4.4.0+): a bare array of rows, filtered by its
// fields and paged with pageIndex/pageSize. A page shorter than LEDGER_PAGE is the last one.
const LEDGER_PAGE = 500;
const KEY_ORDER = 'shopifyInventoryAdjustmentId,shopifyInventoryAdjustmentSeqId';
/** Not delivered yet: no message, a message still in flight or failed, or one whose record was purged.
 * Sent rows are pruned after five days, so this set stays small. */
const UNSENT = {systemMessageStatusId:'SmsgSent,SmsgConfirmed,SmsgCancelled',systemMessageStatusId_op:'in',systemMessageStatusId_not:'Y'};

function ledgerQuery(location: Location, filter: EventFilter, itemId?: string): Record<string,string> {
  return {
    shopId:location.shopId,
    shopifyLocationId:location.locationId,
    ...(itemId ? {shopifyInventoryItemId:itemId} : {}),
    ...(filter.status==='all' ? {} : UNSENT),
    ...(filter.eventType ? {eventTypeId:filter.eventType} : {}),
    ...(filter.since ? {createdDate_from:String(filter.since)} : {}),
  };
}

async function ledgerPage(oms: OmsConnection, query: Record<string,string>, pageIndex: number, orderByField: string) {
  const params = new URLSearchParams({...query,orderByField,pageSize:String(LEDGER_PAGE),pageIndex:String(pageIndex)});
  const page = await oms.get<unknown>(LEDGER+'?'+params);
  const entries = rows(page);
  if (!Array.isArray(page) || entries.length!==page.length) throw new OmsLookupError('HotWax returned an incomplete inventory ledger.');
  return entries;
}

function inScope(row: OmsRow, location: Location, itemId?: string) {
  return text(row.shopId)===location.shopId && text(row.shopifyLocationId)===location.locationId &&
    (!itemId || text(row.shopifyInventoryItemId)===itemId);
}

/** The first page of events matching the filter, newest first unless asked otherwise. `more` is true when
 * the filter matches more events than one page holds. */
export async function recentInventoryEvents(location: Location, signal: AbortSignal, filter: EventFilter = DEFAULT_FILTER, itemId?: string) {
  const oms = inventoryConnection(location,signal);
  const order = (filter.oldestFirst ? 'createdDate,' : '-createdDate,')+KEY_ORDER;
  const page = await ledgerPage(oms,ledgerQuery(location,filter,itemId),0,order);
  let events = page.filter(row=>inScope(row,location,itemId)).map(readEvent);
  if (filter.status==='attention') events = events.filter(event=>event.state==='Error' || event.state==='Missing');
  const more = page.length===LEDGER_PAGE;
  if (itemId) return {events,more};
  const products = await ledgerProducts(oms,location.shopId,events);
  return {events:events.map(event=>({...event,product:products.get(event.itemId)})),more};
}

async function* completeLedger(location: Location, signal: AbortSignal, query: Record<string,string>, itemId?: string) {
  const oms = inventoryConnection(location,signal);
  const seen = new Set<string>();
  for (let index = 0; ; index++) {
    // Key order keeps pages stable; a row seen twice means the ledger shifted between pages.
    const entries = await ledgerPage(oms,query,index,KEY_ORDER);
    for (const row of entries) {
      const event = readEvent(row);
      const key = JSON.stringify([row.shopifyInventoryAdjustmentId,row.shopifyInventoryAdjustmentSeqId]);
      if (!inScope(row,location,itemId) || !event.itemId || !event.adjustmentId || seen.has(key)) {
        throw new OmsLookupError('The location ledger changed while loading.');
      }
      seen.add(key);
      yield {row,event};
    }
    if (entries.length<LEDGER_PAGE) return;
  }
}

/** Every change for this item at this location that Shopify has not confirmed yet. */
export async function productSyncEvents(location: Location, itemId: string, signal: AbortSignal) {
  const events: InventoryEvent[] = [];
  for await (const {row,event} of completeLedger(location,signal,ledgerQuery(location,DEFAULT_FILTER,itemId),itemId)) {
    if (inventoryQuantity(row.computedInventoryChange)===null || !Number.isFinite(event.at) ||
        (event.eventType.endsWith('_RESET') && row.resetInventoryLevel==null)) {
      throw new OmsLookupError('A pending inventory change has incomplete quantities.');
    }
    events.push(event);
  }
  return events;
}

export async function inventorySyncSummary(location: Location, signal: AbortSignal): Promise<InventorySyncSummary> {
  const checkedAt = Date.now();
  const since = checkedAt-60*60*1000;
  const byType = new Map<string,InventorySyncSummary['byType'][number]>();
  let hasResets = false, pendingCount = 0, attentionCount = 0, syncedCount = 0, totalSyncMs = 0, timedEvents = 0;
  let oldestPendingAt: number | null = null;
  for await (const {event} of completeLedger(location,signal,ledgerQuery(location,DEFAULT_FILTER))) {
    pendingCount++;
    if (event.state==='Error' || event.state==='Missing') attentionCount++;
    if (Number.isFinite(event.at) && event.at>0) oldestPendingAt = Math.min(oldestPendingAt ?? event.at,event.at);
  }
  // Only what Shopify confirmed in the last hour; older events can still have synced in it.
  const synced = {shopId:location.shopId,shopifyLocationId:location.locationId,
    systemMessageStatusId:'SmsgSent',systemMessageProcessedDate_from:String(since)};
  for await (const {row,event} of completeLedger(location,signal,synced)) {
    const syncedAt = inventoryQuantity(row.systemMessageProcessedDate);
    if (event.state!=='Sent' || syncedAt===null || syncedAt<since || syncedAt>checkedAt) continue;
    syncedCount++;
    const totals = byType.get(event.eventType) ?? {eventType:event.eventType,label:event.source,count:0,added:0,removed:0};
    totals.count++;
    if (event.reset) {
      hasResets = true;
    } else {
      const delta = inventoryQuantity(row.computedInventoryChange);
      if (delta===null) throw new OmsLookupError('A synced inventory change has an incomplete quantity.');
      totals.added += Math.max(delta,0);
      totals.removed += Math.max(-delta,0);
    }
    if (Number.isFinite(event.at) && event.at>0 && event.at<=syncedAt) {
      totalSyncMs += syncedAt-event.at;
      timedEvents++;
    }
    byType.set(event.eventType,totals);
  }
  return {checkedAt,pendingCount,attentionCount,oldestPendingAt,syncedCount,
    averageSyncMs:timedEvents ? totalSyncMs/timedEvents : null,hasResets,
    byType:[...byType.values()].sort((left,right)=>right.count-left.count || left.label.localeCompare(right.label))};
}

/** Queued batches carrying these events, oldest first. */
export function queuedInventoryBatches(events: InventoryEvent[]) {
  const batches = events.filter(event=>event.state==='Queued' && PUSHABLE.has(event.messageType) && event.messageId);
  batches.sort((left,right)=>left.messageAt-right.messageAt);
  return [...new Set(batches.map(event=>event.messageId))];
}

export type BatchProgress = {messageId: string; state: 'Sending' | 'Sent'; syncedAt?: number};

/** A queued message belongs to this item at this location: an older per-item message names exactly this
 * item and location; an event message carries the event header these ledger rows belong to. */
export function batchMatchesItem(message: OmsRow, itemId: string, locationId: string, adjustmentIds: Set<string>) {
  if (message.isOutgoing!=='Y' || !PUSHABLE.has(text(message.systemMessageTypeId))) return false;
  try {
    const payload = JSON.parse(text(message.messageText));
    if (message.systemMessageTypeId===EVENT_MESSAGE) {
      return payload?.format==='header' && Array.isArray(payload.calls) && adjustmentIds.has(text(payload.shopifyInventoryAdjustmentId));
    }
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
  if (!location.canPush) return {sent:0,error:'Your HotWax account cannot send inventory batches.'};
  const events = await productSyncEvents(location,itemId,signal);
  const messageIds = queuedInventoryBatches(events).filter(id=>reviewedIds.includes(id));
  const confirmed = new Set<string>();
  function confirm(messageId: string, syncedAt?: number) {
    if (confirmed.has(messageId)) return;
    confirmed.add(messageId);
    onProgress({messageId,state:'Sent',syncedAt});
  }
  // A reviewed batch no longer unsent was delivered by the scheduled sender meanwhile; it is checked below.
  for (const id of reviewedIds) if (!messageIds.includes(id) && !events.some(event=>event.messageId===id)) messageIds.push(id);
  let error = '';
  for (const id of messageIds) {
    if (signal.aborted || !inScope()) break;
    const path = SYSTEM_MESSAGES+validId(id);
    const oms = inventoryConnection(location,signal);
    const adjustments = new Set(events.filter(event=>event.messageId===id).map(event=>event.adjustmentId));
    try {
      const batch = await oms.get(path);
      if (text(batch.systemMessageId)!==id) {
        error = 'The queued batch could not be found. Refresh to check it.';
        break;
      }
      if (batch.statusId==='SmsgSent') {
        confirm(id,inventoryQuantity(batch.processedDate) ?? undefined);
        continue;
      }
      if (!batchMatchesItem(batch,itemId,location.locationId,adjustments)) {
        error = 'The queued batch could not be matched to this product and store.';
        break;
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

/** Why a message failed, newest first, for an event that needs attention. */
export async function deliveryErrors(location: Location, messageId: string, signal: AbortSignal) {
  const result = await inventoryConnection(location,signal).get<unknown>(SYSTEM_MESSAGES+validId(messageId)+'/errors?'+
    new URLSearchParams({orderByField:'-errorDate',pageSize:'3'}));
  return rows(result).map(row=>({at:inventoryQuantity(row.errorDate),text:text(row.errorText).slice(0,300)}))
    .filter(entry=>entry.text);
}

export function inventoryEventSources(location: Location, events: InventoryEvent[], signal: AbortSignal) {
  return readEventSources(inventoryConnection(location,signal),location.facilityId,events);
}

/** Runs tasks with at most `limit` in flight, keeping their order. */
export async function limited<T,R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while (next<items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

async function sessionTotals(oms: OmsConnection, countId: string, productId?: string) {
  const totals = new Map<string,number>();
  for (let index = 0; index <= 1000; index++) {
    const params = new URLSearchParams({pageSize:'500',pageIndex:String(index),orderByField:'productId,inventoryCountImportId'});
    if (productId) params.set('productId',productId);
    const found = await oms.get<unknown>(`${BASE}/workEfforts/${validId(countId)}/count?${params}`);
    if (!Array.isArray(found) || rows(found).length!==found.length) throw new OmsLookupError('Session totals could not be loaded.');
    for (const row of rows(found)) {
      if (text(row.statusId)==='SESSION_VOIDED' || row.counted==null) continue;
      const quantity = inventoryQuantity(row.counted);
      if (quantity===null) throw new OmsLookupError('HotWax returned an incomplete session quantity.');
      totals.set(text(row.productId),(totals.get(text(row.productId)) ?? 0)+quantity);
    }
    if (found.length<500) return totals;
  }
  throw new OmsLookupError('Session totals could not be fully loaded.');
}

export async function proposedVariances(location: Location, signal: AbortSignal, productId?: string) {
  const oms = inventoryConnection(location,signal);
  const pageSize = 100;
  const awaitingApproval = 'CYCLE_CNT_CMPLTD';
  const counts = new Map<string, OmsRow>();
  // The count list sorts by creation time only, so rows created together can repeat across pages.
  for (let index = 0; index <= 100; index++) {
    const query = new URLSearchParams({facilityId:location.facilityId,statusId:awaitingApproval,pageSize:String(pageSize),pageIndex:String(index)});
    const result = await oms.get(`${BASE}/workEfforts?${query}`);
    const page = rows(result.cycleCounts);
    if (!Array.isArray(result.cycleCounts) || page.length!==result.cycleCounts.length) {
      throw new OmsLookupError('HotWax returned an incomplete list of submitted counts.');
    }
    for (const count of page) {
      const id = text(count.workEffortId);
      validId(id);
      if (text(count.facilityId)!==location.facilityId || count.statusId!==awaitingApproval) {
        throw new OmsLookupError('Submitted counts changed while loading. Refresh to try again.');
      }
      counts.set(id,count);
    }
    if (page.length<pageSize) break;
  }

  const byCount = await limited([...counts],4,async ([id,count])=>{
    // /reviews sums quantities after joining prices and stores, which can multiply them; take the counted
    // total from the sessions and the system quantity from the review.
    const [reviewed,totals] = await Promise.all([reviewRows(id,oms,productId),sessionTotals(oms,id,productId)]);
    const proposals: {id: string; productId: string; count: OmsRow; counted: number; delta: number}[] = [];
    const seen = new Set<string>();
    for (const row of reviewed) {
      const hotWaxProductId = text(row.productId);
      validId(hotWaxProductId);
      if (text(row.workEffortId)!==id || text(row.facilityId)!==location.facilityId ||
          (productId && hotWaxProductId!==productId) || seen.has(hotWaxProductId)) {
        throw new OmsLookupError('Count reviews changed while loading. Refresh to try again.');
      }
      seen.add(hotWaxProductId);
      const counted = totals.get(hotWaxProductId);
      if (row.decisionOutcomeEnumId || counted===undefined) continue;
      const delta = counted-(inventoryQuantity(row.systemQuantityOnHand) ?? 0);
      if (delta===0) continue;
      proposals.push({id:id+':'+hotWaxProductId,productId:hotWaxProductId,count,counted,delta});
    }
    return proposals;
  });
  const found = byCount.flat();
  const ids = [...new Set(found.map(proposal=>proposal.productId))];
  const details = new Map<string,{title: string; sku: string; imageUrl: string}>();
  const lookups = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    lookups.push(productSearchDetails(ids.slice(offset,offset+200),{
      barcode:'',primary:'SKU',secondary:'productId',
    },oms));
  }
  for (const result of await Promise.allSettled(lookups)) {
    if (result.status==='fulfilled') for (const [id,product] of result.value) details.set(id,product);
  }
  const mapped = await shopifyMappedProducts(oms,location.shopId,ids).catch(()=>undefined);
  return found.map(({id,productId:hotWaxProductId,count,counted,delta}): ProposedVariance=>{
    const detail = details.get(hotWaxProductId);
    const image = text(detail?.imageUrl);
    return {
      id,counted,delta,countName:text(count.workEffortName || count.description || id),
      lastUpdatedAt:inventoryQuantity(count.lastUpdatedStamp),
      product:{hotWaxProductId,title:detail?.title || detail?.sku || hotWaxProductId,sku:detail?.sku,
        imageUrl:/^https:\/\//i.test(image) ? image : undefined,inShopify:mapped ? mapped.has(hotWaxProductId) : true},
    };
  });
}

/** Which of these HotWax products have a variant in this Shopify shop, from the product search index.
 * A product can have more than one search document, so their identifications are merged. */
async function shopifyMappedProducts(oms: OmsConnection, shopId: string, productIds: string[]) {
  const mapped = new Set<string>();
  const ids = productIds.filter(id=>/^[\w.-]+$/.test(id));
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start,start+100);
    const result = await oms.postRead('/rest/s1/admin/search/query',{
      collection:'enterpriseSearch',query:'*:*',fields:'productId,goodIdentifications',
      filter:['docType:PRODUCT','productId:('+batch.map(id=>JSON.stringify(id)).join(' OR ')+')'],params:{rows:batch.length*4},
    });
    const outer = result.response as OmsRow | undefined;
    const found = (outer?.response || outer) as OmsRow | undefined;
    if (!Array.isArray(found?.docs) || Number(found.numFound)>found.docs.length) throw new OmsLookupError('Product search returned incomplete results.');
    for (const doc of rows(found.docs)) {
      const identifications = Array.isArray(doc.goodIdentifications) ? doc.goodIdentifications.map(text) : [];
      if (identifications.some(value=>value.startsWith('ShopifyShopProduct/'+shopId+'/'))) mapped.add(text(doc.productId));
    }
  }
  return mapped;
}

async function ledgerProducts(oms: OmsConnection, shopId: string, events: InventoryEvent[]) {
  const ids = [...new Set(events.map(event=>event.itemId).filter(id=>/^\d+$/.test(id)))];
  const products = new Map<string,Variant>();
  const requests = [];
  for (let start=0; start<ids.length; start+=50) {
    requests.push(shopifyRead<{nodes?: (ItemNode | null)[]}>(oms,shopId,`query InventoryItems($ids: [ID!]!) {
      nodes(ids: $ids) { ... on InventoryItem { id variant { ${CATALOG_VARIANT_FIELDS} } } }
    }`,{ids:ids.slice(start,start+50).map(id=>'gid://shopify/InventoryItem/'+id)}));
  }
  for (const result of await Promise.allSettled(requests)) {
    if (result.status!=='fulfilled') continue;
    for (const node of result.value.nodes ?? []) {
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

const STATES: Record<string,EventState> = {
  SmsgProduced:'Queued',SmsgSending:'Sending',SmsgError:'Error',SmsgSent:'Sent',SmsgConfirmed:'Sent',SmsgCancelled:'Cancelled',
};

export function readEvent(row: OmsRow): InventoryEvent {
  const itemId = text(row.shopifyInventoryItemId);
  const reference = text(row.eventReferenceId);
  const delta = Number(row.computedInventoryChange ?? 0);
  const message = text(row.systemMessageId);
  const status = text(row.systemMessageStatusId);
  // A message older than 30 days is purged while its event row stays; its delivery is then unknown.
  const state: EventState = !message ? 'Unbatched' : !status ? 'Missing' : STATES[status] ?? 'Queued';
  return {
    id:[text(row.shopifyInventoryAdjustmentId),text(row.shopifyInventoryAdjustmentSeqId)].join(':'),
    itemId,reference,delta,at:Number(row.createdDate),eventType:text(row.eventTypeId),
    source:text(row.eventTypeDescription || row.eventTypeId),state,
    messageId:message,messageType:text(row.systemMessageTypeId),messageAt:Number(row.systemMessageInitDate ?? row.createdDate),
    reset:row.resetInventoryLevel==='Y',adjustmentId:text(row.shopifyInventoryAdjustmentId),
    failCount:Number(row.systemMessageFailCount ?? 0) || 0,
    lastAttemptAt:inventoryQuantity(row.systemMessageLastAttemptDate) ?? undefined,
    syncedAt:state==='Sent' && row.systemMessageProcessedDate!=null ? Number(row.systemMessageProcessedDate) : undefined,
  };
}

/** One read of the shop's Shopify Admin API through HotWax. */
export async function shopifyRead<T>(oms: OmsConnection, shopId: string, queryText: string, variables: OmsRow, failure = 'Shopify could not complete the read.') {
  const result = await oms.postRead('/rest/s1/shopify/graphql',{shopId,queryText,variables});
  const response = result.response as OmsRow | undefined;
  if (!response || (Array.isArray(response.errors) && response.errors.length)) throw new OmsLookupError(failure);
  return response as T;
}

export async function searchInventory(location: Location, query: string, barcode: string, signal: AbortSignal, after?: string) {
  const quoted = JSON.stringify(query.slice(0,120).replace(/\s+/g,' '));
  const filter = barcode ? 'barcode:'+quoted : '('+quoted+' OR sku:'+quoted+' OR barcode:'+quoted+')';
  type Search = {productVariants?: {nodes: VariantNode[]; pageInfo: {endCursor?: string; hasNextPage: boolean}}};
  const result = await shopifyRead<Search>(inventoryConnection(location,signal),location.shopId,
    `query StoreInventorySearch($after: String, $filter: String!, $location: ID!) {
      productVariants(first: 20, after: $after, query: $filter) {
        nodes {
          ${CATALOG_VARIANT_FIELDS} barcode
          inventoryItem { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
        }
        pageInfo { endCursor hasNextPage }
      }
    }`,{after:after ?? null,filter,location:'gid://shopify/Location/'+location.locationId},'Shopify could not search products.');
  const page = result.productVariants;
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
  const {node} = await shopifyRead<{node?: ItemNode | VariantNode | null}>(inventoryConnection(location,signal),location.shopId,
    'query StoreInventory($id: ID!, $location: ID!) { node(id: $id) { '+selection+' } }',
    {id,location:'gid://shopify/Location/'+location.locationId},'Shopify could not read this item\'s inventory.');
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
