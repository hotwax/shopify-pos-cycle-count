import assert from 'node:assert/strict';
import {test} from 'node:test';
import {manageLease, LEASE_SECONDS} from '../shared/oms-count-lease';

const USER = 'M100051', HERE = 'POS_1', OTHER = 'POS_2';

/** An OMS lock table for one session: POST creates, PUT on /lock renews, PUT on /release ends a row. */
function fakeOms(rows: any[]) {
  const locks = rows.map(row => ({...row}));
  const writes: string[] = [];
  let clock = Math.max(0, ...locks.map(row => row.fromDate));
  const oms = {
    async get() { return [...locks].sort((a, b) => b.fromDate - a.fromDate).map(row => ({...row})); },
    async mutate(path: string, body: any, method = 'POST') {
      writes.push(`${method} ${path.split('/').pop()}`);
      if (method === 'POST') locks.push({fromDate: Math.min(Date.now(), ++clock), deviceId: body.deviceId, userId: body.userId,
        thruDate: body.thruDate, lastHeartbeatAt: body.lastHeartbeatAt});
      else Object.assign(locks.find(row => row.fromDate === body.fromDate)!, path.endsWith('/release')
        ? {thruDate: body.thruDate} : {thruDate: body.thruDate, lastHeartbeatAt: body.lastHeartbeatAt});
      return {};
    },
  };
  return {oms: oms as any, locks, writes};
}
const now = Date.now();
const row = (fromDate: number, deviceId: string, thruDate: number) => ({fromDate, deviceId, userId: USER, thruDate});

test('reopening a session this register holds extends the lease instead of inheriting its last seconds', async () => {
  const {oms, writes} = fakeOms([row(now - 1_000_000, HERE, now + 5_000)]);
  const lease = await manageLease('leaseClaim', 'S1', USER, HERE, undefined, oms);
  assert.equal(lease.owned, true);
  assert.ok(lease.expiresAt! > now + (LEASE_SECONDS - 5) * 1000, 'the reopened lease runs for a full term');
  assert.deepEqual(writes, ['PUT lock']);
});

test('a session locked on another register is reported as such and left untouched', async () => {
  const {oms, writes} = fakeOms([row(now - 1_000, OTHER, now + 100_000)]);
  const lease = await manageLease('leaseClaim', 'S1', USER, HERE, undefined, oms);
  assert.equal(lease.owned, false);
  assert.equal(lease.available, false);
  assert.deepEqual(writes, []);
});

test('a heartbeat after this register’s own lease expired takes the session again when nobody else locked it', async () => {
  const mine = row(now - 400_000, HERE, now - 10_000);
  const {oms} = fakeOms([mine]);
  const lease = await manageLease('leaseRenew', 'S1', USER, HERE, mine, oms, true);
  assert.equal(lease.owned, true);
  assert.notEqual(lease.fromDate, mine.fromDate, 'a new lease is issued');
});

test('a lock taken by another register after ours still fences this terminal, even once released', async () => {
  const mine = row(now - 400_000, HERE, now - 300_000);
  const {oms} = fakeOms([mine, row(now - 200_000, OTHER, now - 100_000)]);
  await assert.rejects(manageLease('leaseRenew', 'S1', USER, HERE, mine, oms, true), (error: any) => error.leaseLost === true);
});

test('a write never re-acquires an expired lease, because it keeps using the lease it sent', async () => {
  const mine = row(now - 400_000, HERE, now - 10_000);
  const {oms, writes} = fakeOms([mine]);
  await assert.rejects(manageLease('leaseRenew', 'S1', USER, HERE, mine, oms), (error: any) => error.leaseLost === true);
  assert.deepEqual(writes, []);
});

test('a heartbeat adopts a newer lease that this same register’s background uploader took', async () => {
  const older = row(now - 400_000, HERE, now - 10_000), newer = row(now - 5_000, HERE, now + 100_000);
  const {oms} = fakeOms([older, newer]);
  const lease = await manageLease('leaseRenew', 'S1', USER, HERE, older, oms, true);
  assert.equal(lease.owned, true);
  assert.equal(lease.fromDate, newer.fromDate);
});
