import assert from 'node:assert/strict';
import {test} from 'node:test';
import {abortable} from '../shared/abortable';
import {openDirectOms,forgetOmsLogin} from '../shared/direct-oms';
import {countRequest} from '../extensions/hotwax-cycle-count/src/count-api.js';
import {IdentityMap} from '../extensions/hotwax-cycle-count/src/count-identity.js';

const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const never=()=>new Promise<any>(()=>{});
const encode=(value:object)=>btoa(JSON.stringify(value));
const token=`${encode({})}.${encode({dest:'https://shop.myshopify.com',sub:'42'})}.signature`;
const cancelled=new Error('left screen');

test('Back while local session loading is pending settles immediately and cannot publish the late result',async()=>{
  const local=deferred<string>(),controller=new AbortController();let published=false;
  const opening=(async()=>{await abortable(()=>local.promise,controller.signal);published=true;})();
  controller.abort(cancelled);
  await assert.rejects(opening,error=>error===cancelled);
  local.resolve('saved session');await tick();assert.equal(published,false);
});

test('cancelled work never starts and a late native rejection is still observed',async()=>{
  const controller=new AbortController();controller.abort(cancelled);
  let called=false;
  await assert.rejects(abortable(async()=>{called=true;},controller.signal),error=>error===cancelled);
  assert.equal(called,false);
  const native=deferred<void>(),active=new AbortController();
  const pending=abortable(()=>native.promise,active.signal);await tick();active.abort(cancelled);
  await assert.rejects(pending,error=>error===cancelled);
  native.reject(new Error('late native failure'));await tick();
});

test('a count request deadline settles even when the native Shopify token bridge never responds',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async()=>({ok:true,json:async()=>({data:{currentAppInstallation:{omsUrl:{type:'url',value:'https://oms.example.com'}}}})})) as any;
  (globalThis as any).shopify={session:{currentSession:{shopId:1,locationId:7},staffMember:{value:{id:42}},getSessionToken:never},
    connectivity:{current:{value:{internetConnected:'Connected'}}},storage:{set:async()=>{},get:async()=>undefined}};
  try {await assert.rejects(countRequest('catalog',{search:'M'},{timeoutMs:10}),/Timed out/);}
  finally{globalThis.fetch=originalFetch;delete (globalThis as any).shopify;}
});

test('cancelled authentication cannot start a late OMS login or business write',async()=>{
  const originalFetch=globalThis.fetch,native=deferred<string>(),controller=new AbortController();let logins=0;
  globalThis.fetch=(async(url:string)=>{if(!url.startsWith('shopify:'))logins++;
    return {ok:true,json:async()=>({data:{currentAppInstallation:{omsUrl:{type:'url',value:'https://oms.example.com'}}}})};}) as any;
  forgetOmsLogin();
  try{
    const opening=abortable(()=>openDirectOms({getSessionToken:()=>native.promise},7,{signal:controller.signal}),controller.signal);
    await tick();controller.abort(cancelled);await assert.rejects(opening,error=>error===cancelled);
    native.resolve(token);await tick();assert.equal(logins,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('an already sent write is not replayed when the UI stops waiting',async()=>{
  const ack=deferred<void>(),controller=new AbortController();let writes=0;
  const pending=abortable(()=>{writes++;return ack.promise;},controller.signal);
  await tick();controller.abort(cancelled);await assert.rejects(pending,error=>error===cancelled);
  ack.resolve();await tick();assert.equal(writes,1);
});

test('a second session open waits for the shared identity read instead of accepting an unfinished map',async()=>{
  const read=deferred<any>();let reads=0,finished=false;
  const identity=new IdentityMap({load:()=>{reads++;return read.promise;}});
  const scope={shop:'1',oms:'https://oms.example.com'};
  const first=identity.load(scope),second=identity.load(scope).then(()=>{finished=true;});
  await tick();assert.equal(finished,false);assert.equal(reads,1);
  read.resolve({header:{scope:'1|https://oms.example.com'},records:[[123,'P1']]});
  await Promise.all([first,second]);assert.equal(identity.get(123),'P1');assert.equal(reads,1);
});

test('an old identity read cannot populate the map after the OMS scope changes',async()=>{
  const old=deferred<any>(),current=deferred<any>();let reads=0;
  const identity=new IdentityMap({load:()=>++reads===1?old.promise:current.promise});
  const first=identity.load({shop:'1',oms:'https://old.example.com'});
  const second=identity.load({shop:'1',oms:'https://new.example.com'});
  current.resolve({header:{scope:'1|https://new.example.com'},records:[[123,'CURRENT']]});await second;
  old.resolve({header:{scope:'1|https://old.example.com'},records:[[123,'OLD']]});await first;
  assert.equal(identity.get(123),'CURRENT');
});
