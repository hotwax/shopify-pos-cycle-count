import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {CountStorage} from '../extensions/hotwax-cycle-count/src/count-storage.js';
import {syncBackground} from '../extensions/hotwax-cycle-count/src/count-background.js';
import {enterForeground} from '../extensions/hotwax-cycle-count/src/count-coordination.js';
import {leaseKey} from '../extensions/hotwax-cycle-count/src/count-lease.js';

// These tests exercise local coordination and crash recovery only. Real OMS
// ownership and mapping evidence is recorded separately in docs/evidence.
function fixture() {
  const data=new Map(),native={get:async k=>structuredClone(data.get(k)),set:async(k,v)=>{data.set(k,structuredClone(v));},delete:async k=>{data.delete(k);}};
  const writes=[];
  const request=async(action,payload)=>{
    if(action==='lookup')return {productId:'p',sku:'sku',title:'Product'};
    if(action==='saveBatch'){writes.push(payload);return {items:payload.items};}
    throw new Error(action);
  };
  const count={sessionId:'one',workEffortId:'work',editable:true,items:[]};
  const engine=()=>new CountState(new CountStorage(native),'owner',request,()=>{},{staffId:'staff',deviceId:'POS_A'});
  return {data,native,request,count,engine,writes};
}
test('background sync never edits the journal and a receipt preserves a newer local scan on reopen',async()=>{
  const f=fixture(),e=f.engine();await e.open(f.count);await e.append({code:'sku',source:'external'});await e.aggregate();
  await f.native.set(leaseKey('owner','one'),{owned:true,expiresAt:Date.now()+150000,fromDate:1});
  const before=structuredClone(f.data.get(e.itemKey));
  await syncBackground({native:f.native,owner:'owner',request:f.request});
  assert.equal(f.writes.length,1);assert.deepEqual(f.data.get(e.itemKey),before);
  assert.equal((await f.native.get(`${e.itemKey}:receipts`)).items.p.quantity,1);
  // The modal owns the journal; a late local revision must survive its old receipt.
  await e.append({code:'sku',source:'external'});await e.aggregate();
  const reopened=f.engine();await reopened.open({...f.count,items:[{productId:'p',sku:'sku',quantity:1}]});
  assert.equal(reopened.items.items.p.quantity,2);assert.equal(reopened.items.items.p.syncedRevision,1);
  await reopened.sync();assert.equal(f.writes[1].items[0].expectedQuantity,1);assert.equal(f.writes[1].items[0].quantity,2);
  assert.equal(reopened.events.events[0].staffId,'staff');assert.equal(reopened.events.events[0].deviceId,'POS_A');
});
test('a live foreground blocks the background uploader and current staff is checked before work',async()=>{
  const f=fixture(),e=f.engine();await e.open(f.count);await e.append({code:'sku',source:'manual'});await e.aggregate();
  const close=await enterForeground(f.native,'owner');
  try{await syncBackground({native:f.native,owner:'owner',request:f.request});assert.equal(f.writes.length,0);}finally{await close();}
  await syncBackground({native:f.native,owner:'owner',request:f.request,isCurrent:()=>false});assert.equal(f.writes.length,0);
});
test('a lost background receipt acknowledgement retries the same quantity without rewriting the journal',async()=>{
  const f=fixture(),e=f.engine();await e.open(f.count);await e.append({code:'sku',source:'manual'});await e.aggregate();
  await f.native.set(leaseKey('owner','one'),{owned:true,expiresAt:Date.now()+150000,fromDate:1});
  const set=f.native.set;let fail=true;
  f.native.set=async(key,value)=>{if(fail&&key.endsWith(':receipts')){fail=false;throw Error('Interrupted receipt');}return set(key,value);};
  await syncBackground({native:f.native,owner:'owner',request:f.request});await syncBackground({native:f.native,owner:'owner',request:f.request});
  assert.equal(f.writes.length,2);assert.deepEqual(f.writes[0].items,f.writes[1].items);
  const reopened=f.engine();await reopened.open({...f.count,items:[{productId:'p',sku:'sku',quantity:1}]});
  assert.equal(reopened.items.items.p.quantity,1);assert.equal(reopened.items.items.p.syncedRevision,1);
});
