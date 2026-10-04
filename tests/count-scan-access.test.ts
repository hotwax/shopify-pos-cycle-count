import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountLease,leaseKey} from '../extensions/hotwax-cycle-count/src/count-lease.js';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {CountStorage} from '../extensions/hotwax-cycle-count/src/count-storage.js';
const journal=async(storage,key)=>({events:(await new CountStorage(storage).load(key))?.records||[]});

function fixture() {
  const data=new Map();
  const storage={get:async key=>structuredClone(data.get(key)),set:async(key,value)=>{data.set(key,structuredClone(value));},delete:async key=>{data.delete(key);}};
  let response={owned:true,available:false,deviceId:'POS_1',fromDate:1000,expiresAt:Date.now()+150000};
  let failure: any=false,offline=false;
  const lease=new CountLease(storage,'owner',async()=>{if(failure)throw failure===true?Error('Lock request failed'):failure;return {...response};},()=>{},()=>offline);
  const state=new CountState(storage,'owner',async()=>{throw Error('Unexpected product lookup');},()=>{},{deviceId:'POS_1'},()=>lease.assertCanScan('session','POS_1'));
  return {data,storage,lease,state,response,setFailure:value=>{failure=value;},setResponse:value=>{response=value;},setOffline:value=>{offline=value;}};
}
const count={sessionId:'session',editable:true,items:[]};
const scan={code:'barcode',source:'external'};

test('no acquired lock rejects every scan source without writing a journal event',async()=>{
  const f=fixture();await f.state.open(count);
  for(const source of ['external','embedded','camera','camera-confirm','hid'])await assert.rejects(f.state.append({...scan,source}),/Acquire/);
  assert.equal(f.state.events.events.length,0);
  assert.equal((await journal(f.storage||f.state.native,f.state.eventKey)).events.length,0);
  await f.lease.open('session');await f.state.append(scan);
  assert.equal(f.state.events.events.length,1); // Rejected scans are never replayed.
});

test('offline, this terminal keeps counting on its stored lease; online it needs a confirmed claim',async()=>{
  const f=fixture();await f.storage.set(leaseKey('owner','session'),{...f.response,expiresAt:Date.now()-1});await f.state.open(count);
  // The stored lease was confirmed for this terminal earlier; sync renews it before any write.
  f.setOffline(true);await f.lease.open('session',true);await f.state.append(scan);
  assert.equal(f.state.events.events.length,1);
  // Back online, the expired stored lease is not enough until OMS confirms a claim.
  f.setOffline(false);await assert.rejects(f.state.append(scan),/Acquire/);
  f.setFailure(true);await assert.rejects(f.lease.claim(),/failed/);await assert.rejects(f.state.append(scan),/Acquire/);
  f.setFailure(false);await f.lease.claim();await f.state.append(scan);
  assert.equal(f.state.events.events.length,2);
});

test('offline counting never uses a lease held elsewhere or for another session',async()=>{
  const f=fixture();await f.state.open(count);f.setOffline(true);
  for(const stored of [undefined,{...f.response,owned:false},{...f.response,deviceId:'POS_2'},{...f.response,available:true}]) {
    if(stored)await f.storage.set(leaseKey('owner','session'),stored);else await f.storage.delete(leaseKey('owner','session'));
    await f.lease.open('session',true);await assert.rejects(f.state.append(scan),/Acquire/);
  }
  await f.storage.set(leaseKey('owner','other'),f.response);await f.lease.open('other',true);await assert.rejects(f.state.append(scan),/Acquire/);
  assert.equal(f.state.events.events.length,0);
});

test('foreign, expired, available and malformed locks reject new scan events',async()=>{
  const f=fixture();await f.state.open(count);
  for(const patch of [{owned:false},{deviceId:'POS_2'},{expiresAt:Date.now()-1},{expiresAt:undefined},{available:true}]) {
    f.setResponse({...f.response,...patch});await f.lease.open('session');await assert.rejects(f.state.append(scan),/Acquire/);
  }
  f.setResponse(f.response);await f.lease.open('different-session');await assert.rejects(f.state.append(scan),/Acquire/);
  assert.equal(f.state.events.events.length,0);
});

test('a heartbeat that loses ownership pauses new events and a successful recheck permits new scans',async()=>{
  const f=fixture();await f.state.open(count);await f.lease.open('session');await f.state.append(scan);
  f.setFailure(Object.assign(Error('This device no longer owns the session.'),{status:409}));
  await assert.rejects(f.lease.renew(),/no longer owns/);await assert.rejects(f.state.append(scan),/Acquire/);
  f.setFailure(false);await f.lease.claim();await f.state.append(scan);
  assert.equal(f.state.events.events.length,2);
  await f.lease.release();await assert.rejects(f.state.append(scan),/Acquire/);
});

test('an unreachable OMS during a heartbeat keeps counting until the confirmed lease expires',async()=>{
  const f=fixture();await f.state.open(count);await f.lease.open('session');
  f.setFailure(Object.assign(Error('OMS cannot be reached.'),{status:503}));
  await assert.rejects(f.lease.renew(),/cannot be reached/);await f.state.append(scan);
  f.setFailure(true);await assert.rejects(f.lease.renew(),/failed/);await f.state.append(scan);
  f.lease.value.expiresAt=Date.now()-1;await assert.rejects(f.state.append(scan),/Acquire/);
  assert.equal(f.state.events.events.length,2);
});

test('a scan queued behind storage work rechecks the lock before committing',async()=>{
  const f=fixture();await f.state.open(count);await f.lease.open('session');
  let resume,started;const waiting=new Promise(resolve=>{started=resolve;});
  f.state.serial(()=>new Promise(resolve=>{resume=resolve;started();}));
  const queued=f.state.append(scan);await waiting;
  f.lease.value.expiresAt=Date.now()-1;resume();await assert.rejects(queued,/Acquire/);
  assert.equal(f.state.events.events.length,0);
  assert.equal((await journal(f.storage||f.state.native,f.state.eventKey)).events.length,0);
});

test('unmatched event filtering precedes search and pagination and excludes removed scans',async()=>{
  const f=fixture();await f.state.open(count);await f.lease.open('session');
  for(let i=0;i<45;i++)await f.state.append({code:`unknown-${i}`,source:'external'});
  await f.state.append({code:'matched',source:'external'});
  f.state.events.events.at(-1).aggApplied=1;
  await f.state.discardUnmatched(1);
  const first=f.state.historyPage('',0,'unmatched'),second=f.state.historyPage('',1,'unmatched');
  assert.equal(first.total,44);assert.equal(first.items.length,40);assert.equal(second.items.length,4);
  assert.ok([...first.items,...second.items].every(event=>event.aggApplied===0));
  assert.equal(f.state.historyPage('unknown-44',0,'unmatched').total,1);
  assert.equal(f.state.historyPage('matched',0,'unmatched').total,0);
  assert.equal(f.state.historyPage().total,46);
});
