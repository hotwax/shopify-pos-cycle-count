import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDirectOms,forgetOmsLogin,OMS_ORIGIN_KEY} from '../shared/direct-oms';
import {handleCount} from '../shared/oms-count';
import {facilityProducts} from '../shared/oms-count-workflows';

// Request plumbing with fixture responses; it does not stand in for a live OMS.
const encode=(value:object)=>btoa(JSON.stringify(value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sessionToken=`${encode({alg:'none'})}.${encode({dest:'https://shop.myshopify.com',sub:'42'})}.signature`;
const session={getSessionToken:async()=>sessionToken};
const calls:string[]=[];let adminAvailable=false;
const reply=(body:unknown)=>({ok:true,status:200,json:async()=>body,text:async()=>JSON.stringify(body)});
globalThis.fetch=(async(url:string)=>{
  calls.push(url);
  if(url.startsWith('shopify:admin')){
    if(!adminAvailable)throw new TypeError('Admin API unavailable in this target');
    return reply({data:{currentAppInstallation:{omsUrl:{type:'url',value:'https://oms.example.com/'}}}});
  }
  if(url==='https://oms.example.com/rest/s1/app-bridge/login')return reply({token:`oms-${calls.length}`});
  throw new Error(`Unexpected ${url}`);
}) as typeof fetch;

test('without Admin API access the background reuses the OMS origin this device saved, never a missing one',async()=>{
  const saved=new Map<string,unknown>();
  const storage={get:async(k:string)=>saved.get(k),set:async(k:string,v:unknown)=>{saved.set(k,v);}};
  await assert.rejects(openDirectOms(session,7,{storage}),/could not load the OMS connection/);
  saved.set(OMS_ORIGIN_KEY,'https://oms.example.com');
  const {reusedLogin}=await openDirectOms(session,7,{storage});
  assert.equal(reusedLogin,false);assert.equal(calls.filter(url=>url.endsWith('/login')).length,1);
  saved.set(OMS_ORIGIN_KEY,'https://oms.example.com/path');forgetOmsLogin();
  await assert.rejects(openDirectOms(session,7,{storage}),/HTTPS origin/);
});

test('repeated actions reuse the OMS origin and login until OMS rejects the login',async()=>{
  calls.length=0;adminAvailable=true;forgetOmsLogin();
  const saved=new Map<string,unknown>(),storage={get:async(k:string)=>saved.get(k),set:async(k:string,v:unknown)=>{saved.set(k,v);}};
  const first=await openDirectOms(session,7,{storage}),second=await openDirectOms(session,7,{storage});
  assert.equal(first.reusedLogin,false);assert.equal(second.reusedLogin,true);
  assert.equal(await second.oms.accessToken(),await first.oms.accessToken());
  assert.equal(calls.filter(url=>url.startsWith('shopify:admin')).length,1);
  assert.equal(calls.filter(url=>url.endsWith('/login')).length,1);
  assert.equal(saved.get(OMS_ORIGIN_KEY),'https://oms.example.com');
  forgetOmsLogin(second.loginKey);
  assert.equal((await openDirectOms(session,7,{storage})).reusedLogin,false);
  assert.equal(calls.filter(url=>url.endsWith('/login')).length,2);
});

test('the count context is loaded once per runtime, but the operator check runs on every action',async()=>{
  const reads:string[]=[];
  const responses:[RegExp,unknown][]=[
    [/sob\/shopify\/shops/,[{shopId:'S1',myshopifyDomain:'shop.myshopify.com',productStoreId:'STORE'}]],
    [/sob\/shopify\/locations/,[{shopId:'S1',shopifyLocationId:'7',facilityId:'F1'}]],
    [/admin\/user\/profile/,{username:'counter',userId:'U1',userFullName:'Counter'}],
    [/admin\/user\/permissions/,{docs:[{permissionId:'INVCOUNT_APP_VIEW'}]}],
    [/admin\/facilities\/F1/,{facilityName:'Store',productStoreId:'STORE',facilityTimeZone:'UTC'}],
    [/productStores\/STORE\/settings/,[{settingTypeEnumId:'BARCODE_IDEN_PREF',settingValue:'UPCA'}]],
    [/cycleCounts\/workEfforts\?/,{cycleCounts:[],cycleCountsCount:0}],
  ];
  const oms={get:async(path:string)=>{reads.push(path);const match=responses.find(([pattern])=>pattern.test(path));if(!match)throw Error(path);return match[1];}};
  const identity={shop:'https://shop.myshopify.com',shopifyUserId:'42',shopifyStaffMemberId:42,shopifyLocationId:7};
  const cache={key:'login',entries:new Map()};
  for(let i=0;i<3;i++)assert.equal((await handleCount(identity,{action:'storeCounts'},oms as any,cache)).facilityName,'Store');
  for(const pattern of [/profile/,/permissions/,/facilities\/F1/,/settings/,/shops\?/])assert.equal(reads.filter(path=>pattern.test(path)).length,1,String(pattern));
  assert.equal(reads.filter(path=>/workEfforts\?/.test(path)).length,3);
  await assert.rejects(handleCount({...identity,shopifyStaffMemberId:43},{action:'storeCounts'},oms as any,cache),/own account/);
});

test('facility scope pages are read four at a time and end at the first short page',async()=>{
  let active=0,peak=0;const pages:number[]=[];
  const oms={postRead:async(_path:string,body:any)=>{
    pages.push(body.pageIndex);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    const start=body.pageIndex*500,size=Math.max(0,Math.min(500,1234-start));
    return {entityValueList:Array.from({length:size},(_,i)=>({productId:`P${start+i}`}))};
  }};
  const found=await facilityProducts({facilityId:'F1'},oms as any);
  assert.equal(found.size,1234);assert.deepEqual(pages.sort(),[0,1,2,3]);assert.equal(peak,4);
});
