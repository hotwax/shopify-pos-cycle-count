import {OmsConnection, OmsLookupError, exactNumeric, rows, text, requireCountConnection, type OmsRow} from './oms-connection';
import {BASE, number, resource, sessionRows, ownedCount, validId, type Context, type CountIdentity} from './oms-count';
import {countableProducts} from './oms-count-products';
import {leaseDevice, sessionLease} from './oms-count-lease';

/** The name of a count or session the product page starts. */
export const QUICK_SESSION = 'Product page counts';
// Spelled out: oms-count imports this module, so its EDITABLE is not set yet when this one loads.
const OPEN_SESSION = new Set(['SESSION_CREATED', 'SESSION_ASSIGNED']);
const workPath = (id: string) => `${BASE}/workEfforts/${validId(id)}`;
type Run = (payload: OmsRow) => Promise<any>;

function operation(value: unknown) {
  const id = text(value);
  if (!/^[a-f0-9]{15}$/.test(id)) throw new OmsLookupError('Invalid operation ID.', 400);
  return id;
}

/** The HotWax product mapped to this Shopify variant (ShopifyShopProduct.shopifyProductId holds the variant id). */
export async function variantProduct(variantId: unknown, ctx: Context, oms: OmsConnection) {
  const id = exactNumeric(variantId, 'Shopify variant');
  const mappings = rows(await oms.get(`/rest/s1/sob/shopify/shopProducts?${new URLSearchParams({shopId:ctx.shopId,shopifyProductId:id,pageSize:'2'})}`));
  if (mappings.length !== 1 || text(mappings[0].shopId) !== ctx.shopId || !mappings[0].productId)
    throw new OmsLookupError('This variant does not have one confirmed HotWax product mapping. Scan its barcode or use its OMS SKU.', 409);
  return {productId: text(mappings[0].productId), shopifyVariantId: Number(id)};
}

/** Counts in progress at this store, newest first. */
async function openCounts(ctx: Context, oms: OmsConnection, type: string) {
  const found: OmsRow[] = [];
  for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
    const result = await oms.get(`${BASE}/workEfforts?${new URLSearchParams({facilityId:ctx.facilityId,statusId:'CYCLE_CNT_IN_PRGS',countType:type,
      pageSize:'50',pageIndex:String(pageIndex),orderByField:'-createdDate'})}`);
    const page = rows(result.cycleCounts);
    found.push(...page.filter(work => text(work.facilityId) === ctx.facilityId && text(work.workEffortPurposeTypeId) === type &&
      text(work.statusId) === 'CYCLE_CNT_IN_PRGS'));
    if (page.length < 50) break;
  }
  return found.sort((left, right) => Number(right.createdDate || 0) - Number(left.createdDate || 0));
}

/** This operator's newest open session in the count: the one they would continue counting in. */
function mySession(work: OmsRow, ctx: Context) {
  return rows(work.sessions).filter(session => text(session.uploadedByUserLogin) === ctx.username && OPEN_SESSION.has(text(session.statusId)))
    .sort((left, right) => Number(right.createdDate || 0) - Number(left.createdDate || 0))[0];
}

/** The newest directed count that asks for this product. Every count is checked at once. */
async function directedCountFor(productId: string, directed: OmsRow[], oms: OmsConnection) {
  const asks = await Promise.all(directed.map(async work => {
    const requested = rows(await oms.get(`${workPath(text(work.workEffortId))}/reviews?${new URLSearchParams({productId,pageSize:'5'})}`));
    return requested.some(row => text(row.productId) === productId && text(row.isRequested) !== 'N');
  }));
  return directed.find((_, index) => asks[index]);
}

function countName(ctx: Context, now = Date.now()) {
  const when = new Intl.DateTimeFormat('en-US', {timeZone: ctx.timeZone || 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(now);
  return `${QUICK_SESSION} · ${when}`;
}

/**
 * Where a count from a product page goes: a directed count in progress that asks for the product, else the newest
 * dynamic count in progress (one where this operator has an open session first), else a new dynamic count that is
 * started at once. In that count the operator's open session is used, or one is created the way Cycle count creates
 * any session (a directed count's session gets its requested products).
 */
export async function quickCountTarget(payload: OmsRow, ctx: Context, oms: OmsConnection, run: Run) {
  const op = operation(payload.operationId);
  // Independent reads go out together; the OMS connection keeps six in flight.
  const [{productId, shopifyVariantId}, directed, dynamic] = await Promise.all([variantProduct(payload.variantId, ctx, oms),
    openCounts(ctx, oms, 'DIRECTED_COUNT'), openCounts(ctx, oms, 'DYNAMIC_COUNT')]);
  const [products, asked] = await Promise.all([countableProducts([productId], ctx.preferences, oms), directedCountFor(productId, directed, oms)]);
  const product = products.get(productId)!;
  let work: OmsRow | undefined = asked ?? dynamic.find(candidate => mySession(candidate, ctx)) ?? dynamic[0];
  let created = false;
  if (!work) {
    if (!ctx.canCreate) throw new OmsLookupError('No count in progress includes this product, and your OMS account cannot start one.', 403);
    const result = await run({action:'createCount', operationId:op, name:countName(ctx), type:'DYNAMIC_COUNT', productIds:[], createdAt:Date.now()});
    if (result?.duplicate) throw new OmsLookupError('A count with the same name was just created. Try again.', 409);
    await run({action:'startCount', workEffortId:result.workEffortId});
    work = await oms.get(workPath(text(result.workEffortId)));
    work = {...work, sessions:rows(await oms.get(`${workPath(text(result.workEffortId))}/sessions?pageSize=501`))};
    created = true;
  }
  const workEffortId = text(work!.workEffortId);
  const sessions = rows(work!.sessions).length ? work! : {...work!, sessions:rows(await oms.get(`${workPath(workEffortId)}/sessions?pageSize=501`))};
  let session = mySession(sessions, ctx);
  if (!session) {
    const result = await run({action:'createSession', workEffortId, operationId:op, name:QUICK_SESSION, area:'register'});
    session = {inventoryCountImportId:text(result?.session?.sessionId || result?.sessionId), countImportName:QUICK_SESSION};
  }
  const sessionId = text(session.inventoryCountImportId);
  const mine = rows(await oms.get(`${workPath(workEffortId)}/count?${new URLSearchParams({inventoryCountImportId:sessionId,productId,pageSize:'2'})}`));
  return {workEffortId, countName:text(work!.workEffortName), countType:text(work!.workEffortPurposeTypeId), created, sessionId,
    sessionName:text(session.countImportName),
    product:{productId, shopifyVariantId, title:product.title, sku:product.sku, imageUrl:product.imageUrl},
    counted:number(mine.find(row => text(row.productId) === productId)?.counted)};
}

/** Saves this operator's count of one product into their open session. The session stays open: it is counted
 * and submitted from its own page as usual. */
export async function quickCountSave(identity: CountIdentity, payload: OmsRow, ctx: Context, oms: OmsConnection, run: Run) {
  const sessionId = text(payload.sessionId), productId = text(payload.productId), quantity = Number(payload.quantity);
  validId(sessionId); validId(productId);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) throw new OmsLookupError('Enter a whole quantity between 0 and 1,000,000.', 400);
  const {session, work} = await ownedCount(sessionId, ctx, oms, true);
  if (text(work.workEffortId) !== text(payload.workEffortId) || text(session.uploadedByUserLogin) !== ctx.username || !OPEN_SESSION.has(text(session.statusId)))
    throw new OmsLookupError('Your session in this count changed. Close and reopen the product to count it again.', 409);
  const product = (await countableProducts([productId], ctx.preferences, oms)).get(productId)!;
  // A directed count asks for this product, so its row is requested; a new row in saveBatch would be an extra.
  if (text(work.workEffortPurposeTypeId) === 'DIRECTED_COUNT' && !(await sessionRows(sessionId, ctx, oms, productId)).length) {
    await oms.mutate(`${resource(sessionId)}/items`, {items:[{uuid:`${sessionId}:${productId}`, productId, productIdentifier:product.sku,
      isRequested:'Y', createdByUserLoginId:ctx.username, createdDate:Date.now()}]}, 'PUT');
  }
  // The session page holds a lease on this register while it is open, so a fresh lock is refused. Save under that
  // lease when it is this operator's on this register, as the session page itself does; refuse another register's.
  const lock = await sessionLease(sessionId, oms);
  if (lock && (text(lock.userId) !== ctx.username || text(lock.deviceId) !== leaseDevice(identity.deviceId)))
    throw new OmsLookupError('This session is open on another register. Close it there, then save again.', 409);
  const expected = payload.expectedQuantity == null ? null : Number(payload.expectedQuantity);
  await run({action:'saveBatch', sessionId, items:[{productId, code:product.sku, quantity, expectedQuantity:expected}], ...(lock ? {lease:lock} : {})});
  return {saved:true, sessionId, sessionName:text(session.countImportName), workEffortId:text(work.workEffortId), quantity};
}

export async function handleQuickCount(identity: CountIdentity, payload: OmsRow, ctx: Context, oms: OmsConnection, run: Run) {
  const action = text(payload.action);
  if (action !== 'quickCountTarget' && action !== 'quickCountSave') return undefined;
  requireCountConnection(identity.shop);
  return action === 'quickCountTarget' ? quickCountTarget(payload, ctx, oms, run) : quickCountSave(identity, payload, ctx, oms, run);
}
