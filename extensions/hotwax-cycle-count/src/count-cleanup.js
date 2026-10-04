import {leaseKey} from './count-lease';

// Shopify allows 100 storage entries per extension, so a register must drop
// local copies HotWax no longer needs. Nothing here deletes unsynced work for a
// session that can still accept it.
const catalogKey = owner => `hotwax-count:${owner}:sessions`;
const CLOSED_COUNTS = new Set(['CYCLE_CNT_CLOSED','CYCLE_CNT_CNCL']);

/**
 * @param {{editable:boolean,statusId:string,countStatusId:string,quantities:Record<string,number>}} remote
 * @param {{pending:number,dirty:number,items:{productId:string,quantity:number|null}[]}} local
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

/** Pending scans and unsynced products of a session that is not open. */
export async function storedSessionState(storage, entry) {
  const [items, journal, receipts] = await Promise.all([storage.peek(entry.itemKey), storage.metadata(entry.eventKey),
    storage.get(`${entry.itemKey}:receipts`)]);
  const list = Object.values(items?.items || {}), synced = receipts?.items || {};
  return {items: list,
    dirty: list.filter(item => item.revision !== item.syncedRevision && !(synced[item.productId]?.revision >= item.revision)).length,
    pending: journal.summary?.pendingCount ?? journal.header?.events?.filter(event => event.aggApplied === 0).length ?? 0};
}

/** Remove one session's journal, checkpoint, receipts, lease and hand-count draft. */
export async function removeLocalSession(storage, owner, entry) {
  await storage.removeDocument(entry.eventKey);
  await storage.removeDocument(entry.itemKey);
  for (const key of [`${entry.itemKey}:receipts`, leaseKey(owner, entry.sessionId), `hotwax-count:${owner}:hand-draft:${entry.sessionId}`])
    await storage.delete(key);
  const saved = await storage.get(catalogKey(owner));
  await storage.set(catalogKey(owner), {...saved, active: saved?.active === entry.sessionId ? null : saved?.active ?? null,
    sessions: (saved?.sessions || []).filter(session => session.sessionId !== entry.sessionId)});
}

/**
 * Check the oldest saved sessions and remove the ones HotWax has finished with.
 * Runs in the modal, which owns journal writes. Returns the number removed.
 */
export async function pruneLocalSessions({storage, owner, request, keep = null, limit = 10, isCurrent = () => true, track = task => task}) {
  const catalog = await storage.get(catalogKey(owner));
  let removed = 0;
  for (const entry of [...(catalog?.sessions || [])].reverse().filter(item => item.sessionId !== keep).slice(0, limit)) {
    if (!isCurrent()) break;
    try {
      const remote = await request('localCopyStatus', {sessionId: entry.sessionId});
      if (remote.editable || !localCopyRemovable(remote, await storedSessionState(storage, entry))) continue;
      // Check and start the removal in one step, so a session being opened is
      // never removed underneath it; the opener awaits a removal already started.
      if (!isCurrent()) break;
      await track(removeLocalSession(storage, owner, entry)); removed++;
    } catch { /* Keep this copy; the next open checks it again. */ }
  }
  return removed;
}
