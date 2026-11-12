import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountLease} from '../extensions/hotwax-cycle-count/src/count-lease.js';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';

// A product found through the catalog search is counted from its row: setting its
// quantity adds it to the session, with no separate Hand count step.
function fixture(countType: string) {
  const data = new Map();
  const storage = {get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => {data.set(key, structuredClone(value));}, delete: async (key: string) => {data.delete(key);}};
  const lease = new CountLease(storage, 'owner', async () => ({owned: true, available: false, deviceId: 'POS_1', fromDate: 1000, expiresAt: Date.now() + 150000}), () => {}, () => false);
  const state = new CountState(storage, 'owner', async () => {throw Error('No lookup is needed for a known product.');}, () => {}, {deviceId: 'POS_1'}, () => lease.assertCanScan('session', 'POS_1'));
  return {lease, state, count: {sessionId: 'session', editable: true, countType, items: []}};
}

test('setting a quantity on a catalog product adds it to a dynamic session', async () => {
  const f = fixture('DYNAMIC_COUNT');
  await f.state.open(f.count); await f.lease.open('session');
  await f.state.append({productId: 'P9', code: 'SKU-9', source: 'correction', quantity: 3, product: {productId: 'P9', title: 'New chain', sku: 'SKU-9'}});
  await f.state.aggregate();
  assert.equal(f.state.items.items.P9.quantity, 3);
  assert.equal(f.state.items.items.P9.isRequested, true);
});

test('a confirmed zero adds the product as counted, not uncounted', async () => {
  const f = fixture('DYNAMIC_COUNT');
  await f.state.open(f.count); await f.lease.open('session');
  await f.state.append({productId: 'P9', code: 'SKU-9', source: 'correction', quantity: 0, product: {productId: 'P9', title: 'New chain', sku: 'SKU-9'}});
  await f.state.aggregate();
  assert.equal(f.state.items.items.P9.quantity, 0);
});
