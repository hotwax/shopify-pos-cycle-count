import assert from 'node:assert/strict';
import {test} from 'node:test';
import {countContributions,reconcileReviewTotals} from '../shared/oms-count-workflows';

// Pure reconciliation/request-plumbing regressions. Real UAT and iPad validation
// are recorded separately; these fixtures are not backend contract proof.
const review=[{productId:'gold',quantity:6,numberOfSessions:2,isRequested:'Y'},
  {productId:'silver',quantity:6,numberOfSessions:2,isRequested:'Y',quantityOnHand:8}];
const contribution=(productId:string,inventoryCountImportId:string,counted:unknown,extra={})=>
  ({productId,inventoryCountImportId,counted,statusId:'SESSION_SUBMITTED',...extra});
const saved=[contribution('gold','one',6),contribution('silver','one',0),
  contribution('gold','two',0),contribution('silver','two',3)];

test('review total is 9 from saved sessions even when the legacy review aggregate is 12',()=>{
  const combined=reconcileReviewTotals(review,saved);
  assert.equal(combined.get('gold')!.quantity,6);
  assert.equal(combined.get('silver')!.quantity,3);
  assert.equal([...combined.values()].reduce((sum,item)=>sum+(item.quantity??0),0),9);
  assert.equal(combined.get('silver')!.quantityOnHand,8);
  assert.equal(combined.get('silver')!.numberOfSessions,2);
  assert.equal(review[1].quantity,6,'Do not mutate cached source responses');
});
test('blank remains uncounted, explicit zero remains counted, and voided sessions do not contribute',()=>{
  const combined=reconcileReviewTotals([
    {productId:'blank',quantity:99,numberOfSessions:2,isRequested:'Y'},
    {productId:'zero',quantity:99,numberOfSessions:2,isRequested:'Y'},
    {productId:'extra',quantity:99,numberOfSessions:1,isRequested:'N',decisionOutcomeEnumId:'SKIPPED'},
  ],[contribution('blank','one',null),contribution('blank','two',null),
    contribution('zero','one',null),contribution('zero','two','0'),
    contribution('extra','one','3',{lastUpdatedAt:100}),contribution('extra','void',100,{statusId:'SESSION_VOIDED'})]);
  assert.equal(combined.get('blank')!.quantity,null);
  assert.equal(combined.get('zero')!.quantity,0);
  assert.equal(combined.get('extra')!.quantity,3);
  assert.equal(combined.get('extra')!.isRequested,'N');
  assert.equal(combined.get('extra')!.decisionOutcomeEnumId,'SKIPPED');
  assert.equal(combined.get('extra')!.maxLastUpdatedAt,100);
});
test('duplicate, malformed and partial session totals block review rather than display an incorrect total',()=>{
  for(const rows of [[...saved,saved[0]],saved.slice(0,3),[...saved,contribution('missing','one',2)],
    saved.map((row,i)=>i===0?{...row,counted:'invalid'}:row)])
    assert.throws(()=>reconcileReviewTotals(review,rows),/changed or are incomplete/);
  assert.throws(()=>reconcileReviewTotals(review,[]),/incomplete/);
  assert.equal(reconcileReviewTotals([],[]).size,0);
});
test('session totals load every page in stable product/session order',async()=>{
  const paths:string[]=[];
  const oms={get:async(path:string)=>{
    paths.push(path);const query=new URL('https://example.com'+path).searchParams;
    assert.equal(query.get('orderByField'),'productId,inventoryCountImportId');
    const index=Number(query.get('pageIndex'));
    return Array.from({length:index===0?500:1},(_,n)=>contribution('p'+(index*500+n),'one',1));
  }};
  const rows=await countContributions('work',oms as any);
  assert.equal(rows.length,501);assert.equal(paths.length,2);
  assert.equal(rows[500].productId,'p500');
});
test('failed or malformed session-total pages never return partial data',async()=>{
  for(const response of [{error:'unavailable'},[null]])
    await assert.rejects(countContributions('work',{get:async()=>response} as any),/could not be loaded/);
  let page=0;
  await assert.rejects(countContributions('work',{get:async()=>{
    if(page++)throw Error('network unavailable');
    return Array.from({length:500},(_,n)=>contribution('p'+n,'one',1));
  }} as any),/network unavailable/);
});
