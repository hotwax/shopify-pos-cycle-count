import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {CountStorage, jsonBytes} from '../extensions/hotwax-cycle-count/src/count-storage.js';
const stored = async (storage, key) => (await new CountStorage(storage).load(key));
const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const count = {sessionId:'POSI_123456789abcdef', editable:true, items:[], units:0};
function fixture() {
 const data = new Map(); let fail = '';
 const storage = {get: async k => copy(data.get(k)), set: async (k,v) => {if(fail === k) {fail = '';throw Error('interrupted');} data.set(k,copy(v));}, delete: async k => data.delete(k)};
 const writes = []; let lookups = 0;
 const request = async (action,payload) => {
  if(action === 'lookup') {lookups++; return {productId:'p1',sku:'sku1',title:'Product'};}
  if (action === 'saveBatch') {writes.push(...payload.items);return {items:payload.items,canViewOnHand:false};}
  throw Error('Unexpected action '+action);
 };
 const engine = () => new CountState(storage,'owner',request);
 return {engine,data,writes,storage,request, fail:k=>fail=k, lookups:()=>lookups};
}
test('burst persists distinct scans and locally aggregates repeated products before server sync', async () => {
 const f=fixture(), e=f.engine();await e.open(count);
 await Promise.all(Array.from({length:100},()=>e.append({code:'barcode',source:'external'})));
 assert.equal(f.writes.length,0);await e.aggregate();
 assert.equal(e.items.items.p1.quantity,100);assert.equal(e.events.events.length,100);
 assert.equal(f.lookups(),1);assert.ok(e.events.events.every(x=>x.aggApplied===1));
 await e.sync();assert.equal(f.writes.length,1);assert.equal(f.writes[0].quantity,100);
 assert.equal(e.items.items.p1.revision,e.items.items.p1.syncedRevision);
});
test('interruption between item commit and event acknowledgement replays without double count', async()=>{
 const f=fixture(),e=f.engine();await e.open(count);await e.append({code:'barcode',source:'external'});
 f.fail(e.eventKey);await assert.rejects(e.aggregate(),/interrupted/);
 const reopened=f.engine();await reopened.open(count);await reopened.aggregate();
 assert.equal(reopened.items.items.p1.quantity,1);assert.equal(reopened.events.events[0].aggApplied,1);
});
test('failed item commit retains the scan for recovery',async()=>{
 const f=fixture(),e=f.engine();await e.open(count);await e.append({code:'barcode',source:'external'});
 f.fail(e.itemKey);await assert.rejects(e.aggregate());
 const reopened=f.engine();await reopened.open(count);await reopened.aggregate();
 assert.equal(reopened.items.items.p1.quantity,1);
});
test('scan during an outstanding sync is preserved and synced at its later revision',async()=>{
 const f=fixture();let release;let first=true;
 const request=async(a,p)=>{if(a==='saveBatch'&&first){first=false;await new Promise(r=>release=r);}return f.request(a,p);};
 const e=new CountState(f.storage,'owner',request);await e.open(count);await e.append({code:'barcode',source:'external'});await e.aggregate();
 const syncing=e.sync();while(!release)await new Promise(r=>setTimeout(r,0));
 await e.append({code:'barcode',source:'external'});await e.aggregate();release();await syncing;
 assert.equal(e.items.items.p1.quantity,2);assert.deepEqual(f.writes.map(x=>x.quantity),[1,2]);
 assert.equal(e.items.items.p1.syncedRevision,2);
});
test('capacity rejects a value that cannot fit without changing durable state',async()=>{
 const f=fixture(),e=f.engine();await e.open(count);
 await assert.rejects(e.save('events',{...e.events,oversized:'x'.repeat(900000)}),/too large/);
 assert.equal(e.events.events.length,0);assert.equal((await stored(f.storage,e.eventKey)).records.length,0);
 assert.equal(jsonBytes({value:'é'}),14);assert.equal(jsonBytes('😀'),6);
});
test('reopening preserves unsynced local quantity and correction across stale server detail',async()=>{
 const f=fixture(),e=f.engine();await e.open(count);await e.append({code:'barcode',source:'manual'});await e.aggregate();
 await e.append({code:'sku1',source:'correction',quantity:7,productId:'p1'});await e.aggregate();
 const reopened=f.engine();await reopened.open({...count,items:[{productId:'p1',quantity:0,sku:'sku1'}]});
 assert.equal(reopened.items.items.p1.quantity,7);await reopened.sync();assert.equal(f.writes[0].quantity,7);
});

test('an unmatched barcode does not block later scans and a late match is counted once', async()=>{
 const f=fixture();let match=false;
 const request=async(a,p)=>{if(a==='lookup'&&p.code==='unknown'&&!match)throw Error('Product not found');return f.request(a,p);};
 const e=new CountState(f.storage,'owner',request);await e.open(count);
 await e.append({code:'unknown',source:'manual'});await e.append({code:'barcode',source:'manual'});await e.aggregate();
 assert.equal(e.items.items.p1.quantity,1);assert.equal(e.events.events[0].aggApplied,0);
 await e.sync();assert.equal(f.writes[0].quantity,1);
 match=true;await e.aggregate(true);assert.equal(e.items.items.p1.quantity,2);
 await e.sync();assert.deepEqual(f.writes.map(i=>i.quantity),[1,2]);
});

test('late matching an earlier scan respects a later explicit quantity correction',async()=>{
 const f=fixture();let match=false;
 const request=async(a,p)=>{if(a==='lookup'&&p.code==='unknown'&&!match)throw Error('Product not found');return f.request(a,p);};
 const e=new CountState(f.storage,'owner',request);await e.open(count);
 await e.append({code:'unknown',source:'manual'});await e.append({code:'barcode',source:'manual'});await e.aggregate();
 await e.append({code:'sku1',productId:'p1',source:'correction',quantity:8});await e.aggregate();
 match=true;await e.aggregate(true);assert.equal(e.items.items.p1.quantity,8);
 assert.ok(e.events.events.every(event=>event.aggApplied===1));
});

test('undo is a durable inverse event and a duplicate undo cannot reduce quantity again',async()=>{
 const f=fixture(),e=f.engine();await e.open(count);await e.append({code:'barcode',source:'external'});await e.aggregate();
 await e.undoLast();assert.equal(e.items.items.p1.quantity,0);
 await assert.rejects(e.undoLast(),/no recent scan/);
 const reopened=f.engine();await reopened.open(count);await reopened.aggregate();assert.equal(reopened.items.items.p1.quantity,0);
});

test('a missing batch acknowledgement leaves every local revision dirty',async()=>{
 const f=fixture();const e=new CountState(f.storage,'owner',async(a,p)=>a==='saveBatch'?{items:[]}:f.request(a,p));
 await e.open(count);await e.append({code:'barcode',source:'manual'});await e.aggregate();
 await assert.rejects(e.sync(),/did not confirm/);assert.notEqual(e.items.items.p1.revision,e.items.items.p1.syncedRevision);
});

test('invalid saved documents are preserved rather than silently replaced',async()=>{
 const f=fixture();f.data.set('hotwax-count:owner:scan-events','{"version":99,"sessionId":"x"}');
 await assert.rejects(f.engine().open(count),/cannot be read/);
 assert.equal(f.data.get('hotwax-count:owner:scan-events'),'{"version":99,"sessionId":"x"}');
});

test('version 1 crash watermark migrates without replaying an already committed quantity',async()=>{
 const f=fixture();f.data.set('hotwax-count:owner:scan-events',{version:1,sessionId:count.sessionId,nextId:2,events:[{id:1,scannedValue:'barcode',quantity:1,mode:'add',aggApplied:0}]});
 f.data.set('hotwax-count:owner:count-items',{version:1,sessionId:count.sessionId,items:{p1:{productId:'p1',sku:'sku1',codes:['barcode'],quantity:1,revision:1,syncedRevision:0,lastEventId:1}}});
 const e=f.engine();await e.open(count);await e.aggregate();assert.equal(e.items.items.p1.quantity,1);assert.equal(e.events.events[0].aggApplied,1);
 assert.equal(f.data.get(e.itemKey).format,'hotwax-count-3');assert.equal(f.data.get(e.itemKey).data[0].sku,undefined);
});


test('explicit reconciliation uses a fresh server baseline and preserves the selected quantity',async()=>{
 const f=fixture(),e=f.engine();await e.open(count);await e.append({code:'barcode',source:'manual'});await e.aggregate();
 await e.reconcile('p1',4,false);await e.sync();assert.equal(f.writes[0].quantity,1);assert.equal(f.writes[0].expectedQuantity,4);
 await e.reconcile('p1',7,true);assert.equal(e.items.items.p1.quantity,7);assert.equal(e.items.items.p1.revision,e.items.items.p1.syncedRevision);
 assert.equal(e.lastUndoable(),undefined);
});
test('submission cannot bypass unmatched scans or failed synchronization',async()=>{
 const f=fixture();const e=new CountState(f.storage,'owner',async(a,p)=>{if(a==='lookup')throw Error('Not matched');return f.request(a,p);});
 await e.open(count);await e.append({code:'unknown',source:'manual'});await assert.rejects(e.prepareSubmission(),/unmatched/);
 assert.equal(f.writes.length,0);assert.equal(e.events.events[0].aggApplied,0);
});

test('uncached barcode bursts use one batch lookup and isolate unmatched products',async()=>{
 const f=fixture();let batches=0;const request=Object.assign(f.request,{lookupBatch:async(codes)=>{batches++;assert.deepEqual(codes,['a','b','unknown']);return {matches:[{code:'a',productId:'p1',sku:'a'},{code:'b',productId:'p2',sku:'b'}],errors:[{code:'unknown',message:'Not found'}]};}});
 const e=new CountState(f.storage,'owner',request);await e.open(count);
 for(const code of ['a','a','b','unknown'])await e.append({code,source:'external'});
 await e.aggregate();assert.equal(batches,1);assert.equal(f.lookups(),0);assert.equal(e.items.items.p1.quantity,2);assert.equal(e.items.items.p2.quantity,1);assert.equal(e.events.events[3].aggApplied,0);
});

test('a scan that would leave the allowed range stays pending alone; the rest of its batch commits', async()=>{
 const data=new Map();const storage={get:async k=>copy(data.get(k)),set:async(k,v)=>{data.set(k,copy(v));}};
 const request=async(_action,{code})=>({productId:code==='big'?'p1':'p2',sku:code,title:code});
 const e=new CountState(storage,'owner',request);await e.open(count);
 await e.append({code:'big',source:'correction',quantity:1000000});await e.aggregate();
 const over=await e.append({code:'big',source:'external'});await e.append({code:'ok',source:'external'});
 await e.aggregate();await e.aggregate();
 assert.equal(e.items.items.p1.quantity,1000000);assert.equal(e.items.items.p2.quantity,1);
 assert.deepEqual(e.events.events.filter(x=>x.aggApplied===0).map(x=>x.id),[over]);
 assert.match(e.failures.get(over).message,/outside 0 to 1,000,000/);
 await e.discardUnmatched(over);assert.equal(e.events.events.filter(x=>x.aggApplied===0).length,0);
});

test('a scan saves its Shopify variant with the aggregation commit; names and images stay in memory', async()=>{
 const data=new Map(),writes=[];const storage={get:async k=>copy(data.get(k)),set:async(k,v)=>{writes.push(k);data.set(k,copy(v));},delete:async k=>data.delete(k)};
 const request=async()=>({productId:'p1',sku:'sku1',title:'Product'});request.enrichScan=async()=>({shopifyVariantId:20,title:'Shirt',sku:'S',imageUrl:'shirt.jpg'});
 const e=new CountState(storage,'owner',request);await e.open(count);writes.length=0;
 await e.append({code:'barcode',source:'external'});await e.aggregate();
 assert.equal(writes.filter(k=>k===e.eventKey).length,2);
 const saved=JSON.stringify([...data.values()]);
 for(const display of ['Shirt','shirt.jpg','Product','sku1','shopifyProduct'])assert.equal(saved.includes(display),false,display);
 assert.equal((await stored(storage,e.eventKey)).records[0].variantId,20);
 assert.equal(e.items.items.p1.variantId,20);assert.equal(e.view(e.items.items.p1).imageUrl,'shirt.jpg');assert.equal(e.view(e.items.items.p1).title,'Shirt');
});

test('scan history reuses its ordered list across re-renders and page turns', async()=>{
 const f=fixture(),e=f.engine();await e.open(count);
 for(let i=0;i<45;i++)await e.append({code:`code-${i}`,source:'external'});
 const first=e.historyPage('',0),ordered=e.memo.history.list;
 assert.deepEqual(e.historyPage('',0).items.map(x=>x.id),first.items.map(x=>x.id));
 assert.equal(e.historyPage('',1).items.length,5);assert.equal(e.memo.history.list,ordered);
 await e.append({code:'newest',source:'external'});
 assert.notEqual((e.historyPage('',0),e.memo.history.list),ordered);assert.equal(e.historyPage('',0).items[0].scannedValue,'newest');
});
