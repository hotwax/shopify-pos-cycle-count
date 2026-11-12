import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {
  batchMatchesItem, inventorySyncSummary, omsSession, productSyncEvents, proposedVariances, pushInventoryBatches,
  readEvent, recentInventoryEvents, type Location,
} from '../extensions/hotwax-store-inventory/src/Inventory';
import {projectShopify} from '../extensions/hotwax-store-inventory/src/InventoryProjection';

// Fixture responses in the shapes shopify-connector v4.4.0+ and the cycle count API return. They do not
// stand in for a live OMS: the ledgers are entity lists, bare arrays paged with pageIndex/pageSize.
const location: Location = {shopId: '10000', productStoreId: 'STORE', locationId: '455', facilityId: '49', name: 'Brooklyn',
  session: {token: async () => 'oms-token'}, canPush: true};
const row = (seq: number, item = '77', extra: Record<string, unknown> = {}) => ({
  shopifyInventoryAdjustmentId: 'ADJ' + Math.floor(seq / 1000), shopifyInventoryAdjustmentSeqId: seq,
  shopId: '10000', shopifyLocationId: '455', shopifyInventoryItemId: item, computedInventoryChange: -1,
  resetInventoryLevel: 'N', eventTypeId: 'SALE', eventReferenceId: 'ORD' + seq, createdDate: 1700000000000 + seq, ...extra,
});
type Handler = (url: URL, init?: RequestInit) => unknown;
let handle: Handler = () => [];
const urls: URL[] = [];
// The extension folder has its own package.json without "type": "module", so Inventory loads the
// connection module through require; configure that same instance.
createRequire(import.meta.url)('../shared/oms-connection.ts').configureDirectOms('https://oms.example.com');
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  urls.push(url);
  const body = handle(url, init);
  return {ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)};
}) as typeof fetch;
const signal = new AbortController().signal;
const ledgerPages = (pages: unknown[]): Handler => url => pages[Number(url.searchParams.get('pageIndex'))] ?? [];

test('recent events ask the OMS for this store, item and unsent status, newest first', async () => {
  urls.length = 0;
  handle = ledgerPages([[row(2), row(1, '88')]]);
  const {events, more} = await recentInventoryEvents(location, signal, {status: 'unsent'}, '77');
  assert.deepEqual(events.map(event => event.reference), ['ORD2']);
  assert.equal(more, false);
  const query = urls[0].searchParams;
  assert.equal(urls[0].pathname, '/rest/s1/sob/shopify/locationInventoryAdjustmentDetails');
  assert.deepEqual(Object.fromEntries(query), {
    shopId: '10000', shopifyLocationId: '455', shopifyInventoryItemId: '77',
    systemMessageStatusId: 'SmsgSent,SmsgConfirmed,SmsgCancelled', systemMessageStatusId_op: 'in', systemMessageStatusId_not: 'Y',
    orderByField: '-createdDate,shopifyInventoryAdjustmentId,shopifyInventoryAdjustmentSeqId', pageSize: '500', pageIndex: '0',
  });
});

test('filters reach the OMS: event type, creation time and order, always for this store', async () => {
  urls.length = 0;
  handle = ledgerPages([[]]);
  await recentInventoryEvents(location, signal, {status: 'all', eventType: 'RECEIPT', since: 1700000000000, oldestFirst: true}, '77');
  const query = urls[0].searchParams;
  assert.equal(urls[0].pathname, '/rest/s1/sob/shopify/locationInventoryAdjustmentDetails');
  assert.equal(query.get('shopifyLocationId'), '455');
  assert.equal(query.get('systemMessageStatusId'), null);
  assert.deepEqual([query.get('eventTypeId'), query.get('createdDate_from'), query.get('orderByField')?.split(',')[0]],
    ['RECEIPT', '1700000000000', 'createdDate']);
});

test('an empty ledger is no events, and a response that is not a list of rows is refused', async () => {
  handle = ledgerPages([[]]);
  assert.deepEqual((await recentInventoryEvents(location, signal, undefined, '77')).events, []);
  handle = () => ({details: []});
  await assert.rejects(recentInventoryEvents(location, signal, undefined, '77'), /incomplete inventory ledger/);
});

test('delivery states: no message waits, a purged message has no record, a failed one needs attention', () => {
  assert.equal(readEvent(row(1)).state, 'Unbatched');
  assert.equal(readEvent(row(1, '77', {systemMessageId: 'M1', systemMessageStatusId: 'SmsgProduced'})).state, 'Queued');
  assert.equal(readEvent(row(1, '77', {systemMessageId: 'M1'})).state, 'Missing');
  const failed = readEvent(row(1, '77', {systemMessageId: 'M1', systemMessageStatusId: 'SmsgError', systemMessageFailCount: 3}));
  assert.deepEqual([failed.state, failed.failCount], ['Error', 3]);
});

test('the complete unsent ledger for an item pages until a short page and refuses a row seen twice', async () => {
  urls.length = 0;
  handle = ledgerPages([Array.from({length: 500}, (_, seq) => row(seq)), [row(600)]]);
  assert.equal((await productSyncEvents(location, '77', signal)).length, 501);
  assert.deepEqual(urls.map(url => url.searchParams.get('pageIndex')), ['0', '1']);
  assert.equal(urls[0].searchParams.get('shopifyInventoryItemId'), '77');
  handle = ledgerPages([Array.from({length: 500}, (_, seq) => row(seq)), [row(499)]]);
  await assert.rejects(productSyncEvents(location, '77', signal), /changed while loading/);
});

test('the sync summary reads unsent changes and the last hour of sent ones, not the whole ledger', async () => {
  urls.length = 0;
  const now = Date.now();
  handle = url => url.searchParams.get('systemMessageStatusId_op') === 'in'
    ? [row(1, '77', {createdDate: now - 3 * 60 * 60 * 1000}), row(2, '77', {systemMessageId: 'M2', systemMessageStatusId: 'SmsgError', createdDate: now - 60000})]
    : [row(3, '77', {systemMessageId: 'M3', systemMessageStatusId: 'SmsgSent', createdDate: now - 120000, systemMessageProcessedDate: now - 60000})];
  const summary = await inventorySyncSummary(location, signal);
  assert.deepEqual([summary.pendingCount, summary.attentionCount, summary.syncedCount, summary.averageSyncMs],
    [2, 1, 1, 60000]);
  assert.equal(summary.oldestPendingAt, now - 3 * 60 * 60 * 1000);
  const sent = urls.find(url => url.searchParams.get('systemMessageStatusId') === 'SmsgSent')!;
  assert.ok(Number(sent.searchParams.get('systemMessageProcessedDate_from')) >= now - 60 * 60 * 1000);
});

test('a queued batch matches this item in both the per-item and the per-event message formats', () => {
  const legacy = {isOutgoing: 'Y', systemMessageTypeId: 'ShopifyLocationInventoryAdjustment', messageText: JSON.stringify(
    {variables: {input: {changes: [{inventoryItemId: 'gid://shopify/InventoryItem/77', locationId: 'gid://shopify/Location/455'}]}}})};
  const event = {isOutgoing: 'Y', systemMessageTypeId: 'ShopifyInventoryAdjustment',
    messageText: JSON.stringify({format: 'header', shopifyInventoryAdjustmentId: 'ADJ0', calls: []})};
  assert.equal(batchMatchesItem(legacy, '77', '455', new Set()), true);
  assert.equal(batchMatchesItem(legacy, '78', '455', new Set()), false);
  assert.equal(batchMatchesItem(event, '77', '455', new Set(['ADJ0'])), true);
  assert.equal(batchMatchesItem(event, '77', '455', new Set(['ADJ9'])), false);
  assert.equal(batchMatchesItem({...event, isOutgoing: 'N'}, '77', '455', new Set(['ADJ0'])), false);
});

test('send now delivers a per-event batch and confirms it, and refuses staff without the permission', async () => {
  const sent: string[] = [];
  let status = 'SmsgProduced';
  handle = (url, init) => {
    if (url.pathname.endsWith('/send')) {sent.push(url.pathname); status = 'SmsgSent'; return {};}
    if (url.pathname.startsWith('/rest/s1/admin/systemMessages/')) return {systemMessageId: 'M1', statusId: status, isOutgoing: 'Y',
      systemMessageTypeId: 'ShopifyInventoryAdjustment', processedDate: 1700000009000,
      messageText: JSON.stringify({format: 'header', shopifyInventoryAdjustmentId: 'ADJ0', calls: []})};
    return [row(1, '77', {systemMessageId: 'M1', systemMessageStatusId: 'SmsgProduced', systemMessageTypeId: 'ShopifyInventoryAdjustment'})];
  };
  const result = await pushInventoryBatches(location, '77', ['M1'], () => true, signal, () => {});
  assert.deepEqual(result, {sent: 1, error: ''});
  assert.deepEqual(sent, ['/rest/s1/admin/systemMessages/M1/send']);
  const denied = await pushInventoryBatches({...location, canPush: false}, '77', ['M1'], () => true, signal, () => {});
  assert.match(denied.error, /cannot send/);
});

test('the OMS sign-in renews after an hour and retries a failed renewal on the next read', async () => {
  let clock = 0, logins = 0, fail = true;
  const session = omsSession('first', async () => {logins++; if (fail) throw new Error('offline'); return 'renewed';}, () => clock);
  assert.equal(await session.token(), 'first');
  clock = 60 * 60 * 1000;
  await assert.rejects(session.token(), /offline/);
  fail = false;
  assert.equal(await session.token(), 'renewed');
  assert.equal(await session.token(), 'renewed');
  assert.equal(logins, 2);
});

test('counted quantities come from session totals, not the review sum that joins can multiply', async () => {
  handle = url => {
    const path = url.pathname;
    if (path.endsWith('/workEfforts')) return {cycleCounts: [{workEffortId: 'C1', facilityId: '49', statusId: 'CYCLE_CNT_CMPLTD', workEffortName: 'Weekly'}]};
    // The review sum is doubled by a second store's price row.
    if (path.endsWith('/reviews')) return [{workEffortId: 'C1', facilityId: '49', productId: 'P1', quantity: 6, systemQuantityOnHand: 1, proposedVarianceQuantity: 5}];
    if (path.endsWith('/count')) return [{productId: 'P1', inventoryCountImportId: 'S1', statusId: 'SESSION_SUBMITTED', counted: 3}];
    if (path === '/rest/s1/admin/search/query') return {response: {docs: [], numFound: 0}};
    return [];
  };
  const [variance] = await proposedVariances(location, signal, 'P1');
  assert.deepEqual([variance.counted, variance.delta, variance.product.inShopify], [3, 2, false]);
});

test('the result after sync leaves out changes with no delivery record and refuses failed ones', () => {
  const level = {available: 5, onHand: 6, committed: 1, checkedAt: 0};
  const waiting = readEvent(row(1, '77', {computedInventoryChange: -2}));
  const missing = readEvent(row(2, '77', {systemMessageId: 'M2', computedInventoryChange: -1}));
  assert.deepEqual(projectShopify(level, [waiting, missing]), {available: 3, onHand: 4, unknown: 1});
  const failed = readEvent(row(3, '77', {systemMessageId: 'M3', systemMessageStatusId: 'SmsgError'}));
  assert.throws(() => projectShopify(level, [failed]), /needs attention/);
});
