// Small per-operator metadata lives in two values with one writer each:
// - control is written only by the modal runtime: saved sessions (catalogue),
//   leases this terminal holds and release fences, hand-count drafts, pending
//   count decisions and session creations, and its own status.
// - mailbox (`:background`) is written only by the background runtime, while it
//   holds its coordination flag: sync receipts, leases it claimed, its release
//   fences and its status.
// Each side only reads the other's value, so neither can erase the other's update.
// Control reuses the key of the earlier catalogue, so upgrading needs no free
// storage entry, and earlier releases (which look for a `sessions` array there)
// find no sessions to open, prune or upload.
export const controlKey = owner => `hotwax-count:${owner}:sessions`;
export const mailboxKey = owner => `hotwax-count:${owner}:background`;
// Keys written by earlier releases; each is moved into control on first use.
export const legacyKey = (owner, name, id) => `hotwax-count:${owner}:${name}${id == null ? '' : `:${id}`}`;
const MAPS = ['leases', 'released', 'drafts', 'decisions', 'creates'];
const empty = () => ({v: 1, catalogue: [], leases: {}, released: {}, drafts: {}, decisions: {}, creates: {}, status: null});
/** Control as stored, or the earlier catalogue converted (same document keys). */
export const readControl = value => !value ? empty() : value.v ? {...empty(), ...value} : {...empty(), catalogue: Array.isArray(value.sessions) ? value.sessions : []};
const unused = state => !state.catalogue.length && MAPS.every(field => !Object.keys(state[field]).length);
const token = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const millis = value => value == null ? -Infinity : typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));

/** The lease this terminal last held for a session: the newer of the modal's and
 * the background's copies, ignoring any lease at or before either release fence. */
export function storedLease(control, mailbox, sessionId) {
  const fence = Math.max(millis(control?.released?.[sessionId]), millis(mailbox?.released?.[sessionId]));
  return [control?.leases?.[sessionId], mailbox?.leases?.[sessionId]]
    .filter(lease => lease?.owned && (fence === -Infinity || millis(lease.fromDate) > fence))
    .sort((a, b) => millis(b.fromDate) - millis(a.fromDate) || (b.lastHeartbeatAt || 0) - (a.lastHeartbeatAt || 0))[0];
}
/** The newer of the two runtimes' status reports (for the tile). */
export const latestStatus = (control, mailbox) => [control?.status, mailbox?.status].filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;

const stores = new WeakMap();
/** One store per native storage and owner, so every component of the modal
 * runtime shares one write queue. */
export function controlFor(native, owner) {
  let byOwner = stores.get(native);
  if (!byOwner) stores.set(native, byOwner = new Map());
  if (!byOwner.has(owner)) byOwner.set(owner, new ControlStore(native, owner));
  return byOwner.get(owner);
}

export class ControlStore {
  constructor(native, owner) {this.native = native; this.owner = owner; this.key = controlKey(owner); this.queue = Promise.resolve();}
  /** The current record; `fresh` re-reads it (another modal runtime may have written). */
  read(fresh = false) {
    if (fresh) this.loading = undefined;
    return this.loading ??= this.load().catch(error => {this.loading = undefined; throw error;});
  }
  async load() {
    const saved = await this.native.get(this.key);
    const state = readControl(saved);
    // First run after an upgrade: convert the catalogue in place, then drop the
    // values earlier releases kept beside it. The status is rebuilt by each runtime.
    if (saved && !saved.v) await this.native.set(this.key, {...state, rev: token()});
    for (const name of ['status', 'test-oms-outage']) await this.native.delete(legacyKey(this.owner, name));
    return state;
  }
  /** Serialized read-modify-write. Each change applies to the value in storage
   * at that moment, field by field, so another runtime's newer entries survive. */
  update(change) {
    const task = this.queue.catch(() => {}).then(async () => {
      const current = readControl(await this.native.get(this.key)), next = change(current);
      if (!next) {this.loading = Promise.resolve(current); return current;}
      if (unused(next)) await this.native.delete(this.key);
      else await this.native.set(this.key, {...next, rev: token()});
      this.loading = Promise.resolve(next);
      return next;
    });
    this.queue = task;
    return task;
  }
  setEntry(field, id, value) {
    return this.update(state => {
      const map = {...state[field]};
      if (value == null) {if (!(id in map)) return null; delete map[id];} else map[id] = value;
      return {...state, [field]: map};
    });
  }
  upsertSession(entry) {
    return this.update(state => ({...state, catalogue: [entry, ...state.catalogue.filter(item => item.sessionId !== entry.sessionId)]}));
  }
  removeSession(sessionId) {
    return this.update(state => {
      const leases = {...state.leases}, released = {...state.released}, drafts = {...state.drafts};
      delete leases[sessionId]; delete released[sessionId]; delete drafts[sessionId];
      return {...state, leases, released, drafts, catalogue: state.catalogue.filter(item => item.sessionId !== sessionId)};
    });
  }
  /** Keep a lease OMS confirmed for this terminal; it supersedes any release fence.
   * A renewal that changes only its expiry is not written again. */
  holdLease(sessionId, lease) {
    return this.update(state => {
      const old = state.leases[sessionId];
      if (old && String(old.fromDate) === String(lease.fromDate) && old.deviceId === lease.deviceId && old.owned === lease.owned && !(sessionId in state.released)) return null;
      const released = {...state.released}; delete released[sessionId];
      return {...state, leases: {...state.leases, [sessionId]: lease}, released};
    });
  }
  /** Forget a lease locally and fence every copy up to `fromDate` (OMS time),
   * including one the background still holds. */
  release(sessionId, fromDate) {
    return this.update(state => {
      const leases = {...state.leases}; delete leases[sessionId];
      return {...state, leases, released: fromDate == null ? state.released : {...state.released, [sessionId]: fromDate}};
    });
  }
  /** Move a value an earlier release stored under its own key into control. */
  async adopt(field, id, name, convert = value => value, legacyId = id) {
    const key = legacyKey(this.owner, name, legacyId), value = await this.native.get(key);
    if (value == null) return (await this.read())[field][id];
    if ((await this.read())[field][id] == null) await this.setEntry(field, id, convert(value));
    await this.native.delete(key);
    return (await this.read())[field][id];
  }
}

export async function readMailbox(native, owner) {
  return {receipts: {}, leases: {}, released: {}, status: null, ...await native.get(mailboxKey(owner))};
}
