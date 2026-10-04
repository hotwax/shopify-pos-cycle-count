import {OmsConnection, OmsLookupError, rows, text, type OmsRow} from './oms-connection';

export const LEASE_SECONDS = 150;
const millis = (value: unknown) => typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
const path = (id: string) => `/rest/s1/inventory-cycle-count/cycleCounts/sessions/${encodeURIComponent(id)}`;
export function leaseDevice(value: unknown) {
  const id = text(value);
  if (!/^POS_[A-Za-z0-9_-]{1,36}$/.test(id)) throw new OmsLookupError('This register could not be identified. Reopen Cycle Count.', 400);
  return id;
}
export async function sessionLease(id: string, oms: OmsConnection) {
  const result = rows(await oms.get(`${path(id)}/lock?${new URLSearchParams({pageSize:'100',orderByField:'-fromDate'})}`));
  return activeSessionLease(result);
}
export function activeSessionLease(result: OmsRow[], now = Date.now()) {
  const active = result.filter(row => millis(row.fromDate) <= now && (row.thruDate == null || millis(row.thruDate) > now));
  if (active.length > 1) throw new OmsLookupError('This session has conflicting device locks. Ask your manager to resolve them in HotWax.', 409);
  return active[0];
}
export function describe(row: OmsRow | undefined, user: string, device: string) {
  return row ? {fromDate:row.fromDate,expiresAt:row.thruDate == null ? null : millis(row.thruDate),
    deviceId:text(row.deviceId),operator:text(row.userId),lastHeartbeatAt:row.lastHeartbeatAt,
    owned:text(row.deviceId)===device && text(row.userId)===user,available:false} : {owned:false,available:true};
}
export async function manageLease(action: string, id: string, user: string, device: string, supplied: OmsRow | undefined, oms: OmsConnection) {
  leaseDevice(device);
  let current = await sessionLease(id, oms);
  if (action === 'leaseClaim') {
    if (current) return describe(current,user,device);
    // The real OMS create service serializes acquisition by locking the session row.
    await oms.mutate(`${path(id)}/lock`,{userId:user,deviceId:device,thruDate:Date.now()+LEASE_SECONDS*1000,
      leaseSeconds:LEASE_SECONDS,lastHeartbeatAt:Date.now()});
    current = await sessionLease(id,oms);
    if (!current) throw new OmsLookupError('HotWax did not confirm device ownership. Retry opening this session.',409);
    return describe(current,user,device);
  }
  const same = current && supplied && millis(current.fromDate)===millis(supplied.fromDate) &&
    text(current.deviceId)===device && text(current.userId)===user;
  if (action === 'leaseRelease' && !same) return {released:false};
  if (!same) throw new OmsLookupError('This device no longer owns the session. Your scans are saved. Reconnect to check ownership before syncing.',409);
  if (action === 'leaseRelease') {
    await oms.mutate(`${path(id)}/release`,{fromDate:current!.fromDate,thruDate:Date.now()},'PUT');
    return {released:true};
  }
  if (action !== 'leaseRenew') throw new OmsLookupError('Unknown session ownership action.',400);
  // Renew from now, never from the old deadline, and never resurrect an expired row.
  await oms.mutate(`${path(id)}/lock`,{fromDate:current!.fromDate,thruDate:Date.now()+LEASE_SECONDS*1000,
    lastHeartbeatAt:Date.now(),leaseSeconds:LEASE_SECONDS},'PUT');
  const renewed = await sessionLease(id,oms);
  if (!renewed || millis(renewed.fromDate)!==millis(current!.fromDate) || text(renewed.deviceId)!==device || text(renewed.userId)!==user)
    throw new OmsLookupError('Device ownership changed while reconnecting. Your local scans are retained.',409);
  return describe(renewed,user,device);
}
