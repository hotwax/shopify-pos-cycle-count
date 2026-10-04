import {openDirectOms} from '../../../shared/direct-oms';
import {handleCount} from '../../../shared/oms-count';
import {LOCAL_OMS_PREVIEW} from '../../../shared/oms-build-config';
import {createScanProductLookup} from './scan-products';

export function currentCountOwner() {
  const session = shopify.session.currentSession;
  return `${session.shopId}:${session.locationId}:${shopify.session.staffMember.value?.id}`;
}
const outageKey = () => `hotwax-count:${currentCountOwner()}:test-oms-outage`;
export async function isOmsOutageSimulated() {
  return LOCAL_OMS_PREVIEW && await shopify.storage.get(outageKey()) === true;
}
export async function simulateOmsOutage(enabled) {
  if (!LOCAL_OMS_PREVIEW) throw new Error('Connection fault testing is only available in development.');
  if (enabled) await shopify.storage.set(outageKey(), true);
  else await shopify.storage.delete(outageKey());
}

/** @returns {Promise<any>} */
export async function countRequest(action, payload = {}) {
  const owner = currentCountOwner();
  const session = shopify.session.currentSession;
  const staffId = shopify.session.staffMember.value?.id;
  const assertOwner = () => {if (currentCountOwner() !== owner) throw new Error('The POS operator or store changed. Saved scans stay with their original operator.');};
  if (await isOmsOutageSimulated()) throw new Error('Demo test: OMS connection is unavailable. Scans remain on this device.');
  if (shopify.connectivity.current.value.internetConnected !== 'Connected')
    throw new Error('POS is offline. Keep counting saved products; matching and sync resume when connected.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const {oms, identity} = await openDirectOms(shopify.session,
      session.locationId, controller.signal);
    assertOwner();
    const mutate = oms.mutate.bind(oms);
    oms.mutate = (path,data,method='POST') => {assertOwner(); return mutate(path,data,method);};
    const result = await handleCount({...identity, deviceId:currentDeviceId(),
      shopifyStaffMemberId: staffId},
      {...payload, action}, oms);
    assertOwner();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

countRequest.lookupBatch = codes => countRequest("lookupBatch", {codes});

export function bindCountRequest(owner) {
  const request = (action,payload) => {
    if (currentCountOwner() !== owner) return Promise.reject(new Error('The POS operator changed. Reopening your counts…'));
    return countRequest(action,payload);
  };
  request.lookupBatch = codes => request('lookupBatch',{codes});
  request.lookupIdentityBatch = codes => request('lookupIdentityBatch',{codes});
  request.enrichScan = createScanProductLookup(shopify.productSearch,()=>currentCountOwner()===owner);
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

// Skip subscription replay, while counting repeated physical scans separately.
export function subscribeScans(scanner, receive) {
  let last = scanner.scannerData.current.value;
  return scanner.scannerData.current.subscribe((scan) => {
    if (!scan?.data || scan === last) return;
    last = scan;
    receive(scan);
  });
}

export function submissionIncomplete(_count = undefined) { return false; }

export function workStatus(status) {
  return {CYCLE_CNT_CREATED:"Scheduled",CYCLE_CNT_IN_PRGS:"In progress",CYCLE_CNT_CMPLTD:"Awaiting approval",CYCLE_CNT_CLOSED:"Reviewed",CYCLE_CNT_CNCL:"Cancelled"}[status] || status;
}
export {countTypeName} from '../../../shared/count-types';

export function countStatus(count) {
  if (count.countStatusId === "CYCLE_CNT_CLOSED") return "Reviewed";
  if (count.countStatusId === "CYCLE_CNT_CNCL") return "Cancelled";
  if (submissionIncomplete(count)) return "Submission incomplete";
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
