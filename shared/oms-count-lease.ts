import {OmsConnection, OmsLookupError, rows, text, type OmsRow} from './oms-connection';

export const LEASE_SECONDS = 150;
const millis = (value: unknown) => typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
const path = (id: string) => `/rest/s1/inventory-cycle-count/cycleCounts/sessions/${encodeURIComponent(id)}`;
export function leaseDevice(value: unknown) {
  const id = text(value);
  if (!/^POS_[A-Za-z0-9_-]{1,36}$/.test(id)) throw new OmsLookupError('This register could not be identified. Reopen Cycle Count.', 400);
  return id;
}
/** OMS reports that this terminal's lease is no longer the active one. */
export const leaseLost = (message: string) => Object.assign(new OmsLookupError(message, 409), {leaseLost: true});
const lockRows = async (id: string, oms: OmsConnection) =>
  rows(await oms.get(`${path(id)}/lock?${new URLSearchParams({pageSize:'100',orderByField:'-fromDate'})}`));
export async function sessionLease(id: string, oms: OmsConnection) {
  return activeSessionLease(await lockRows(id, oms));
}
const ownedBy = (row: OmsRow | undefined, user: string, device: string) =>
  !!row && text(row.deviceId) === device && text(row.userId) === user;
async function acquire(id: string, user: string, device: string, oms: OmsConnection) {
  // The real OMS create service serializes acquisition by locking the session row.
  await oms.mutate(`${path(id)}/lock`,{userId:user,deviceId:device,thruDate:Date.now()+LEASE_SECONDS*1000,
    leaseSeconds:LEASE_SECONDS,lastHeartbeatAt:Date.now()});
  const current = await sessionLease(id,oms);
  if (!current) throw new OmsLookupError('HotWax did not confirm device ownership. Retry opening this session.',409);
  return describe(current,user,device);
}
async function extend(id: string, current: OmsRow, user: string, device: string, oms: OmsConnection) {
  // Renew from now, never from the old deadline, and never resurrect an expired row.
  await oms.mutate(`${path(id)}/lock`,{fromDate:current.fromDate,thruDate:Date.now()+LEASE_SECONDS*1000,
    lastHeartbeatAt:Date.now(),leaseSeconds:LEASE_SECONDS},'PUT');
  const renewed = await sessionLease(id,oms);
  if (!renewed || millis(renewed.fromDate)!==millis(current.fromDate) || !ownedBy(renewed,user,device))
    throw leaseLost('Device ownership changed while reconnecting. Your local scans are retained.');
  return describe(renewed,user,device);
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
/**
 * @param reacquire only for the client's own renew call, which keeps the lease it gets back.
 *   Writes renew in passing and keep using the lease they sent, so they must not receive a new one.
 */
export async function manageLease(action: string, id: string, user: string, device: string, supplied: OmsRow | undefined, oms: OmsConnection, reacquire = false) {
  leaseDevice(device);
  const history = await lockRows(id, oms);
  const current = activeSessionLease(history);
  if (action === 'leaseClaim') {
    // Reopening a session this register already holds gets a full lease, not
    // whatever time the earlier screen's last heartbeat left.
    if (ownedBy(current,user,device)) return extend(id,current!,user,device,oms);
    if (current) return describe(current,user,device);
    return acquire(id,user,device,oms);
  }
  const same = current && supplied && millis(current.fromDate)===millis(supplied.fromDate) && ownedBy(current,user,device);
  if (action === 'leaseRelease' && !same) return {released:false};
  if (!same) {
    // This register's own lease ran out (for example, the screen closed for a few
    // minutes) and no other register has locked the session since: take it again.
    // Any lock taken after it, even one already released, still fences this terminal.
    const latest = history[0];
    if (reacquire && action === 'leaseRenew' && !current && supplied && ownedBy(latest,user,device) &&
        millis(latest.fromDate)===millis(supplied.fromDate)) return acquire(id,user,device,oms);
    // The background uploader on this same register took a newer lease: adopt it.
    if (reacquire && action === 'leaseRenew' && ownedBy(current,user,device)) return extend(id,current!,user,device,oms);
    throw leaseLost('This device no longer owns the session. Your scans are saved. Reconnect to check ownership before syncing.');
  }
  if (action === 'leaseRelease') {
    await oms.mutate(`${path(id)}/release`,{fromDate:current!.fromDate,thruDate:Date.now()},'PUT');
    return {released:true};
  }
  if (action !== 'leaseRenew') throw new OmsLookupError('Unknown session ownership action.',400);
  return extend(id,current!,user,device,oms);
}
