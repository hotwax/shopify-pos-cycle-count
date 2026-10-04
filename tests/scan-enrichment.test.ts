import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountState,decodeDocument} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {createScanProductLookup} from '../extensions/hotwax-cycle-count/src/scan-products.ts';
import {matchCodes} from '../shared/oms-count-products.ts';

// Tests of local journal orchestration and request shape; native POS/OMS proof is separate.
const display={shopifyProductId:10,shopifyVariantId:20,title:'Shirt · Blue / M',sku:'shirt-m',imageUrl:'https://cdn.shopify.com/test.jpg'};
const count={sessionId:'scan-phases',editable:true,items:[],countType:'DYNAMIC_COUNT'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function engine(request){
 const data=new Map(),storage={get:async k=>structuredClone(data.get(k)),set:async(k,v)=>data.set(k,structuredClone(v)),delete:async k=>data.delete(k)};
 let stats;const state=new CountState(storage,'owner',request,(_,s)=>{stats=s;});await state.open(count);
 return {state,data,stats:()=>stats};
}
test('durable scan gets POS display data before OMS identity; only OMS ID enables aggregation',async()=>{
 const native=deferred(),oms=deferred();let identityCalls=0;
 const request=async()=>{throw Error('unexpected request');};
 request.enrichScan=()=>native.promise;
 request.lookupIdentityBatch=()=>{identityCalls++;return oms.promise;};
 const f=await engine(request),id=await f.state.append({code:'00123',source:'external'});
 assert.equal(decodeDocument(f.data.get(f.state.eventKey)).events[0].id,id);
 const aggregation=f.state.aggregate();
 assert.equal(identityCalls,0);assert.equal(f.state.itemList.length,0);
 native.resolve(display);await f.state.enriching.get(id);
 assert.equal(f.stats().lastScan.imageUrl,display.imageUrl);assert.equal(f.stats().lastScan.matched,false);
 assert.equal(f.state.historyPage().items[0].title,display.title);assert.equal(f.state.itemList.length,0);
 oms.resolve({matches:[{code:'00123',productId:'HW1',codes:['00123']}],errors:[]});await aggregation;
 assert.equal(f.state.events.events[0].productId,'HW1');assert.equal(f.state.items.items.HW1.quantity,1);
 assert.equal(f.state.items.items.HW1.imageUrl,display.imageUrl);assert.equal(f.stats().lastScan.matched,true);
 await f.state.aggregate();assert.equal(f.state.items.items.HW1.quantity,1);
 const reopened=new CountState(f.state.storage,'owner',request);await reopened.open(count);await reopened.aggregate();
 assert.equal(reopened.historyPage().items[0].imageUrl,display.imageUrl);assert.equal(reopened.items.items.HW1.quantity,1);
});
test('Shopify success with no HotWax identity stays unaggregated and can be manually corrected',async()=>{
 const request=async()=>{throw Error('No OMS match');};request.enrichScan=async()=>display;
 request.lookupIdentityBatch=async()=>({matches:[],errors:[{code:'00123',message:'No OMS match'}]});
 const f=await engine(request),id=await f.state.append({code:'00123',source:'external'});await f.state.aggregate();
 assert.equal(f.state.itemList.length,0);assert.equal(f.stats().unmatched,1);assert.equal(f.stats().lastScan.imageUrl,display.imageUrl);
 await f.state.matchUnmatched(id,{productId:'HW2',title:'Manually selected',imageUrl:'correct.jpg'});
 assert.equal(f.state.items.items.HW2.quantity,1);assert.equal(f.state.historyPage().items[0].title,'Manually selected');
 assert.equal(f.stats().lastScan.imageUrl,'correct.jpg');
});
test('a pending discarded scan cannot be resurrected by late display or OMS results',async()=>{
 const native=deferred();const request=async()=>({productId:'HW1'});request.enrichScan=()=>native.promise;
 const f=await engine(request),id=await f.state.append({code:'00123',source:'external'}),aggregation=f.state.aggregate();
 await f.state.discardUnmatched(id);native.resolve(display);await aggregation;
 assert.equal(f.state.events.events[0].aggApplied,-1);assert.equal(f.state.itemList.length,0);
});
test('POS search verifies exact barcode, uses variant image, deduplicates repeated scans and rejects ambiguous/incomplete results',async()=>{
 let calls=0;let result={items:[{id:10,title:'Shirt',featuredImage:'parent.jpg',variants:[{id:20,barcode:'00123',title:'Blue / M',sku:'shirt-m',image:'variant.jpg'},{id:21,barcode:'999',title:'Other'}]}],hasNextPage:false};
 const lookup=createScanProductLookup({searchProducts:async()=>{calls++;return result;}});
 const [a,b]=await Promise.all([lookup('00123'),lookup('00123')]);assert.equal(calls,1);assert.deepEqual(a,b);
 assert.equal(a.shopifyVariantId,20);assert.equal(a.imageUrl,'variant.jpg');assert.equal(a.productId,undefined);
 assert.equal(await lookup('123'),null);
 result={...result,hasNextPage:true};assert.equal(await createScanProductLookup({searchProducts:async()=>result})('00123'),null);
 result={...result,hasNextPage:false,items:[...result.items,{id:11,title:'Duplicate',variants:[{id:22,barcode:'00123'}]}]};
 assert.equal(await createScanProductLookup({searchProducts:async()=>result})('00123'),null);
});
test('native display failure still allows OMS matching and missing OMS ID never counts',async()=>{
 const request=async()=>({title:'Unidentified'});request.enrichScan=async()=>{throw Error('native unavailable');};
 const f=await engine(request);await f.state.append({code:'code',source:'external'});await f.state.aggregate();
 assert.equal(f.state.itemList.length,0);assert.equal(f.stats().unmatched,1);
 request.lookupIdentityBatch=async()=>({matches:[{code:'code',productId:'HW1'}],errors:[]});await f.state.aggregate(true);
 assert.equal(f.state.items.items.HW1.quantity,1);
});
test('identity query returns only OMS ID and barcode mapping, retaining ambiguity/countability guards',async()=>{
 let query;
 const oms={postRead:async(_,body)=>{query=body;return {response:{docs:[{productId:'HW1',goodIdentifications:['UPCA/00123']}],numFound:1}};}};
 const result=await matchCodes(['00123'],{barcode:'UPCA',primary:'SKU',secondary:'productId'},oms as any,true);
 assert.equal(query.fields,'productId,goodIdentifications');assert.ok(query.filter.includes('isVirtual:false'));
 assert.deepEqual(result.matches,[{code:'00123',productId:'HW1',codes:['00123']}]);
});
test('a native miss retains OMS name/image fallback while a native hit uses identity-only matching',async()=>{
 const calls=[];
 const request=async()=>{throw Error('unexpected request');};
 request.enrichScan=async code=>code==='native'?display:null;
 request.lookupIdentityBatch=async codes=>{calls.push(['identity',codes]);return {matches:codes.map(code=>({code,productId:'HW-native'})),errors:[]};};
 request.lookupBatch=async codes=>{calls.push(['display-fallback',codes]);return {matches:codes.map(code=>({code,productId:'HW-fallback',title:'OMS fallback',imageUrl:'oms.jpg'})),errors:[]};};
 const f=await engine(request);await f.state.append({code:'native',source:'external'});await f.state.append({code:'oms-only',source:'external'});await f.state.aggregate();
 assert.deepEqual(calls,[['identity',['native']],['display-fallback',['oms-only']]]);
 assert.equal(f.state.items.items['HW-native'].imageUrl,display.imageUrl);assert.equal(f.state.items.items['HW-fallback'].imageUrl,'oms.jpg');
 assert.equal(f.stats().lastScan.imageUrl,'oms.jpg');assert.equal(f.state.itemUnits,2);
});
