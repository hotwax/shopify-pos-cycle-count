// A Storage API double for durability tests. Every value round-trips through
// JSON (as the host serializes it), the 100-entry and ~1 MB limits are enforced
// with StorageError-shaped rejections, and any write can be made to fail before
// or after it is stored. It is still an in-memory model, not device evidence.
import {utf8} from '../extensions/hotwax-cycle-count/src/count-storage.js';

export function fakeKV({entries = 100, valueBytes = 1000000} = {}) {
  const data = new Map<string, string>();
  let sets = 0, failAt = 0, afterWrite = false, reads = 0;
  const writes: string[] = [], readKeys: string[] = [];
  const native = {
    get: async (key: string) => {reads++; readKeys.push(key); return data.has(key) ? JSON.parse(data.get(key)!) : undefined;},
    set: async (key: string, value: unknown) => {
      sets++;
      const json = JSON.stringify(value);
      if (sets === failAt && !afterWrite) throw Object.assign(new Error('disk interrupted'), {name: 'Interrupted'});
      if (!data.has(key) && data.size >= entries) throw Object.assign(new Error('Too many records'), {name: 'StorageError', code: 'RecordsCount'});
      if (utf8(json) > valueBytes) throw Object.assign(new Error('Record too large'), {name: 'StorageError', code: 'RecordSize'});
      data.set(key, json); writes.push(key);
      if (sets === failAt && afterWrite) throw new Error('acknowledgement lost');
    },
    delete: async (key: string) => data.delete(key),
  };
  return {
    native, data, writes, readKeys,
    value: (key: string) => data.has(key) ? JSON.parse(data.get(key)!) : undefined,
    keys: () => [...data.keys()],
    reads: () => reads,
    /** Fail the nth `set` from now; with `after`, the value is stored but the call still rejects. */
    failOn(n: number, after = false) {sets = 0; failAt = n; afterWrite = after;},
    heal() {failAt = 0;},
    snapshot: () => new Map(data),
    restore(saved: Map<string, string>) {data.clear(); for (const [key, value] of saved) data.set(key, value);},
  };
}
