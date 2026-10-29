import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recoverSubmission,sessionSubmitted,countSubmitted,directSession,countEntry} from '../extensions/hotwax-cycle-count/src/count-submission.js';
const open={statusId:'SESSION_ASSIGNED'},submitted={statusId:'SESSION_SUBMITTED'};

test('lost submission response is reconciled without replaying its write',async()=>{
  let reads=0,writes=0,checks=0;
  const result=await recoverSubmission({read:async()=>++reads<3?open:submitted,write:async()=>{writes++;throw Error('response lost');},done:sessionSubmitted,checking:()=>checks++,wait:async()=>{}});
  assert.equal(result.statusId,'SESSION_SUBMITTED');assert.equal(writes,1);assert.equal(checks,1);assert.equal(reads,3);
});
test('retry sees an earlier successful submission and never writes again',async()=>{
  let writes=0;
  await recoverSubmission({read:async()=>submitted,write:async()=>{writes++;},done:sessionSubmitted});
  assert.equal(writes,0);
});
test('unknown readback keeps submission uncertain and does not replay',async()=>{
  let reads=0,writes=0;
  await assert.rejects(recoverSubmission({read:async()=>{if(reads++)throw Error('offline');return open;},write:async()=>{writes++;throw Error('timeout');},done:sessionSubmitted,wait:async()=>{}}),/could not confirm submission/);
  assert.equal(writes,1);assert.equal(reads,4);
});
test('failed initial status read does not start a write',async()=>{
  let writes=0;
  await assert.rejects(recoverSubmission({read:async()=>{throw Error('offline');},write:async()=>{writes++;},done:sessionSubmitted}));
  assert.equal(writes,0);
});
test('validation refusal is preserved after checking its outcome once',async()=>{
  const denied=Object.assign(Error('Other sessions are still open'),{status:409});let reads=0;
  await assert.rejects(recoverSubmission({read:async()=>{reads++;return {statusId:'CYCLE_CNT_IN_PRGS'};},write:async()=>{throw denied;},done:countSubmitted}),error=>error===denied);
  assert.equal(reads,2);
});
test('operator change during recovery stops reads and writes',async()=>{
  let current=true,reads=0;
  await assert.rejects(recoverSubmission({read:async()=>{reads++;return open;},write:async()=>{current=false;throw Error('timeout');},done:sessionSubmitted,current:()=>current}),/user changed/);
  assert.equal(reads,1);
});
test('count approval handoff recovers its lost response without duplicate transition',async()=>{
  let saved=false,writes=0;
  await recoverSubmission({read:async()=>({statusId:saved?'CYCLE_CNT_CMPLTD':'CYCLE_CNT_IN_PRGS'}),write:async()=>{writes++;saved=true;throw Error('timeout');},done:countSubmitted});
  assert.equal(writes,1);
});
test('direct entry only chooses one open session owned by this operator',()=>{
  const mine={sessionId:'mine',mine:true,statusId:'SESSION_CREATED'},other={sessionId:'other',mine:false,statusId:'SESSION_ASSIGNED'};
  assert.equal(directSession({sessions:[mine,other]}),mine);
  assert.equal(directSession({sessions:[mine,{...mine,sessionId:'second'}]}),null);
  assert.equal(directSession({sessions:[other,{...mine,statusId:'SESSION_SUBMITTED'}]}),null);
});

test('started imported counts lead to a session picker without relying on summary position',()=>{
  const seed={sessionId:'imported',mine:false,statusId:'SESSION_CREATED'};
  const info={statusId:'CYCLE_CNT_IN_PRGS',canCreateSession:true,sessions:[seed]};
  assert.deepEqual(countEntry(info),{view:'sessions'});
  const own={...seed,mine:true};
  assert.deepEqual(countEntry({...info,sessions:[own]}),{view:'session',session:own});
  assert.deepEqual(countEntry({...info,sessions:[own,{...own,sessionId:'second'}]}),{view:'sessions'});
  assert.deepEqual(countEntry({...info,sessions:[]}),{view:'create'});
  assert.deepEqual(countEntry({...info,sessions:[{...own,statusId:'SESSION_SUBMITTED'}]}),{view:'create'});
});

test('scheduled and finished counts never expose a counting entry even with an owned session',()=>{
  for(const statusId of ['CYCLE_CNT_CREATED','CYCLE_CNT_CMPLTD','CYCLE_CNT_CLOSED','CYCLE_CNT_CNCL'])
    assert.deepEqual(countEntry({statusId,canCreateSession:false,sessions:[{sessionId:'mine',mine:true,statusId:'SESSION_CREATED'}]}),{view:'summary'});
});

test('confirmed submission keeps local quantities and journal when persisting read-only status',async()=>{
  const {CountState}=await import('../extensions/hotwax-cycle-count/src/count-state.js');
  const data=new Map(),storage={get:async key=>structuredClone(data.get(key)),set:async(key,value)=>data.set(key,structuredClone(value)),delete:async key=>data.delete(key)};
  const state=new CountState(storage,'operator',async()=>({productId:'p1',sku:'P1'}));
  await state.open({sessionId:'local',editable:true,items:[],statusId:'SESSION_ASSIGNED'});
  await state.append({code:'P1',source:'manual'});await state.aggregate();
  const events=state.events.events.length;
  await state.open({...state.count,statusId:'SESSION_SUBMITTED',editable:false,items:state.itemViews});
  assert.equal(state.items.items.p1.quantity,1);assert.equal(state.events.events.length,events);assert.equal(state.count.editable,false);
});

test('restored product display includes parent name when variant response is only a letter',async()=>{
  const {fetchVariantDisplays}=await import('../extensions/hotwax-cycle-count/src/scan-products.ts');
  const result=await fetchVariantDisplays({fetchProductVariantsWithIds:async()=>({fetchedResources:[{id:7,productId:5,title:'A',sku:'SKU-A'}]}),fetchProductsWithIds:async ids=>{assert.deepEqual(ids,[5]);return {fetchedResources:[{id:5,title:'Alphabet Charm'}]};}} as any,[7]);
  assert.equal(result.get(7)?.title,'Alphabet Charm · A');
});


test('catalog titles put the parent product before its short variant label',async()=>{
  const {presentProduct}=await import('../shared/oms-count-products.ts');
  const item=presentProduct({productId:'p1',productName:'Gold',parentProductName:'Parker Necklace'}, {barcode:'UPC',primary:'SKU',secondary:'parentProductName'});
  assert.equal(item.title,'Parker Necklace · Gold');assert.equal(item.productId,'p1');
});

test('submission checks the saved session aggregate, including zero, without inventory hydration',async()=>{
  const {hasSavedQuantity}=await import('../shared/oms-count.ts');
  for(const counted of [3,0,null]){
    const oms={get:async(path:string)=>{
      const url=new URL(path,'https://example.invalid');
      assert.equal(url.pathname,'/rest/s1/inventory-cycle-count/cycleCounts/workEfforts/work/count');
      assert.equal(url.searchParams.get('inventoryCountImportId'),'session');
      assert.equal(url.searchParams.get('counted_from'),'0');assert.equal(url.searchParams.get('pageSize'),'1');
      return [{counted}];
    }};
    assert.equal(await hasSavedQuantity('session','work',oms as any),counted!==null);
  }
});
