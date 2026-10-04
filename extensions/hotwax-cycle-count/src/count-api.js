import {currentOmsOrigin,forgetOmsLogin,openDirectOms,OMS_ORIGIN_KEY} from '../../../shared/direct-oms';
import {handleCount} from '../../../shared/oms-count';
import {createScanProductLookup,fetchVariantDisplays} from './scan-products';
export {createMemberSearch} from './scan-products';

export function currentCountOwner() {
  const session = shopify.session.currentSession;
  return `${session.shopId}:${session.locationId}:${shopify.session.staffMember.value?.id}`;
}
/** The shop and OMS connection that scope the shared variant mapping. */
export async function omsScope() {
  return {shop: String(shopify.session.currentSession.shopId), oms: currentOmsOrigin() || await shopify.storage.get(OMS_ORIGIN_KEY)};
}

// Shop, facility, profile, permissions and preferences change rarely. Reusing
// them (and the OMS login, see direct-oms) leaves one round trip per action.
const contexts = new Map();
// Product summaries and full session loads may need longer than the default read budget.
const LONG_READS = new Set(['progress', 'detail']);

/**
 * @param {string} action
 * @param {Record<string, any>} [payload]
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<any>}
 */
export async function countRequest(action, payload = {}, options = {}) {
  const owner = currentCountOwner();
  const session = shopify.session.currentSession;
  const staffId = shopify.session.staffMember.value?.id;
  const assertOwner = () => {if (currentCountOwner() !== owner) throw new Error('The POS operator or store changed. Saved scans stay with their original operator.');};
  if (shopify.connectivity.current.value.internetConnected !== 'Connected')
    throw new Error('POS is offline. Saved scans stay on this device; matching and sync resume when connected.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 55000);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const attempt = async () => {
    const {oms, identity, loginKey, reusedLogin} = await openDirectOms(shopify.session, session.locationId,
      {signal, storage: shopify.storage, readBudgetMs: LONG_READS.has(action) ? 45000 : undefined});
    assertOwner();
    const mutate = oms.mutate.bind(oms);
    oms.mutate = (path,data,method='POST') => {assertOwner(); return mutate(path,data,method);};
    try {
      const result = await handleCount({...identity, deviceId:currentDeviceId(),
        shopifyStaffMemberId: staffId},
        {...payload, action}, oms, {key: loginKey, entries: contexts});
      assertOwner();
      return result;
    } catch (error) {
      // OMS rejected a reused login or permissions changed: forget both and,
      // for an expired login that has not started writing, sign in once more.
      if (error?.status === 401 || error?.status === 403) {
        forgetOmsLogin(loginKey);
        for (const key of contexts.keys()) if (key.startsWith(`${loginKey}|`)) contexts.delete(key);
      }
      if (error?.status === 401 && reusedLogin && !oms.mutationStarted) error.retryLogin = true;
      throw error;
    }
  };
  try {
    return await attempt().catch(error => {if (error?.retryLogin) return attempt(); throw error;});
  } finally {
    clearTimeout(timer);
  }
}

countRequest.lookupBatch = codes => countRequest("lookupBatch", {codes});

export function bindCountRequest(owner, options = {}) {
  const request = (action,payload,callOptions) => {
    if (currentCountOwner() !== owner) return Promise.reject(new Error('The POS operator changed. Reopening your counts…'));
    return countRequest(action,payload,{...options,...callOptions});
  };
  request.lookupBatch = codes => request('lookupBatch',{codes});
  request.lookupIdentityBatch = codes => request('lookupIdentityBatch',{codes});
  request.enrichScan = createScanProductLookup(shopify.productSearch,()=>currentCountOwner()===owner);
  request.variants = ids => fetchVariantDisplays(shopify.productSearch, ids);
  return request;
}

export function currentAuditContext() {
  const session = shopify.session.currentSession;
  return {shopId:String(session.shopId),locationId:String(session.locationId),
    staffId:String(shopify.session.staffMember.value?.id),authenticatedUserId:String(session.userId),
    deviceId:currentDeviceId(),registerName:shopify.device.registerName,deviceName:shopify.device.name};
}

export function currentDeviceId() {
  const value=shopify.session.deviceId;
  if(!Number.isSafeInteger(value)||value<=0)throw new Error('Shopify could not identify this register. Reopen Cycle Count.');
  return `POS_${value}`;
}

// Shopify notes that the scanner subscription can fire more than once for one
// scan, and bridged values are new objects. Skip the subscribe-time replay and
// the same code from the same source inside a window far shorter than a person
// can rescan; repeated physical scans still count as separate units.
export const DUPLICATE_SCAN_MS = 80;
export function subscribeScans(scanner, receive, now = () => Date.now()) {
  let last = scanner.scannerData.current.value, seen = {data: '', source: '', at: -Infinity};
  return scanner.scannerData.current.subscribe((scan) => {
    if (!scan?.data || scan === last) return;
    last = scan;
    const at = now();
    if (scan.data === seen.data && scan.source === seen.source && at - seen.at < DUPLICATE_SCAN_MS) return;
    seen = {data: scan.data, source: scan.source, at};
    receive(scan);
  });
}

export function workStatus(status) {
  return {CYCLE_CNT_CREATED:"Scheduled",CYCLE_CNT_IN_PRGS:"In progress",CYCLE_CNT_CMPLTD:"Awaiting approval",CYCLE_CNT_CLOSED:"Reviewed",CYCLE_CNT_CNCL:"Cancelled"}[status] || status;
}
export {countTypeName} from '../../../shared/count-types';

export function countStatus(count) {
  if (count.countStatusId === "CYCLE_CNT_CLOSED") return "Reviewed";
  if (count.countStatusId === "CYCLE_CNT_CNCL") return "Cancelled";
  return (
    {
      SESSION_CREATED: "Draft",
      SESSION_ASSIGNED: "Counting",
      SESSION_SUBMITTED: "Session submitted",
      SESSION_APPROVED: "Approved",
      SESSION_VOIDED: "Voided",
    }[count.statusId] || count.statusId
  );
}
