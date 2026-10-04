import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountState, jsonBytes, decodeDocument} from '../extensions/hotwax-cycle-count/src/count-state.js';
const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const count = {sessionId:'POSI_123456789abcdef', editable:true, items:[], units:0};
function fixture() {
 const data = new Map(); let fail = '';
 const storage = {get: async k => copy(data.get(k)), set: async (k,v) => {if(fail === k) {fail = '';throw Error('interrupted');} data.set(k,copy(v));}};
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
test('capacity rejects a scan without changing durable state',async()=>{
 const f=fixture(),e=f.engine();await e.open(count);
 await assert.rejects(e.write(e.eventKey,{...e.events,oversized:'x'.repeat(900000)}),/storage is full/);
 assert.equal(e.events.events.length,0);assert.equal(decodeDocument(f.data.get(e.eventKey)).events.length,0);
 assert.equal(jsonBytes({value:'é'}),14);
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
 assert.equal(typeof f.data.get(e.itemKey),'string');
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
