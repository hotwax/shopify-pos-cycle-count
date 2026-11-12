import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quickCountSave, quickCountTarget, QUICK_SESSION} from '../shared/oms-count-quick';

// Fixture responses in the shapes the cycle count API returns; they do not stand in for a live OMS.
const ctx = {shopId:'S1', facilityId:'F1', username:'counter', timeZone:'UTC', canCreate:true,
  preferences:{barcode:'UPCA', primary:'SKU', secondary:'productId', shopId:'S1'}} as any;
const product = {productId:'P1', productName:'Ring', internalName:'RING-1', goodIdentifications:['SKU/RING-1'],
  productTypeId:'FINISHED_GOOD', isVirtual:false};
const work = (id: string, type: string, created: number, sessions: object[] = []) =>
  ({workEffortId:id, workEffortName:id, workEffortPurposeTypeId:type, statusId:'CYCLE_CNT_IN_PRGS', workEffortTypeId:'CYCLE_COUNT_RUN', facilityId:'F1', createdDate:created, sessions});

function fakeOms(counts: Record<string, object[]>, reviews: Record<string, object[]> = {}) {
  const writes: [string, any, string][] = [];
  const oms = {
    writes,
    get: async (path: string) => {
      const url = new URL('https://oms' + path);
      if (url.pathname.endsWith('/shopify/shopProducts')) return [{shopId:'S1', productId:'P1', shopifyProductId:url.searchParams.get('shopifyProductId')}];
      if (url.pathname.endsWith('/cycleCounts/workEfforts')) {
        const found = counts[url.searchParams.get('countType')!] ?? [];
        return {cycleCounts:found, cycleCountsCount:found.length};
      }
      const id = url.pathname.split('/workEfforts/')[1]?.split('/')[0];
      if (url.pathname.endsWith('/reviews')) return reviews[id] ?? [];
      if (url.pathname.endsWith('/count')) return [];
      if (url.pathname.endsWith('/sessions')) return [{inventoryCountImportId:'POSI_seed', uploadedByUserLogin:'counter', countImportName:'seed', statusId:'SESSION_CREATED'}];
      if (id) return {...work(id, 'DYNAMIC_COUNT', 1)};
      throw new Error('Unexpected ' + path);
    },
    postRead: async () => ({response:{docs:[product], numFound:1}}),
    mutate: async (path: string, body: any, method = 'POST') => {writes.push([path, body, method]); return {};},
  };
  return oms;
}
const op = 'abcdef012345678';
const identity = {shop:'https://shop.myshopify.com', shopifyUserId:'42', shopifyStaffMemberId:42, shopifyLocationId:7, deviceId:'POS_1'} as any;

test('a directed count asking for the product wins over a dynamic count, with a session created the regular way', async () => {
  const oms = fakeOms({DIRECTED_COUNT:[work('D_OLD', 'DIRECTED_COUNT', 1, [{inventoryCountImportId:'SEED', uploadedByUserLogin:'manager', statusId:'SESSION_CREATED'}]),
    work('D_NEW', 'DIRECTED_COUNT', 2)],
    DYNAMIC_COUNT:[work('DYN', 'DYNAMIC_COUNT', 3)]}, {D_OLD:[{productId:'P1', isRequested:'Y'}], D_NEW:[{productId:'P1', isRequested:'N'}]});
  const actions: any[] = [];
  const target = await quickCountTarget({variantId:99, operationId:op}, ctx, oms as any,
    async payload => {actions.push(payload); return {preparing:false, session:{sessionId:'POSI_' + op}};});
  assert.deepEqual([target.workEffortId, target.countType, target.created, target.sessionId], ['D_OLD', 'DIRECTED_COUNT', false, 'POSI_' + op]);
  assert.deepEqual(actions, [{action:'createSession', workEffortId:'D_OLD', operationId:op, name:QUICK_SESSION, area:'register'}]);
  assert.equal(oms.writes.length, 0);
  assert.deepEqual([target.product.productId, target.product.sku, target.counted], ['P1', 'RING-1', null]);
});

test('without a directed count, the dynamic count where I have an open session is used, in that session', async () => {
  const mine = {inventoryCountImportId:'POSI_mine', uploadedByUserLogin:'counter', countImportName:'Back wall', statusId:'SESSION_ASSIGNED', createdDate:2};
  const done = {inventoryCountImportId:'POSI_done', uploadedByUserLogin:'counter', countImportName:'Earlier', statusId:'SESSION_SUBMITTED', createdDate:3};
  const oms = fakeOms({DYNAMIC_COUNT:[work('NEWEST', 'DYNAMIC_COUNT', 5), work('MINE', 'DYNAMIC_COUNT', 4, [mine, done])]});
  const target = await quickCountTarget({variantId:99, operationId:op}, ctx, oms as any, async () => {throw new Error('no run');});
  assert.deepEqual([target.workEffortId, target.sessionId], ['MINE', 'POSI_mine']);
  assert.equal(oms.writes.length, 0);
});

test('with no count in progress a dynamic count is created and started, counting in its first session', async () => {
  const oms = fakeOms({});
  const actions: any[] = [];
  const target = await quickCountTarget({variantId:99, operationId:op}, ctx, oms as any, async payload => {
    actions.push(payload);
    return payload.action === 'createCount' ? {workEffortId:'POSC_' + op, sessionId:'POSI_seed'} : {};
  });
  assert.deepEqual(actions.map(action => [action.action, action.type ?? action.workEffortId]), [['createCount', 'DYNAMIC_COUNT'], ['startCount', 'POSC_' + op]]);
  assert.match(actions[0].name, new RegExp('^' + QUICK_SESSION));
  assert.deepEqual([target.created, target.sessionId], [true, 'POSI_seed']);
  await assert.rejects(quickCountTarget({variantId:99, operationId:op}, {...ctx, canCreate:false}, fakeOms({}) as any, async () => ({})), /cannot start one/);
});

test('saving adds the directed row as requested and saves into my open session, which stays open', async () => {
  const oms = fakeOms({});
  let status = 'SESSION_ASSIGNED';
  let lock: object[] = [];
  oms.get = (async (path: string) => {
    if (path.includes('/sessions/S_Q/lock')) return lock;
    if (path.includes('dataDocumentView')) return [];
    if (/\/sessions\/S_Q\/items/.test(path)) return [];
    if (/\/sessions\/S_Q$/.test(path)) return {inventoryCountImportId:'S_Q', workEffortId:'D1', uploadedByUserLogin:'counter', countImportName:'Back wall', statusId:status};
    if (/workEfforts\/D1$/.test(path)) return work('D1', 'DIRECTED_COUNT', 1);
    throw new Error('Unexpected ' + path);
  }) as any;
  (oms as any).postRead = async (path: string) => path.includes('dataDocumentView') ? {entityValueList:[]} : {response:{docs:[product], numFound:1}};
  const actions: any[] = [];
  const result = await quickCountSave(identity, {workEffortId:'D1', sessionId:'S_Q', productId:'P1', quantity:4, expectedQuantity:null}, ctx, oms as any,
    async payload => {actions.push(payload); return {};});
  assert.deepEqual(oms.writes.map(([path, body, method]) => [path.split('/cycleCounts/')[1], method, body.items?.[0].isRequested]),
    [['sessions/S_Q/items', 'PUT', 'Y']]);
  assert.deepEqual(actions, [{action:'saveBatch', sessionId:'S_Q', items:[{productId:'P1', code:'RING-1', quantity:4, expectedQuantity:null}]}]);
  assert.deepEqual([result.quantity, result.sessionName], [4, 'Back wall']);
  status = 'SESSION_SUBMITTED';
  await assert.rejects(quickCountSave(identity, {workEffortId:'D1', sessionId:'S_Q', productId:'P1', quantity:4}, ctx, oms as any, async () => ({})), /session in this count changed/);
  status = 'SESSION_ASSIGNED';
  // The session page's lease on this register is used for the save; another register's lease stops it.
  actions.length = 0;
  lock = [{userId:'counter', deviceId:'POS_1', fromDate:1, thruDate:Date.now() + 60000}];
  await quickCountSave(identity, {workEffortId:'D1', sessionId:'S_Q', productId:'P1', quantity:2, expectedQuantity:4}, ctx, oms as any,
    async payload => {actions.push(payload); return {};});
  assert.deepEqual(actions[0].lease, lock[0]);
  lock = [{userId:'counter', deviceId:'POS_2', fromDate:1, thruDate:Date.now() + 60000}];
  await assert.rejects(quickCountSave(identity, {workEffortId:'D1', sessionId:'S_Q', productId:'P1', quantity:2}, ctx, oms as any, async () => ({})), /another register/);
  lock = [];
  await assert.rejects(quickCountSave(identity, {workEffortId:'OTHER', sessionId:'S_Q', productId:'P1', quantity:4}, ctx, oms as any, async () => ({})), /session in this count changed/);
  await assert.rejects(quickCountSave(identity, {workEffortId:'D1', sessionId:'S_Q', productId:'P1', quantity:1.5}, ctx, oms as any, async () => ({})), /whole quantity/);
});
