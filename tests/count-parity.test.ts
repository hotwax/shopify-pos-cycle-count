import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {CountListIndex} from '../extensions/hotwax-cycle-count/src/count-list.js';
import {CountStorage} from '../extensions/hotwax-cycle-count/src/count-storage.js';
import {countDate,countSchedule} from '../shared/oms-count-create.ts';
import {countCapabilities} from '../shared/count-policy.ts';
import {presentProduct} from '../shared/oms-count-products.ts';

// Local state tests only. OMS contract proof comes from the separate live run.
const product={productId:'p1',sku:'SKU1',title:'Product',codes:['Barcode1']};
async function engine(items=[],type='HARD_COUNT'){
 const data=new Map();const storage={get:async k=>structuredClone(data.get(k)),set:async(k,v)=>{data.set(k,structuredClone(v));},delete:async k=>data.delete(k)};
 const state=new CountState(storage,'staff',async()=>{throw Error('Unknown barcode');});
 await state.open({sessionId:'one',workEffortId:'count',editable:true,countType:type,items});return {state,storage};
}
test('hand quantities add to the existing total and one durable batch cannot double count',async()=>{
 const {state}=await engine([{...product,quantity:4,isRequested:true}]);
 await state.addBatch([{product,quantity:3}],'batch-one');await state.addBatch([{product,quantity:3}],'batch-one');
 assert.equal(state.items.items.p1.quantity,7);assert.equal(state.events.events.length,1);
 await state.undoScan(1);assert.equal(state.items.items.p1.quantity,4);
});
test('matching an unknown code preserves repeated scans and survives reopening',async()=>{
 const {state,storage}=await engine();await state.append({code:'unknown',source:'manual'});await state.append({code:'unknown',quantity:3,source:'camera-confirm'});await state.aggregate();
 await state.matchUnmatched(1,product);assert.equal(state.items.items.p1.quantity,4);assert.ok(state.events.events.every(e=>e.aggApplied===1));
 const reopened=new CountState(storage,'staff',async()=>{throw Error('No network');});await reopened.open(state.count);assert.equal(reopened.items.items.p1.quantity,4);
});
test('earlier scan and all-SKU reversal preserve other products and reject a second reversal',async()=>{
 const {state}=await engine([{...product,quantity:0},{productId:'p2',sku:'SKU2',quantity:0,codes:['two']}]);
 for(const code of ['Barcode1','two','Barcode1'])await state.append({code,source:'external'});await state.aggregate();
 await state.undoScan(1);assert.equal(state.items.items.p1.quantity,1);assert.equal(state.items.items.p2.quantity,1);
 await assert.rejects(state.undoScan(1),/already been reversed/);await state.undoScan(3,true);assert.equal(state.items.items.p1.quantity,0);assert.equal(state.items.items.p2.quantity,1);
});
test('directed hand batches cannot silently add unrequested products',async()=>{
 const {state}=await engine([],'DIRECTED_COUNT');await assert.rejects(state.addBatch([{product,quantity:2}],'batch'),/requested/);assert.equal(state.events.events.length,0);
});
test('case-insensitive cached barcode matching and camera quantity are additive',async()=>{
 const {state}=await engine([{...product,quantity:1}]);await state.append({code:'barcode1',quantity:4,source:'camera-confirm'});await state.aggregate();assert.equal(state.items.items.p1.quantity,5);
});
test('facility calendar boundaries follow daylight savings and reject invalid dates',()=>{
 assert.equal(new Date(countDate('2026-03-08','America/Chicago')).toISOString(),'2026-03-08T06:00:00.000Z');
 assert.equal(new Date(countDate('2026-03-08','America/Chicago',true)).toISOString(),'2026-03-09T04:59:59.999Z');
 assert.throws(()=>countDate('2026-02-31','UTC'),/valid count date/);
});
test('store creation, early preview, and lock override retain separate Ionic permissions',()=>{
 const counter=countCapabilities(['INVCOUNT_APP_VIEW']);assert.ok(counter.canCreate);assert.equal(counter.canRelease,false);assert.equal(counter.canPreview,false);
 const lead=countCapabilities(['INVCOUNT_APP_VIEW','INV_COUNT_LOCK_RLS','PREVIEW_COUNT_ITEM']);assert.ok(lead.canRelease&&lead.canPreview);assert.equal(lead.canViewOnHand,false);
});
test('product display honors configured identifiers and only configured barcodes populate the scan cache',()=>{
 const value=presentProduct({productId:'1',internalName:'name',groupName:'Parent',goodIdentifications:['SKU/sku','UPCA/123']},{barcode:'UPCA',primary:'SKU',secondary:'groupName'});
 assert.equal(value.primary,'sku');assert.equal(value.secondary,'Parent');assert.deepEqual(value.codes,['123']);
});
test('6000 products remain paged, searchable and sortable without a 5000-item rejection',async()=>{
 const items=Array.from({length:6000},(_,i)=>({productId:String(i),title:`Item ${String(i).padStart(5,'0')}`,quantity:null,lastUpdatedAt:i}));
 const index=new CountListIndex();index.update(items);assert.equal(index.page('','all',0,'lastUpdated').items[0].productId,'5999');assert.equal(index.page('','all',149).items.length,40);
 const data=new Map(),native={get:async k=>data.get(k),set:async(k,v)=>{data.set(k,v);},delete:async k=>data.delete(k)};
 const store=new CountStorage(native);await store.save('large:count-items',{header:{version:2,sessionId:'large'},records:items,keyOf:i=>i.productId,move:true});
 assert.equal((await new CountStorage(native).load('large:count-items')).records.length,6000);
});
test('recently updated uses OMS timestamps on first open and keeps newer unsynced scans on reopen',async()=>{
 const items=[{...product,quantity:0,lastUpdatedAt:1000},{...product,productId:'p2',sku:'SKU2',codes:['two'],quantity:0,lastUpdatedAt:2000}];
 const {state,storage}=await engine(items);
 const index=new CountListIndex();index.update(state.itemList);
 assert.equal(index.page('','all',0,'lastUpdated').items[0].productId,'p2');
 await state.append({code:'Barcode1',source:'external'});await state.aggregate();
 const localTimestamp=state.items.items.p1.lastUpdatedAt;
 index.update(state.itemList);assert.equal(index.page('','all',0,'lastUpdated').items[0].productId,'p1');
 const reopened=new CountState(storage,'staff',async()=>{throw Error('No network');});await reopened.open({...state.count,items});
 assert.equal(reopened.items.items.p1.lastUpdatedAt,localTimestamp);
 assert.equal(reopened.items.items.p1.quantity,1);
});
test('changing sort reorders the same filtered list and assigned order remains stable',()=>{
 const items=[{productId:'b',primary:'Zebra',quantity:1,lastUpdatedAt:2000},{productId:'a',primary:'Apple',quantity:2,lastUpdatedAt:1000},{productId:'c',primary:'Berry',quantity:null,lastUpdatedAt:3000}];
 const index=new CountListIndex();index.update(items);
 const ids=(sort)=>index.page('','counted',0,sort).items.map(item=>item.productId);
 assert.deepEqual(ids('assigned'),['b','a']);
 assert.deepEqual(ids('alphabetic'),['a','b']);
 assert.deepEqual(ids('lastUpdated'),['b','a']);
 index.update(items.map(item=>item.productId==='a'?{...item,quantity:3,lastUpdatedAt:4000}:item));
 assert.deepEqual(ids('lastUpdated'),['a','b']);
 assert.deepEqual(ids('assigned'),['b','a']);
});
test('scan history stays newest first across product sorts, enrichment, filters and pages',async()=>{
 const {state,storage}=await engine([
  {...product,productId:'a',title:'Apple',quantity:0,lastUpdatedAt:2000},
  {...product,productId:'z',title:'Zebra',quantity:0,lastUpdatedAt:1000},
 ]);
 const events=Array.from({length:85},(_,i)=>({id:i+1,createdAt:Math.floor(i/2)*1000,
  scannedValue:`barcode-${i+1}`,productId:i%2?'a':'z',quantity:1,mode:'add',aggApplied:i%3?1:0}));
 state.events={...state.events,nextId:86,events:[...events.filter(e=>e.id%2),...events.filter(e=>!(e.id%2))]};
 await state.save('events',state.events);
 const reopened=new CountState(storage,'staff',async()=>{throw Error('No network');});
 await reopened.open(state.count);
 const index=new CountListIndex();index.update(reopened.itemList);
 const expected=events.map(e=>e.id).reverse();
 for(const sort of ['assigned','alphabetic','lastUpdated']){
  index.page('','all',0,sort);
  assert.deepEqual([0,1,2].flatMap(page=>reopened.historyPage('',page).items.map(e=>e.id)),expected);
 }
 reopened.events.events.find(e=>e.id===1).shopifyProduct={title:'New enrichment'};
 assert.deepEqual(reopened.historyPage('',0,'unmatched').items.map(e=>e.id),expected.filter(id=>(id-1)%3===0));
 assert.deepEqual(reopened.historyPage('barcode-8').items.map(e=>e.id),[85,84,83,82,81,80,8]);
 assert.deepEqual(reopened.events.events.map(e=>e.id),state.events.events.map(e=>e.id));
});
test('count dates can both be absent or supplied independently and still validate ordering',()=>{
 const now=Date.parse('2026-10-03T12:00:00Z');
 assert.deepEqual(countSchedule({},'America/Chicago',now),{});
 assert.deepEqual(countSchedule({startDate:'2026-10-05'},'America/Chicago',now),{estimatedStartDate:countDate('2026-10-05','America/Chicago')});
 assert.deepEqual(countSchedule({dueDate:'2026-10-05'},'America/Chicago',now),{estimatedCompletionDate:countDate('2026-10-05','America/Chicago',true)});
 assert.throws(()=>countSchedule({startDate:'2026-10-06',dueDate:'2026-10-05'},'America/Chicago',now),/due date/);
 assert.throws(()=>countSchedule({dueDate:'2026-10-01'},'America/Chicago',now),/due date/);
});
test('dynamic sessions start empty and scanning or hand counting builds only their counted scope',async()=>{
 const {state}=await engine([],'DYNAMIC_COUNT');
 state.request=async()=>({...product});
 assert.equal(state.itemList.length,0);
 await state.append({code:'Barcode1',source:'external'});await state.append({code:'Barcode1',source:'external'});await state.aggregate();
 await state.addBatch([{product,quantity:3}],'dynamic-hand');
 assert.equal(state.itemList.length,1);assert.equal(state.itemList[0].productId,'p1');
 assert.equal(state.itemList[0].quantity,5);assert.equal(state.itemList[0].isRequested,true);
});
test('retry matching reports an unresolved scan, then its matched quantity without counting twice',async()=>{
 const {state}=await engine();
 const id=await state.append({code:'unknown',source:'external'});await state.aggregate();
 const failed=await state.retryMatching(id);
 assert.equal(failed.matched,0);assert.equal(failed.remaining,1);assert.match(failed.reason,/Unknown barcode/);
 assert.equal(state.events.events[0].aggApplied,0);
 state.request=async()=>product;
 const matched=await state.retryMatching(id);
 assert.equal(matched.matched,1);assert.equal(matched.remaining,0);assert.deepEqual(matched.product,{title:'Product',quantity:1});
 await state.retryMatching(id);assert.equal(state.itemList[0].quantity,1);
});
test('retry all reports partial success while preserving the remaining scan and its error',async()=>{
 const {state}=await engine();
 await state.append({code:'known',source:'external'});await state.append({code:'unknown',source:'external'});await state.aggregate();
 state.request=async(_action,{code})=>{if(code==='known')return product;throw Error('No countable OMS product matches this barcode.');};
 const result=await state.retryMatching();
 assert.equal(result.matched,1);assert.equal(result.remaining,1);assert.match(result.reason,/No countable OMS product/);
 assert.equal(state.events.events.filter(event=>event.aggApplied===0).length,1);
 assert.equal(state.itemList[0].quantity,1);
});
