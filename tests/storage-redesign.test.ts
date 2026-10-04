import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountStorage, utf8} from '../extensions/hotwax-cycle-count/src/count-storage.js';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {ControlStore, controlKey, mailboxKey, storedLease} from '../extensions/hotwax-cycle-count/src/count-control.js';
import {CountLease} from '../extensions/hotwax-cycle-count/src/count-lease.js';
import {IdentityMap, IDENTITY_KEY} from '../extensions/hotwax-cycle-count/src/count-identity.js';
import {syncBackground} from '../extensions/hotwax-cycle-count/src/count-background.js';
import {createMemberSearch} from '../extensions/hotwax-cycle-count/src/scan-products.ts';
import {fakeKV} from './kv.ts';

// Local storage and state behaviour with fixture responses; device storage and
// OMS behaviour are verified separately on hardware.
const owner = 'shop:location:staff';
const count = (sessionId = 'S1', items: any[] = []) => ({sessionId, workEffortId: 'W1', name: 'Front', editable: true, countType: 'HARD_COUNT', statusId: 'SESSION_ASSIGNED', items});
const lookup = async (action: string, payload: any) => action === 'saveBatch' ? {items: payload.items} : {productId: `P-${payload.code}`, sku: payload.code, title: `Name ${payload.code}`};
const display = ['Name ', 'title', 'imageUrl', 'shopifyProduct', '"product"', 'primary'];

test('the earlier catalogue becomes control in place, so upgrading needs no free entry and older runtimes see no sessions', async () => {
  const kv = fakeKV({entries: 2});
  kv.data.set(controlKey(owner), JSON.stringify({active: 'S1', sessions: [{sessionId: 'S1', itemKey: 'i', eventKey: 'e'}]}));
  kv.data.set(`hotwax-count:${owner}:status`, JSON.stringify({at: 1}));
  const state = await new ControlStore(kv.native, owner).read();
  assert.deepEqual(state.catalogue.map((entry: any) => entry.sessionId), ['S1']);
  const stored = kv.value(controlKey(owner));
  assert.equal(stored.sessions, undefined); assert.equal(stored.catalogue[0].itemKey, 'i');
  assert.deepEqual(kv.keys(), [controlKey(owner)]);
});

test('each control write applies to what storage holds, so another modal runtime’s entries survive', async () => {
  const kv = fakeKV(), one = new ControlStore(kv.native, owner), two = new ControlStore(kv.native, owner);
  await one.read(); await two.read();
  await one.setEntry('decisions', 'W1', {action: 'confirmZero'});
  await two.setEntry('drafts', 'S1', {id: 'hand-1', entries: []});
  const stored = kv.value(controlKey(owner));
  assert.deepEqual(Object.keys(stored.decisions), ['W1']); assert.deepEqual(Object.keys(stored.drafts), ['S1']);
  await one.setEntry('decisions', 'W1', null); await two.setEntry('drafts', 'S1', null);
  assert.equal(kv.data.has(controlKey(owner)), false);
});

test('a released or lost lease is fenced in both runtimes and never authorizes offline scans again', async () => {
  const lease = {owned: true, available: false, deviceId: 'POS_1', fromDate: 5000, expiresAt: Date.now() + 150000};
  assert.equal(storedLease({leases: {S1: lease}, released: {S1: 5000}}, {}, 'S1'), undefined);
  assert.equal(storedLease({leases: {}, released: {}}, {leases: {S1: lease}, released: {S1: 5000}}, 'S1'), undefined);
  assert.equal(storedLease({leases: {S1: {...lease, fromDate: 6000}}, released: {S1: 5000}}, {leases: {S1: lease}}, 'S1')!.fromDate, 6000);
  const kv = fakeKV();
  let reply: any = lease;
  const claim = new CountLease(kv.native, owner, async () => {if (reply instanceof Error) throw reply; return reply;}, () => {}, () => false);
  await claim.open('S1');
  assert.equal(claim.canScan('S1', 'POS_1'), true);
  reply = Object.assign(new Error('This device no longer owns the session.'), {status: 409, leaseLost: true});
  await assert.rejects(claim.renew(), /no longer owns/);
  const offline = new CountLease(kv.native, owner, async () => lease, () => {}, () => true);
  await offline.open('S1', true);
  assert.equal(offline.canScan('S1', 'POS_1'), false);
});

test('an unsynced session saved by the previous release reopens with its scans, quantities and receipts, and keeps no display data', async () => {
  const kv = fakeKV(), legacy = 'hotwax-count-pages-1', prefix = `hotwax-count:${owner}:session:S1`;
  const eventKey = `${prefix}:scan-events`, itemKey = `${prefix}:count-items`;
  const events = [
    {id: 1, scannedValue: 'A', productId: 'PA', quantity: 2, mode: 'add', source: 'external', createdAt: 1, aggApplied: 1, staffId: 's', deviceId: 'POS_1', shopifyProduct: {shopifyVariantId: 11, title: 'Shirt A', imageUrl: 'a.jpg'}},
    {id: 2, scannedValue: 'B', productId: null, quantity: 1, mode: 'add', source: 'external', createdAt: 2, aggApplied: 0, staffId: 's', deviceId: 'POS_1', product: {productId: 'PB', title: 'Shoe B'}},
  ];
  const items = {PA: {productId: 'PA', title: 'Shirt A', sku: 'A', imageUrl: 'a.jpg', productIdentifier: 'A', codes: ['A'], quantity: 2, revision: 2, syncedRevision: 1, serverQuantity: 1, lastCorrectionId: 0, uuid: 'x', onHand: 9}};
  kv.data.set(`${eventKey}:page:g:0`, JSON.stringify(JSON.stringify(events)));
  kv.data.set(eventKey, JSON.stringify(JSON.stringify({format: legacy, generation: 'g', kind: 'events', header: {version: 2, sessionId: 'S1', nextId: 3}, pages: {0: `${eventKey}:page:g:0`}, summary: {pendingCount: 1, eventCount: 2}})));
  kv.data.set(`${itemKey}:page:g:3`, JSON.stringify(JSON.stringify(items)));
  kv.data.set(itemKey, JSON.stringify(JSON.stringify({format: legacy, generation: 'g', kind: 'items', header: {version: 2, sessionId: 'S1', applied: {}, count: {...count(), audit: {deviceId: 'POS_1'}}}, pages: {3: `${itemKey}:page:g:3`}, buckets: 16})));
  kv.data.set(`${itemKey}:receipts`, JSON.stringify({items: {PA: {revision: 2, quantity: 2, at: 1}}}));
  kv.data.set(controlKey(owner), JSON.stringify({sessions: [{sessionId: 'S1', workEffortId: 'W1', itemKey, eventKey}]}));
  kv.data.set(`hotwax-count:${owner}:lease:S1`, JSON.stringify({owned: true, fromDate: 1, deviceId: 'POS_1', expiresAt: 1}));
  const state = new CountState(kv.native, owner, lookup, () => {}, {deviceId: 'POS_1'});
  await state.open(count());
  assert.equal(state.items.items.PA.quantity, 2); assert.equal(state.items.items.PA.syncedRevision, 2);
  assert.equal(state.events.events[1].aggApplied, 0); assert.equal(state.events.events[0].variantId, 11);
  assert.equal(state.view(state.items.items.PA).title, 'Shirt A');
  await state.aggregate();
  assert.equal(state.items.items.PB.quantity, 1);
  const saved = [...kv.data.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value).join();
  for (const field of display) assert.equal(saved.includes(field), false, field);
  assert.deepEqual(kv.keys().filter(key => key.startsWith(prefix)).sort(), [eventKey, itemKey].sort());
  // The earlier lease key moves into control on first use.
  await new CountLease(kv.native, owner, async () => ({owned: false, available: true}), () => {}, () => true).open('S1', true);
  assert.equal(kv.data.has(`hotwax-count:${owner}:lease:S1`), false);
});

test('a variant already mapped to HotWax skips the HotWax lookup; another OMS connection starts a new map', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native), identity = new IdentityMap(storage);
  await identity.load({shop: '1', oms: 'https://a.example'});
  identity.add(20, 'P20');
  await identity.flush();
  let lookups = 0;
  const request: any = async () => {lookups++; throw new Error('HotWax lookup should be skipped');};
  request.lookupIdentityBatch = async () => {lookups++; return {matches: [], errors: []};};
  request.enrichScan = async () => ({shopifyVariantId: 20, title: 'Mapped', sku: 'M', imageUrl: ''});
  const reloaded = new IdentityMap(new CountStorage(kv.native));
  await reloaded.load({shop: '1', oms: 'https://a.example'});
  const state = new CountState(kv.native, owner, request, () => {}, {}, () => {}, {identity: reloaded});
  await state.open(count());
  await state.append({code: '0001', source: 'external'}); await state.aggregate();
  assert.equal(lookups, 0); assert.equal(state.items.items.P20.quantity, 1); assert.equal(state.items.items.P20.variantId, 20);
  const other = new IdentityMap(new CountStorage(kv.native));
  await other.load({shop: '1', oms: 'https://b.example'});
  assert.equal(other.get(20), undefined);
  assert.equal(kv.value(IDENTITY_KEY).format, 'hotwax-count-3');
});

test('only countable HotWax products are paired with their Shopify variant', async () => {
  const kv = fakeKV(), identity = new IdentityMap(new CountStorage(kv.native));
  await identity.load({shop: '1', oms: 'https://a.example'});
  const state = new CountState(kv.native, owner, lookup, () => {}, {}, () => {}, {identity});
  await state.open(count('S1', [
    {productId: 'DISCONTINUED', sku: 'D', quantity: null, shopifyVariantId: 31, countable: false},
    {productId: 'ACTIVE', sku: 'A', quantity: null, shopifyVariantId: 32, countable: true},
  ]));
  assert.equal(identity.get(31), undefined); assert.equal(identity.get(32), 'ACTIVE');
  assert.equal(state.items.items.DISCONTINUED.variantId, 31);
});

test('product search keeps paging past pages without session products and reports when the results are complete', async () => {
  const pages = Array.from({length: 4}, (_, page) => Array.from({length: 50}, (_, i) => ({id: page * 50 + i + 1, title: `Product ${page * 50 + i + 1}`, variants: [{id: (page * 50 + i + 1) * 10, title: 'Default Title', sku: ''}]})));
  let calls = 0;
  const api: any = {searchProducts: async ({afterCursor}: any) => {const page = afterCursor ? Number(afterCursor) : 0; calls++; return {items: pages[page], hasNextPage: page < 3, lastCursor: String(page + 1)};}};
  const members = [{productId: 'late', variantId: 1750}, {productId: 'early', variantId: 30}];
  const remembered: number[] = [];
  const search = createMemberSearch(api);
  const found = await search('product', 1, members, id => remembered.push(id));
  assert.deepEqual(found!.ids, ['early']); assert.equal(found!.complete, false); assert.equal(calls, 1);
  const all = await search('product', Infinity, members, id => remembered.push(id));
  assert.deepEqual(all!.ids, ['early', 'late']); assert.equal(all!.complete, true); assert.equal(calls, 4);
  assert.deepEqual(remembered.sort((a, b) => a - b), [30, 1750]);
});

test('receipts belong to one checkpoint document, so a recreated session cannot inherit them', async () => {
  const kv = fakeKV();
  const state = new CountState(kv.native, owner, lookup, () => {}, {deviceId: 'POS_1'});
  await state.open(count());
  await state.append({code: 'A', source: 'external'}); await state.aggregate();
  const docId = state.items.docId;
  kv.data.set(mailboxKey(owner), JSON.stringify({receipts: {S1: {docId: 'older-document', items: {'P-A': {revision: 1, quantity: 1, at: 1}}}}}));
  const reopened = new CountState(kv.native, owner, lookup, () => {}, {deviceId: 'POS_1'});
  await reopened.open(count());
  assert.equal(reopened.items.items['P-A'].syncedRevision, 0);
  kv.data.set(mailboxKey(owner), JSON.stringify({receipts: {S1: {docId, items: {'P-A': {revision: 1, quantity: 1, at: 1}}}}}));
  const third = new CountState(kv.native, owner, lookup, () => {}, {deviceId: 'POS_1'});
  await third.open(count());
  assert.equal(third.items.items['P-A'].syncedRevision, 1);
});

test('the background writes only its mailbox and skips sessions unchanged since a clean check', async () => {
  const kv = fakeKV(), uploads: any[] = [];
  const request = async (action: string, payload: any) => {if (action === 'saveBatch') {uploads.push(payload); return {items: payload.items};} return lookup(action, payload);};
  const state = new CountState(kv.native, owner, request, () => {}, {deviceId: 'POS_1'});
  await state.open(count());
  await state.append({code: 'A', source: 'external'}); await state.aggregate();
  kv.data.set(controlKey(owner), JSON.stringify({...kv.value(controlKey(owner)), leases: {S1: {owned: true, deviceId: 'POS_1', fromDate: 1, expiresAt: Date.now() + 100000}}}));
  const before = new Map([...kv.data].filter(([key]) => key !== mailboxKey(owner)));
  await syncBackground({native: kv.native, owner, request});
  assert.equal(uploads.length, 1);
  assert.deepEqual(new Map([...kv.data].filter(([key]) => key !== mailboxKey(owner))), before);
  // The next turn confirms the session is clean; later turns skip its documents.
  await syncBackground({native: kv.native, owner, request});
  kv.readKeys.length = 0;
  await syncBackground({native: kv.native, owner, request});
  await syncBackground({native: kv.native, owner, request});
  assert.equal(uploads.length, 1);
  // Idle turns read control, the mailbox and the coordination flags, never a document.
  assert.deepEqual(kv.readKeys.filter(key => key.includes(':session:')), []);
});

test('a rewritten chunk that grows past the limit splits in place and keeps chronology', async () => {
  const kv = fakeKV(), storage = new CountStorage(kv.native), key = 'k:scan-events';
  const pending = Array.from({length: 6000}, (_, i) => ({id: i + 1, scannedValue: `${'x'.repeat(130)}${i}`, aggApplied: 0}));
  await storage.save(key, {header: {}, records: pending, keyOf: (e: any) => e.id});
  const grown = pending.map(e => ({...e, aggApplied: 1, productId: `PRODUCT-${'y'.repeat(40)}-${e.id}`, variantId: 123456789012}));
  await storage.save(key, {header: {}, records: grown, keyOf: (e: any) => e.id});
  assert.ok(kv.keys().every(k => utf8(kv.data.get(k)!) <= 900000));
  assert.deepEqual((await new CountStorage(kv.native).load(key))!.records.map((e: any) => e.id), grown.map(e => e.id));
});

test('measured model: five sessions, 2,000 shared products and 4,000 scans each', async () => {
  const kv = fakeKV(), products = Array.from({length: 2000}, (_, i) => `PRODUCT-${String(i).padStart(5, '0')}`);
  for (let s = 1; s <= 5; s++) {
    const storage = new CountStorage(kv.native), prefix = `hotwax-count:${owner}:session:S${s}`;
    const events = Array.from({length: 4000}, (_, i) => ({id: i + 1, scannedValue: `0${String(100000000000 + i)}`, quantity: 1, mode: 'add', source: 'external', createdAt: 1700000000000 + i, aggApplied: 1, productId: products[i % 2000], variantId: 40000000000000 + (i % 2000), staffId: '123456789', deviceId: 'POS_1234567'}));
    const items = products.map((productId, i) => ({productId, variantId: 40000000000000 + i, codes: [`0${String(100000000000 + i)}`], productIdentifier: `SKU-${i}`, quantity: 2, isRequested: true, revision: 2, syncedRevision: 2, serverQuantity: 2, lastCorrectionId: 0, lastUpdatedAt: 1700000000000, seq: i + 1}));
    await storage.save(`${prefix}:scan-events`, {header: {version: 2, sessionId: `S${s}`, nextId: 4001}, records: events, keyOf: (e: any) => e.id});
    await storage.save(`${prefix}:count-items`, {header: {version: 2, sessionId: `S${s}`, applied: {}, docId: 'd', count: {sessionId: `S${s}`, editable: true, audit: {deviceId: 'POS_1234567'}}}, records: items, keyOf: (i: any) => i.productId, move: true});
  }
  const identity = new IdentityMap(new CountStorage(kv.native));
  await identity.load({shop: '1', oms: 'https://oms.example'});
  products.forEach((productId, i) => identity.add(40000000000000 + i, productId));
  await identity.flush();
  const bytes = kv.keys().map(key => utf8(kv.data.get(key)!)), total = bytes.reduce((a, b) => a + b, 0);
  console.log(`model: ${kv.keys().length} document values (+ control, mailbox, OMS origin and 2 flags at runtime), ${Math.round(total / 1024)} KiB, largest ${Math.round(Math.max(...bytes) / 1024)} KiB`);
  assert.ok(kv.keys().length <= 16, String(kv.keys().length));
  assert.ok(Math.max(...bytes) <= 900000);
});
