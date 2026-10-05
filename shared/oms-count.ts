import {
  OmsConnection,
  OmsLookupError,
  exactNumeric,
  rows,
  text,
  requireCountConnection,
  type OmsRow,
} from "./oms-connection";
import { handleWorkflow } from "./oms-count-workflows";
import {manageLease, leaseDevice, sessionLease} from './oms-count-lease';
import {countingPreferences, matchCodes, countableProducts, catalogPage, productSearchDetails} from './oms-count-products';
import {handleCountCreation} from './oms-count-create';
import {COUNT_TYPES} from './count-types';
import { shopFacility } from "./oms-shop";
import {
  COUNT_PERMISSIONS,
  countCapabilities,
  visibleCountInventory,
} from "./count-policy";

export const BASE = "/rest/s1/inventory-cycle-count/cycleCounts";
export const EDITABLE = new Set(["SESSION_CREATED", "SESSION_ASSIGNED"]);
export type CountIdentity = {
  shop: string;
  shopifyUserId: string;
  shopifyLocationId: unknown;
  shopifyStaffMemberId: unknown;
  deviceId?: string;
};

export const resource = (id: string) => `${BASE}/sessions/${encodeURIComponent(id)}`;
export const number = (value: unknown) =>
  value != null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;

function assertSignedInOperator(identity: CountIdentity) {
  // Shopify authenticates the logged-in account, not a different PIN-only staff member.
  // Never borrow that account's inventory visibility for another pinned operator.
  if (
    exactNumeric(identity.shopifyStaffMemberId, "POS staff member") !==
    exactNumeric(identity.shopifyUserId, "authenticated Shopify user")
  ) {
    throw new OmsLookupError(
      "Sign in to Shopify POS with your own account to count. This PIN belongs to a different staff member than the signed-in account.",
      403,
    );
  }
}

async function context(identity: CountIdentity, oms: OmsConnection) {
  assertSignedInOperator(identity);
  const [{ shop, facilityId }, profile, permissionResult] = await Promise.all([
    shopFacility(
      oms,
      identity.shop,
      exactNumeric(identity.shopifyLocationId, "POS location"),
    ),
    oms.get("/rest/s1/admin/user/profile"),
    oms.get(
      `/rest/s1/admin/user/permissions?${new URLSearchParams({ viewSize: "200", permissionIds: COUNT_PERMISSIONS.join(",") })}`,
    ),
  ]);
  const capabilities = countCapabilities(
    rows(permissionResult.docs).map((p) => text(p.permissionId)),
  );
  if (!capabilities.canAccess)
    throw new OmsLookupError(
      "Your OMS account does not have inventory count access.",
      403,
    );
  if (!profile.username || !profile.userId || !facilityId)
    throw new OmsLookupError(
      "OMS could not establish your count identity and store.",
    );
  // The shop's product store is usually the facility's, so load its preferences
  // alongside the facility instead of after it.
  const storeHint = text(shop.productStoreId);
  const [facility, hinted] = await Promise.all([
    oms.get(`/rest/s1/admin/facilities/${encodeURIComponent(facilityId)}`),
    storeHint ? countingPreferences(storeHint, oms).catch((error: unknown) => error) : undefined,
  ]);
  const store = text(facility.productStoreId || shop.productStoreId);
  const preferences = store === storeHint && hinted && !(hinted instanceof Error) ? hinted as Awaited<ReturnType<typeof countingPreferences>> :
    await countingPreferences(store, oms);
  return {
    shopId: text(shop.shopId),
    facilityId,
    facilityName: text(facility.facilityName),
    timeZone:text(facility.facilityTimeZone),
    username: text(profile.username),
    userId: text(profile.userId),
    userName: text(profile.userFullName || profile.username),
    canViewOnHand: capabilities.canViewOnHand,
    canCreate: capabilities.canCreate,
    canSubmit: capabilities.canSubmit,
    canPrestart: capabilities.canPrestart,
    canPreview: capabilities.canPreview,
    canRelease: capabilities.canRelease,
    preferences: {...preferences, shopId: text(shop.shopId)},
  };
}
export type Context = Awaited<ReturnType<typeof context>>;

/** Per-runtime context reuse. The caller drops entries when OMS rejects access. */
export type ContextCache = {key: string; entries: Map<string, {ctx: Context; until: number}>};
const CONTEXT_TTL = 2 * 60000;
async function countContext(identity: CountIdentity, oms: OmsConnection, cache?: ContextCache) {
  // The operator check is local and runs on every action, including cached ones.
  assertSignedInOperator(identity);
  const key = cache && `${cache.key}|${text(identity.shopifyStaffMemberId)}`;
  const hit = key ? cache!.entries.get(key) : undefined;
  if (hit && hit.until > Date.now()) return hit.ctx;
  const ctx = await context(identity, oms);
  if (key) cache!.entries.set(key, {ctx, until: Date.now() + CONTEXT_TTL});
  return ctx;
}

export function validId(id: string) {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) throw new OmsLookupError("Invalid count identifier.", 400);
  return encodeURIComponent(id);
}
export async function countWork(id: string, ctx: Context, oms: OmsConnection) {
  const work = await oms.get(`${BASE}/workEfforts/${validId(id)}`);
  if (text(work.facilityId) !== ctx.facilityId || !COUNT_TYPES.includes(text(work.workEffortPurposeTypeId)) || text(work.workEffortTypeId) !== "CYCLE_COUNT_RUN")
    throw new OmsLookupError("This count is not available at your POS store.", 403);
  return work;
}
export async function ownedCount(id: string, ctx: Context, oms: OmsConnection, write = false) {
  validId(id);
  const session = await oms.get(resource(id));
  const work = await countWork(text(session.workEffortId), ctx, oms);
  // Editing follows the active OMS device lease, including employee handover.
  // The original uploader remains intact for audit.
  if (write && !["CYCLE_CNT_IN_PRGS"].includes(text(work.statusId)))
    throw new OmsLookupError("This count is no longer open for changes.",409);
  return {session, work};
}
// The inventory view can repeat a count item for different inventory facilities.
// Deduplicate on the real item PK, never by product (one product may have several rows).
export async function sessionRows(id: string, oms: OmsConnection, productIds?: string) {
  const unique = new Map<string, OmsRow>();
  for (let pageIndex = 0; true; pageIndex++) {
    const found = rows(await oms.get(`${resource(id)}/items?${new URLSearchParams({pageSize: "5000", pageIndex: String(pageIndex), orderByField: "importItemSeqId,facilityId", ...(productIds ? {productId: productIds, productId_op: "in"} : {})})}`));
    for (const item of found) unique.set(text(item.importItemSeqId), item);
    if (found.length < 5000) return [...unique.values()];
  }
  throw new OmsLookupError("Session items could not be fully loaded. Saved scans are retained.");
}
export async function productDetails(ids: string[], ctx: Context, oms: OmsConnection) {
  const details = new Map<string, OmsRow>(), balances = new Map<string, OmsRow>();
  // Queue every 200-product chunk at once. OmsConnection keeps at most six
  // requests in flight, so slow chunks no longer hold back the next window.
  await Promise.all(Array.from({length: Math.ceil(ids.length / 200)}, async (_, index) => {
    const chunk = ids.slice(index * 200, (index + 1) * 200);
    const query = {productId: chunk.join(","), productId_op: "in", pageSize: "201"};
    const [products, inventory, labels] = await Promise.all([
      oms.get(`/rest/s1/oms/products?${new URLSearchParams(query)}`),
      ctx.canViewOnHand ? oms.get(`/rest/s1/oms/productFacilities/inventory?${new URLSearchParams({...query, facilityId: ctx.facilityId})}`) : Promise.resolve([]),
      productSearchDetails(chunk,ctx.preferences,oms),
    ]);
    for (const product of rows(products)) details.set(text(product.productId), {...product,presentation:labels.get(text(product.productId))});
    for (const item of rows(inventory)) {
      if (balances.has(text(item.productId))) throw new OmsLookupError("OMS inventory balance is ambiguous.");
      balances.set(text(item.productId), item);
    }
  }));
  return {details, balances};
}

async function withInventory<T extends OmsRow>(items:T[],ctx:Context,oms:OmsConnection) {
  if(!ctx.canViewOnHand||!items.length)return items;
  const balances=rows(await oms.get(`/rest/s1/oms/productFacilities/inventory?${new URLSearchParams({facilityId:ctx.facilityId,productId:items.map(p=>text(p.productId)).join(','),productId_op:'in',pageSize:String(items.length+1)})}`));
  return items.map(item=>{const values=balances.filter(b=>text(b.productId)===text(item.productId));
    if(values.length>1)throw new OmsLookupError('OMS inventory balance is ambiguous.');
    return {...item,onHand:number(values[0]?.quantityOnHand)};
  });
}

export function canPreviewCount(work: OmsRow, ctx: Context) {
  return ctx.canPreview || text(work.statusId)!=='CYCLE_CNT_CREATED' || Number(work.estimatedStartDate||0)<=Date.now();
}
export function requirePreview(work: OmsRow, ctx: Context) {
  if(!canPreviewCount(work,ctx))throw new OmsLookupError('You can view the product list when this count starts. Early preview requires the OMS preview permission.',403);
}

export async function countDetail(id: string, ctx: Context, oms: OmsConnection) {
  const {session, work} = await ownedCount(id, ctx, oms);
  requirePreview(work,ctx);
  const imports = await sessionRows(id, oms);
  const grouped = new Map<string, OmsRow[]>();
  for (const row of imports) {const key = text(row.productId); if (key) grouped.set(key, [...(grouped.get(key) || []), row]);}
  const {details, balances} = await productDetails([...grouped.keys()], ctx, oms);
  const items = [...grouped].map(([productId, entries]) => {
    const product = details.get(productId);
    if (!product) throw new OmsLookupError("Count product details are incomplete. Saved quantities have been kept.");
    const quantities = entries.map(row => number(row.quantity)).filter((q): q is number => q !== null);
    const quantity = quantities.length ? quantities.reduce((a, b) => a + b, 0) : null;
    return {...product.presentation as object, productId, title: text(product.productName || product.internalName || productId), sku: text(product.internalName), quantity,
      assignedAt:Number(entries[0].createdDate||0),lastUpdatedAt:Math.max(...entries.map(r=>Number(r.lastUpdatedStamp||r.createdDate||0))),
      isRequested: entries.some(row => text(row.isRequested) !== "N"),
      ...visibleCountInventory(quantity, number(balances.get(productId)?.quantityOnHand), ctx.canViewOnHand)};
  });
  return {sessionId: id, workEffortId: text(work.workEffortId), name: text(session.countImportName || work.workEffortName),
    countName: text(work.workEffortName), countType: text(work.workEffortPurposeTypeId), area: text(session.facilityAreaId),
    operator: text(session.uploadedByUserLogin), statusId: text(session.statusId), countStatusId: text(work.statusId), createdDate: session.createdDate,
    editable: EDITABLE.has(text(session.statusId)) && text(work.statusId) === "CYCLE_CNT_IN_PRGS",
    items, units: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    canViewOnHand: ctx.canViewOnHand, canSubmit: true, canComplete: ctx.canSubmit, canRelease:ctx.canRelease, currentOperator:ctx.username, barcodeType:ctx.preferences.barcode};
}

export async function withCountLock<T>(
  id: string,
  ctx: Context,
  oms: OmsConnection,
  operation: () => Promise<T>,
  lease?: OmsRow,
  deviceId?: string,
): Promise<T> {
  if (lease) {
    await manageLease('leaseRenew',id,ctx.username,leaseDevice(deviceId),lease,oms);
    return operation();
  }
  const lock = await oms.mutate(`${resource(id)}/lock`, {
    // This relation points to OFBiz UserLogin, not Moqui UserAccount.userId.
    userId: ctx.username,
    deviceId: leaseDevice(deviceId),
    thruDate: Date.now() + 90000,
  });
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    // A finite lease permits recovery after a network failure or app-server restart.
    try {
      await oms.mutate(`${resource(id)}/release`, {fromDate: lock.fromDate, thruDate: Date.now()}, "PUT");
    } catch (error) {
      if (!operationError) throw error;
    }
  }
}

export async function handleCount(
  identity: CountIdentity,
  payload: OmsRow,
  oms: OmsConnection,
  cache?: ContextCache,
) {
  const ctx = await countContext(identity, oms, cache);
  const action = text(payload.action);
  const sessionId = text(payload.sessionId);
  if (['leaseClaim','leaseRenew','leaseRelease','leaseForceRelease'].includes(action)) {
    const {session,work} = await ownedCount(sessionId,ctx,oms,true);
    if (action !== 'leaseRelease' && action !== 'leaseForceRelease' && (!EDITABLE.has(text(session.statusId)) || text(work.statusId)!=='CYCLE_CNT_IN_PRGS'))
      throw new OmsLookupError('This session is no longer open for counting.',409);
    requireCountConnection(identity.shop);
    if(action==='leaseForceRelease'){
      const lock=await sessionLease(sessionId,oms);
      if(!lock)return {released:true};
      if(!ctx.canRelease&&text(lock.userId)!==ctx.username)throw new OmsLookupError('You need the OMS release-lock permission to take over another employee’s session.',403);
      const expected=payload.lease as OmsRow|undefined;
      if(!expected || text(expected.fromDate)!==text(lock.fromDate))throw new OmsLookupError('Session ownership changed. Refresh before releasing it.',409);
      await oms.mutate(`${resource(sessionId)}/release`,{fromDate:lock.fromDate,thruDate:Date.now(),overrideByUserId:ctx.username},'PUT');
      return {released:true};
    }
    return manageLease(action,sessionId,ctx.username,leaseDevice(identity.deviceId),payload.lease as OmsRow|undefined,oms);
  }
  if (action === 'contextProduct') {
    // HotWax stores the Shopify VARIANT id in ShopifyShopProduct.shopifyProductId.
    // Never resolve count identity through the Shopify product search API.
    const variantId = exactNumeric(payload.variantId,'Shopify variant');
    const mappings = rows(await oms.get(`/rest/s1/sob/shopify/shopProducts?${new URLSearchParams({shopId:ctx.shopId,shopifyProductId:variantId,pageSize:'2'})}`));
    if (mappings.length !== 1 || text(mappings[0].shopId)!==ctx.shopId || !mappings[0].productId)
      throw new OmsLookupError('This variant does not have one confirmed HotWax product mapping. Scan its barcode or use its OMS SKU.',409);
    const productId = text(mappings[0].productId), {details,balances} = await productDetails([productId],ctx,oms);
    const product = details.get(productId);
    if (!product) throw new OmsLookupError('The mapped product is unavailable in HotWax.',404);
    return {productId,shopifyVariantId:Number(variantId),title:text(product.productName||product.internalName||productId),sku:text(product.internalName),
      ...(ctx.canViewOnHand?{onHand:number(balances.get(productId)?.quantityOnHand)}:{})};
  }
  if(action==='products'){
    // Display for saved draft products when a session is reopened; read only.
    const ids=Array.isArray(payload.productIds)?[...new Set(payload.productIds.map(text))]:[];
    if(!ids.length||ids.length>200||ids.some(id=>!id||id.length>80))throw new OmsLookupError('Request between 1 and 200 products.',400);
    return {items:[...(await productSearchDetails(ids,ctx.preferences,oms)).values()]};
  }
  if(action==='catalog'){const result=await catalogPage(payload,ctx.preferences,oms);return {...result,items:await withInventory(result.items,ctx,oms)};}
  const creation=await handleCountCreation(identity,payload,ctx,oms);
  if(creation!==undefined)return creation;
  const workflow = await handleWorkflow(identity, payload, ctx, oms);
  if (workflow !== undefined) return workflow;
  if (action === "detail")
    return {
      ...(await countDetail(sessionId, ctx, oms)),
      canViewOnHand: ctx.canViewOnHand,
    };
  if (action === "localCopyStatus") {
    // A small status read lets POS prune finished local copies without loading
    // product details. Submitted quantities are returned for verification.
    const {session, work} = await ownedCount(sessionId, ctx, oms);
    const statusId = text(session.statusId), countStatusId = text(work.statusId);
    const editable = EDITABLE.has(statusId) && countStatusId === "CYCLE_CNT_IN_PRGS";
    const quantities: Record<string, number> = {};
    if (!editable && ["SESSION_SUBMITTED", "SESSION_APPROVED"].includes(statusId))
      for (const row of await sessionRows(sessionId, oms)) {
        const productId = text(row.productId), quantity = number(row.quantity);
        if (productId && quantity !== null) quantities[productId] = (quantities[productId] ?? 0) + quantity;
      }
    return {sessionId, statusId, countStatusId, editable, quantities};
  }
  if (action === "lookup" || action === "lookupBatch" || action === "lookupIdentityBatch") {
    const codes = action === "lookup" ? [text(payload.code).trim()] : Array.isArray(payload.codes) ? payload.codes.map(value => text(value).trim()) : [];
    const result = await matchCodes([...new Set(codes)], ctx.preferences, oms, action === "lookupIdentityBatch");
    if (action === "lookupIdentityBatch") return result;
    result.matches=await withInventory(result.matches,ctx,oms);
    if (action === "lookupBatch") return result;
    if (!result.matches.length) throw new OmsLookupError(text(result.errors[0]?.message));
    return result.matches[0];
  }
  requireCountConnection(identity.shop);
  if (action === "completeCount" && !ctx.canSubmit)
    throw new OmsLookupError(
      "Your OMS account cannot submit a cycle count for review.",
      403,
    );
  if(action==='reopenSession'){
    const {session,work}=await ownedCount(sessionId,ctx,oms,true);
    if(!['SESSION_SUBMITTED','SESSION_CREATED','SESSION_ASSIGNED'].includes(text(session.statusId)))throw new OmsLookupError('This session cannot be reopened.',409);
    if(text(session.statusId)==='SESSION_SUBMITTED'){
      if(await sessionLease(sessionId,oms))throw new OmsLookupError('This session is still locked. Release it before reopening.',409);
      const fresh=await ownedCount(sessionId,ctx,oms,true);
      if(text(fresh.session.statusId)!=='SESSION_SUBMITTED')throw new OmsLookupError('Session status changed. Reopen it again.',409);
      await oms.mutate(resource(sessionId),{statusId:'SESSION_ASSIGNED'},'PUT');
    }
    return countDetail(sessionId,ctx,oms);
  }
  const { session, work } = await ownedCount(sessionId, ctx, oms, true);
  if (action === "submit" && text(session.statusId) === "SESSION_SUBMITTED") return countDetail(sessionId, ctx, oms);
  if (
    !EDITABLE.has(text(session.statusId)) ||
    text(work.statusId) !== "CYCLE_CNT_IN_PRGS"
  )
    throw new OmsLookupError("This count is no longer editable.", 409);
  if(['editSession','discardSession'].includes(action))return withCountLock(sessionId,ctx,oms,async()=>{
    const fresh=await ownedCount(sessionId,ctx,oms,true);
    if(!EDITABLE.has(text(fresh.session.statusId)))throw new OmsLookupError('Session status changed. Refresh first.',409);
    if(action==='editSession'){
      const name=text(payload.name).trim(),area=text(payload.area);
      if(!name||name.length>100||!['back_stock','display','floor_wall','floor_shelf','overflow','register'].includes(area))throw new OmsLookupError('Enter a session name and choose a session location.',400);
      await oms.mutate(resource(sessionId),{countImportName:name,facilityAreaId:area},'PUT');
    }else await oms.mutate(resource(sessionId),{statusId:'SESSION_VOIDED'},'PUT');
    return countDetail(sessionId,ctx,oms);
  },payload.lease as OmsRow|undefined,identity.deviceId);
  if (action === "saveBatch") {
    const incoming = rows(payload.items);
    if (!Array.isArray(payload.items) || incoming.length !== payload.items.length || !incoming.length || incoming.length > 25)
      throw new OmsLookupError("Sync between 1 and 25 count items at a time.", 400);
    const batch = incoming.map(item => ({productId: text(item.productId), code: text(item.code).trim(), quantity: Number(item.quantity), expectedQuantity: item.expectedQuantity == null ? null : Number(item.expectedQuantity)}));
    if (batch.some((item, i) => !item.productId || item.productId.length > 80 || !item.code || item.code.length > 255 ||
      incoming[i].quantity == null || incoming[i].quantity === "" || !Number.isSafeInteger(item.quantity) || item.quantity < 0 || item.quantity > 1000000 ||
      (item.expectedQuantity !== null && (!Number.isSafeInteger(item.expectedQuantity) || item.expectedQuantity < 0))) ||
      new Set(batch.map(item => item.productId)).size !== batch.length)
      throw new OmsLookupError("Count items need unique products and valid whole quantities.", 400);
    const productIds = batch.map(item => item.productId).join(",");
    await countableProducts(batch.map(i=>i.productId),ctx.preferences,oms);
    return withCountLock(sessionId, ctx, oms, async () => {
      const latest = await ownedCount(sessionId, ctx, oms, true);
      if (!EDITABLE.has(text(latest.session.statusId)) || text(latest.work.statusId) !== "CYCLE_CNT_IN_PRGS")
        throw new OmsLookupError("Count changed before saving.", 409);
      const countPath = `${BASE}/workEfforts/${encodeURIComponent(text(latest.work.workEffortId))}/count?${new URLSearchParams({pageSize: "26", inventoryCountImportId: sessionId, productId: productIds, productId_op: "in"})}`;
      // These reads are independent; validate them in the original order after one round trip.
      const [countedRows, balanceRows, existingRows] = await Promise.all([
        oms.get(countPath),
        oms.get(`/rest/s1/oms/productFacilities/inventory?${new URLSearchParams({facilityId: ctx.facilityId, productId: productIds, productId_op: "in", pageSize: "100"})}`),
        sessionRows(sessionId, oms, productIds),
      ]);
      const counted = rows(countedRows);
      for (const item of batch) {
        const existing = number(counted.find(row => text(row.productId) === item.productId)?.counted);
        if (existing !== item.expectedQuantity && existing !== item.quantity)
          throw new OmsLookupError("This product was changed in HotWax or on another device. Your scans are safe; refresh and reconcile the quantity before syncing.", 409);
      }
      const balances = rows(balanceRows);
      if (batch.some(item => balances.filter(row => text(row.productId) === item.productId).length > 1))
        throw new OmsLookupError("OMS returned ambiguous inventory balances.");
      const onHand = (id: string) => number(balances.find(row => text(row.productId) === id)?.quantityOnHand);
      const updates = batch.flatMap(item => {
        const existing = existingRows.filter(row => text(row.productId) === item.productId);
        if (existing.some(row => !row.uuid) || new Set(existing.map(row => row.uuid)).size !== existing.length)
          throw new OmsLookupError("This session contains legacy rows without unique IDs. Resolve them in HotWax before editing in POS.", 409);
        const targets = existing.length ? existing : [{uuid: `${sessionId}:${item.productId}`}];
        return targets.map((row, index) => ({uuid: row.uuid, productId: item.productId, productIdentifier: item.code,
          quantity: index === 0 ? item.quantity : 0, countedByUserLoginId: ctx.username,
          ...(!existing.length ? {createdByUserLoginId: ctx.username, createdDate: Date.now(),
            isRequested: text(work.workEffortPurposeTypeId) === "DIRECTED_COUNT" ? "N" : "Y"} : {}),
          systemQuantityOnHand: row.systemQuantityOnHand ?? onHand(item.productId)}));
      });
      await oms.mutate(`${resource(sessionId)}/items`, {items: updates}, "PUT");
      const saved = rows(await oms.get(countPath));
      if (batch.some(item => !saved.some(row => text(row.productId) === item.productId && number(row.counted) === item.quantity)))
        throw new OmsLookupError("HotWax count readback differs from the quantity sent. Keep local scans and refresh before retrying.", 409);
      return {canViewOnHand: ctx.canViewOnHand, items: batch.map(item => ({...item,
        ...visibleCountInventory(item.quantity, onHand(item.productId), ctx.canViewOnHand)}))};
    }, payload.lease as OmsRow|undefined, identity.deviceId);
  }
  if (action === "submit")
    return withCountLock(sessionId, ctx, oms, async () => {
      const detail = await countDetail(sessionId, ctx, oms);
      if (!detail.items.some(item => item.quantity !== null))
        throw new OmsLookupError(
          "Scan at least one product before submitting.",
          400,
        );
      await oms.mutate(
        resource(sessionId),
        { statusId: "SESSION_SUBMITTED" },
        "PUT",
      );
      return countDetail(sessionId, ctx, oms);
    }, payload.lease as OmsRow|undefined, identity.deviceId);
  throw new OmsLookupError("Unknown count action.", 400);
}
