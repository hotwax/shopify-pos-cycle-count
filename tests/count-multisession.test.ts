import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {CountListIndex,PRODUCT_PAGE_SIZE} from '../extensions/hotwax-cycle-count/src/count-list.js';
const clone=v=>v===undefined?undefined:structuredClone(v);
const local=()=>{const data=new Map();return {data,get:async key=>clone(data.get(key)),set:async(key,value)=>{data.set(key,clone(value));}};};

test('two sessions retain independent unsynced quantities and journals across reopen',async()=>{
 const storage=local(),lookup=async()=>({productId:'p1',sku:'sku1'});
 const one={sessionId:'one',workEffortId:'work',editable:true,items:[]},two={...one,sessionId:'two'};
 const a=new CountState(storage,'owner',lookup);await a.open(one);await a.append({code:'sku1',source:'manual'});await a.aggregate();
 const b=new CountState(storage,'owner',lookup);await b.open(two);await b.append({code:'sku1',source:'correction',quantity:3,productId:'p1'});await b.aggregate();
 const resumed=new CountState(storage,'owner',lookup);await resumed.open(one);
 assert.equal(resumed.items.items.p1.quantity,1);assert.equal(b.items.items.p1.quantity,3);assert.notEqual(a.eventKey,b.eventKey);
 assert.equal((await storage.get('hotwax-count:owner:sessions')).sessions.length,2);
});

test('directed uncounted products stay null until an explicit zero or scan',async()=>{
 const storage=local(),engine=new CountState(storage,'owner',async()=>{throw Error('Cached product should not require matching');});
 await engine.open({sessionId:'directed',countType:'DIRECTED_COUNT',editable:true,items:[{productId:'a',sku:'a',quantity:null,isRequested:true},{productId:'b',sku:'b',quantity:null,isRequested:true}]});
 await engine.append({code:'a',productId:'a',source:'correction',quantity:0});await engine.aggregate();
 assert.equal(engine.items.items.a.quantity,0);assert.equal(engine.items.items.b.quantity,null);assert.equal(engine.items.items.a.serverQuantity,null);
});

test('5000-product pages stay bounded and quantity updates preserve the current page order',()=>{
 const index=new CountListIndex(),items=Array.from({length:5000},(_,n)=>({productId:`p${n}`,title:`Product ${n}`,sku:`SKU-${n}`,quantity:0,isRequested:true}));
 index.update(items);const before=index.page('','all',60);assert.equal(before.items.length,PRODUCT_PAGE_SIZE);
 const changed=[...items];changed[2403]={...changed[2403],quantity:7};index.update(changed);
 const after=index.page('','all',60);assert.deepEqual(after.items.map(i=>i.productId),before.items.map(i=>i.productId));assert.equal(after.items[3].quantity,7);
 assert.equal(index.page('SKU-4999').items[0].productId,'p4999');
 assert.equal(index.page('','all',124).items.length,40);
});
