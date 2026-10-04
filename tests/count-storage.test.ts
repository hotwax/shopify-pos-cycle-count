import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountStorage, utf8} from '../extensions/hotwax-cycle-count/src/count-storage.js';
import {fakeKV} from './kv.ts';

const key = 'hotwax-count:owner:session:S1:scan-events', itemKey = 'hotwax-count:owner:session:S1:count-items';
const event = (id: number, pad = 0) => ({id, scannedValue: `barcode-${id}${'x'.repeat(pad)}`, quantity: 1, mode: 'add', source: 'external', createdAt: id, aggApplied: 1});
const events = (n: number, pad = 0) => Array.from({length: n}, (_, i) => event(i + 1, pad));
const header = {version: 2, sessionId: 'S1', nextId: 1};
const byId = (record: any) => record.id, byProduct = (record: any) => record.productId;
const saveEvents = (storage: CountStorage, records: any[]) => storage.save(key, {header, records, keyOf: byId});
const valueBytes = (kv: ReturnType<typeof fakeKV>) => kv.keys().map(k => utf8(kv.data.get(k)!));

test('a small document is one value; 801 events or 401 items alone add no key', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native);
  await saveEvents(storage, events(801));
  await storage.save(itemKey, {header: {version: 2, sessionId: 'S1', applied: {}}, records: Array.from({length: 401}, (_, i) => ({productId: `P${i}`, quantity: i})), keyOf: byProduct, move: true});
  assert.deepEqual(kv.keys().sort(), [itemKey, key].sort());
  assert.equal(kv.value(key).format, 'hotwax-count-3');
  assert.equal(kv.value(key).header.version, 2);
  // An earlier release that finds no top-level version refuses the value and keeps it.
  assert.equal(kv.value(key).version, undefined);
  assert.deepEqual((await new CountStorage(kv.native).load(key))!.records, events(801));
});

test('overflow starts only near the byte limit, keeps chronology and an append rewrites one value', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native), records = events(6000, 300);
  await saveEvents(storage, records);
  assert.ok(kv.keys().length > 1 && kv.keys().length < 5, kv.keys().join());
  assert.ok(valueBytes(kv).every(bytes => bytes <= 900000));
  assert.deepEqual((await new CountStorage(kv.native).load(key))!.records.map(byId), records.map(byId));
  kv.writes.length = 0;
  await saveEvents(storage, [...records, event(6001)]);
  assert.deepEqual(kv.writes, [key]);
});

test('changing an older event rewrites only its overflow value, in the other slot, then the root', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native), records = events(6000, 300);
  await saveEvents(storage, records);
  const before = kv.keys().length, root = kv.value(key), slot = `${key}:more:${root.more[0].n}${root.more[0].slot}`;
  kv.writes.length = 0;
  const changed = [...records]; changed[0] = {...changed[0], aggApplied: -1};
  await saveEvents(storage, changed);
  assert.equal(kv.writes.length, 2); assert.equal(kv.writes[1], key);
  assert.notEqual(kv.writes[0], slot); assert.equal(kv.data.has(slot), false);
  assert.equal(kv.keys().length, before);
  assert.equal((await new CountStorage(kv.native).load(key))!.records[0].aggApplied, -1);
});

test('a crash at any write of a multi-value commit leaves the old or the new document, never a mix', async () => {
  const records = events(6000, 300), changed = [...records, ...events(7000, 300).slice(6000)];
  changed[0] = {...changed[0], aggApplied: -1};
  for (let failAt = 1; failAt <= 6; failAt++) for (const after of [false, true]) {
    const kv = fakeKV(), storage = new CountStorage(kv.native);
    await saveEvents(storage, records);
    kv.failOn(failAt, after);
    let acknowledged = false;
    try {await saveEvents(storage, changed); acknowledged = true;} catch {}
    kv.heal();
    const reader = new CountStorage(kv.native), loaded = (await reader.load(key))!.records;
    assert.equal(JSON.stringify(loaded), JSON.stringify(acknowledged ? changed : records), `failAt ${failAt} after ${after}`);
    // The load removed every value the committed root does not reference.
    const root = kv.value(key), expected = new Set([key, ...root.more.map((ref: any) => `${key}:more:${ref.n}${ref.slot}`)]);
    assert.deepEqual(kv.keys().sort(), [...expected].sort(), `failAt ${failAt} after ${after}`);
  }
});

test('a lost acknowledgement of the root write is reconciled as committed', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native);
  await saveEvents(storage, events(1));
  kv.failOn(1, true);
  await saveEvents(storage, events(2));
  kv.heal();
  assert.deepEqual((await new CountStorage(kv.native).load(key))!.records, events(2));
});

test('an updated item moves back to the root, so later updates rewrite only the root', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native);
  const items = Array.from({length: 3000}, (_, i) => ({productId: `P${i}`, quantity: i, codes: [`${'c'.repeat(300)}${i}`]}));
  const save = (records: any[]) => storage.save(itemKey, {header: {version: 2, sessionId: 'S1', applied: {}}, records, keyOf: byProduct, move: true});
  await save(items);
  assert.ok(kv.keys().length > 1);
  const moved = [...items]; moved[0] = {...moved[0], quantity: 99};
  await save(moved);
  assert.ok(kv.value(itemKey).data.some((item: any) => item.productId === 'P0' && item.quantity === 99));
  kv.writes.length = 0;
  moved[0] = {...moved[0], quantity: 100};
  await save(moved);
  assert.deepEqual(kv.writes, [itemKey]);
  const loaded = new Map((await new CountStorage(kv.native).load(itemKey))!.records.map((item: any) => [item.productId, item]));
  assert.equal(loaded.size, 3000); assert.equal((loaded.get('P0') as any).quantity, 100);
});

test('a paged document from the earlier release migrates in place, finishing its interrupted commit', async () => {
  const kv = fakeKV(), legacy = 'hotwax-count-pages-1';
  const page0 = `${key}:page:g1:0`, page1 = `${key}:page:g1:1`, orphan = `${key}:page:g2:1`;
  kv.data.set(page0, JSON.stringify(JSON.stringify(events(800).map(e => ({...e, shopifyProduct: {title: 'T'}})))));
  kv.data.set(page1, JSON.stringify(JSON.stringify([event(801)])));
  kv.data.set(orphan, JSON.stringify(JSON.stringify([event(801), event(802)])));
  kv.data.set(key, JSON.stringify(JSON.stringify({format: legacy, generation: 'g1', kind: 'events', header, pages: {0: page0, 1: page1}, summary: {pendingCount: 0, eventCount: 801}})));
  kv.data.set(`${key}:transaction`, JSON.stringify(JSON.stringify({format: legacy, generation: 'g2', created: [orphan], retired: [page1]})));
  const storage = new CountStorage(kv.native), doc = (await storage.load(key))!;
  assert.equal(doc.legacy, true); assert.equal(doc.records.length, 801);
  assert.equal(kv.data.has(orphan), false); assert.equal(kv.data.has(`${key}:transaction`), false);
  // The new root reuses the manifest's key; the old pages go only after it commits.
  await storage.save(key, {header: doc.header, records: doc.records.map(({shopifyProduct, ...rest}: any) => rest), keyOf: byId, retire: doc.retire});
  assert.deepEqual(kv.keys(), [key]);
  assert.equal((await new CountStorage(kv.native).load(key))!.records.length, 801);
});

test('a full device rejects the commit and keeps the committed document without orphans', async () => {
  const kv = fakeKV({entries: 2}), storage = new CountStorage(kv.native);
  await saveEvents(storage, events(10));
  kv.data.set('other-operator', JSON.stringify('keep'));
  await assert.rejects(saveEvents(storage, events(6000, 300)), /no free count storage/);
  assert.deepEqual(kv.keys().sort(), [key, 'other-operator'].sort());
  assert.deepEqual((await new CountStorage(kv.native).load(key))!.records, events(10));
});

test('removal is resumable and the background reader never writes', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native);
  await saveEvents(storage, events(6000, 300));
  const root = kv.value(key);
  // An interrupted removal leaves only its marker and some overflow behind.
  kv.data.set(key, JSON.stringify({format: 'hotwax-count-3', removed: true, hw: root.hw, retire: []}));
  assert.equal(await new CountStorage(kv.native).peek(key), undefined);
  assert.equal((await new CountStorage(kv.native).metadata(key)).header, undefined);
  assert.equal(await new CountStorage(kv.native).load(key), undefined);
  assert.deepEqual(kv.keys(), []);
  await saveEvents(new CountStorage(kv.native), events(6000, 300));
  const writes = kv.writes.length, changing = kv.value(key);
  kv.data.set(`${key}:more:${changing.more[0].n}${changing.more[0].slot}`, JSON.stringify({format: 'hotwax-count-3', of: key, stamp: 'other', data: []}));
  await assert.rejects(new CountStorage(kv.native).peek(key), /changing/);
  assert.equal(kv.writes.length, writes);
});
