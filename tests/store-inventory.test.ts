import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inventoryScope, sameInventoryScope, availableTarget, commitInventoryReview} from '../shared/store-inventory';

const register = {shopDomain: 'gorjana-sandbox.myshopify.com', shopId: 7, locationId: 9, userId: 11, staffId: 13};
const scope = inventoryScope(register);

test('inventory scope requires the Gorjana sandbox and a pinned staff identity', () => {
  assert.equal(scope.staffId, '13');
  assert.throws(() => inventoryScope({...register, shopDomain: 'gorjana.myshopify.com'}), /sandbox/);
  assert.throws(() => inventoryScope({...register, staffId: undefined}), /staff/);
  assert.equal(sameInventoryScope(scope, inventoryScope({...register, staffId: 14})), false);
  assert.equal(sameInventoryScope(scope, inventoryScope({...register, locationId: 10})), false);
});

test('available targets accept zero and reject non-inventory input', () => {
  assert.equal(availableTarget('0'), 0);
  assert.equal(availableTarget(' 9 '), 9);
  for (const invalid of ['', '-1', '1.5', '1e2', '2147483648']) {
    assert.throws(() => availableTarget(invalid), /whole number/);
  }
});

test('commit remembers the reviewed operation before sending and recovers the same ID', async () => {
  const events: string[] = [];
  const operation = await commitInventoryReview('review-1', {
    remember: async id => {events.push('remember ' + id);},
    commit: async id => {events.push('commit ' + id); throw new Error('Connection lost');},
    status: async id => {events.push('status ' + id); return {operationId: id, state: 'saved'};}
  });
  assert.deepEqual(events, ['remember review-1','commit review-1','status review-1']);
  assert.deepEqual(operation, {operationId: 'review-1', state: 'saved'});
});

test('a failure to remember the operation prevents a write', async () => {
  await assert.rejects(commitInventoryReview('review-1', {
    remember: async () => {throw new Error('Storage unavailable');},
    commit: async () => {assert.fail('commit must wait for storage');},
    status: async () => {assert.fail('status must wait for storage');}
  }), /Storage unavailable/);
});
