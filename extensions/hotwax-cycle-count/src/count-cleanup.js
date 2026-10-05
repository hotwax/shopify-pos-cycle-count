import {controlFor, legacyKey, readMailbox} from './count-control';

// Shopify allows 100 storage entries per extension, so a register must drop
// local copies HotWax no longer needs. Nothing here deletes unsynced work for a
// session that can still accept it.
const CLOSED_COUNTS = new Set(['CYCLE_CNT_CLOSED','CYCLE_CNT_CNCL']);

/**
 * @param {{editable:boolean,statusId:string,countStatusId:string,quantities:Record<string,number>}} remote
 * @param {{pending:number,dirty:number,items:{productId:string,quantity?:number|null}[]}} local
 */
export function localCopyRemovable(remote, local) {
  if (remote.editable) return false;
  // A discarded session or a closed count cannot take further quantities.
  if (remote.statusId === 'SESSION_VOIDED' || CLOSED_COUNTS.has(remote.countStatusId)) return true;
  if (!['SESSION_SUBMITTED','SESSION_APPROVED'].includes(remote.statusId) || local.pending || local.dirty) return false;
  // Every local quantity must be the one HotWax holds for this session.
  return local.items.every(item => item.quantity == null ? remote.quantities[item.productId] === undefined :
    remote.quantities[item.productId] === item.quantity);
}

/** Pending scans and unsynced products of a session that is not open. A copy
 * whose documents belong to another session (an old split pair) is never removable. */
export async function storedSessionState(storage, owner, entry) {
  const [items, journal] = [await storage.load(entry.itemKey), await storage.load(entry.eventKey)];
  if ([items, journal].some(doc => doc && doc.header?.sessionId !== entry.sessionId)) return {items: [], dirty: 1, pending: 1};
  const box = (await readMailbox(storage.native, owner)).receipts[entry.sessionId];
  const synced = {...(await storage.get(`${entry.itemKey}:receipts`))?.items, ...(box && box.docId === items?.header?.docId ? box.items : {})};
  const list = items?.records || [];
  return {items: list,
    dirty: list.filter(item => item.revision !== item.syncedRevision && !(synced[item.productId]?.revision >= item.revision)).length,
    pending: (journal?.records || []).filter(event => event.aggApplied === 0).length};
}

/** Remove one session's documents and every small value an earlier release kept for it. */
export async function removeLocalSession(storage, owner, entry) {
  await storage.removeDocument(entry.eventKey);
  await storage.removeDocument(entry.itemKey);
  for (const key of [`${entry.itemKey}:receipts`, legacyKey(owner, 'lease', entry.sessionId), legacyKey(owner, 'hand-draft', entry.sessionId)])
    await storage.delete(key);
  await controlFor(storage.native, owner).removeSession(entry.sessionId);
}
/** A count's pending decision and session creation are retry tokens for its other
 * sessions too; they go only once HotWax reports the whole count closed. */
async function forgetCount(storage, owner, workEffortId) {
  const control = controlFor(storage.native, owner);
  for (const [field, name] of [['decisions', 'decision'], ['creates', 'create-session']]) {
    await storage.delete(legacyKey(owner, name, workEffortId));
    await control.setEntry(field, workEffortId, null);
  }
}

/**
 * Check the oldest saved sessions and remove the ones HotWax has finished with.
 * Runs in the modal, which owns journal writes. Returns the number removed.
 */
export async function pruneLocalSessions({storage, owner, request, keep = null, limit = 10, isCurrent = () => true, track = task => task}) {
  const {catalogue} = await controlFor(storage.native, owner).read();
  let removed = 0;
  for (const entry of [...catalogue].reverse().filter(item => item.sessionId !== keep).slice(0, limit)) {
    if (!isCurrent()) break;
    try {
      const remote = await request('localCopyStatus', {sessionId: entry.sessionId});
      if (remote.editable || !localCopyRemovable(remote, await storedSessionState(storage, owner, entry))) continue;
      // Check and start the removal in one step, so a session being opened is
      // never removed underneath it; the opener awaits a removal already started.
      if (!isCurrent()) break;
      await track(removeLocalSession(storage, owner, entry)); removed++;
      if (CLOSED_COUNTS.has(remote.countStatusId) && entry.workEffortId) await forgetCount(storage, owner, entry.workEffortId);
    } catch { /* Keep this copy; the next open checks it again. */ }
  }
  return removed;
}
