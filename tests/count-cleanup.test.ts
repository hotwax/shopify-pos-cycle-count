import assert from 'node:assert/strict';
import {test} from 'node:test';
import {localCopyRemovable,pruneLocalSessions} from '../extensions/hotwax-cycle-count/src/count-cleanup.js';
import {CountState} from '../extensions/hotwax-cycle-count/src/count-state.js';
import {CountStorage} from '../extensions/hotwax-cycle-count/src/count-storage.js';
import {leaseKey} from '../extensions/hotwax-cycle-count/src/count-lease.js';

// Local cleanup decisions only; the OMS status read is a fixture here.
test('a local copy is removable only once HotWax has finished with its session',()=>{
 const local={pending:0,dirty:0,items:[{productId:'a',quantity:2},{productId:'b',quantity:null}]};
 const remote={editable:false,statusId:'SESSION_SUBMITTED',countStatusId:'CYCLE_CNT_IN_PRGS',quantities:{a:2}};
 assert.equal(localCopyRemovable(remote,local),true);
 assert.equal(localCopyRemovable({...remote,statusId:'SESSION_APPROVED'},local),true);
 assert.equal(localCopyRemovable({...remote,quantities:{a:3}},local),false);
 assert.equal(localCopyRemovable({...remote,quantities:{a:2,b:1}},local),false);
 assert.equal(localCopyRemovable(remote,{...local,dirty:1}),false);
 assert.equal(localCopyRemovable(remote,{...local,pending:1}),false);
 assert.equal(localCopyRemovable({...remote,editable:true},local),false);
 assert.equal(localCopyRemovable({...remote,statusId:'SESSION_CREATED',countStatusId:'CYCLE_CNT_CMPLTD'},local),false);
 // A discarded session or a closed count cannot take the remaining quantities.
 assert.equal(localCopyRemovable({...remote,statusId:'SESSION_VOIDED',quantities:{}},{...local,dirty:1}),true);
 assert.equal(localCopyRemovable({...remote,countStatusId:'CYCLE_CNT_CLOSED',quantities:{}},{...local,pending:1}),true);
});

async function fixture() {
 const data=new Map(),native={get:async k=>structuredClone(data.get(k)),set:async(k,v)=>{data.set(k,structuredClone(v));},delete:async k=>{data.delete(k);}};
 const storage=new CountStorage(native);
 const request=async(action,payload)=>action==='saveBatch'?{items:payload.items}:{productId:'p',sku:'sku',title:'P'};
 for(const sessionId of ['voided','submitted','open','unsynced','unknown']) {
  const engine=new CountState(storage,'owner',request,()=>{},{});
  await engine.open({sessionId,editable:true,items:[]});await engine.append({code:'sku',source:'external'});await engine.aggregate();
  if(sessionId!=='unsynced'&&sessionId!=='voided')await engine.sync();
  await native.set(leaseKey('owner',sessionId),{owned:true});
  await native.set(`hotwax-count:owner:hand-draft:${sessionId}`,{entries:[]});
 }
 const remotes={voided:{editable:false,statusId:'SESSION_VOIDED',countStatusId:'CYCLE_CNT_IN_PRGS',quantities:{}},
  submitted:{editable:false,statusId:'SESSION_SUBMITTED',countStatusId:'CYCLE_CNT_IN_PRGS',quantities:{p:1}},
  open:{editable:true,statusId:'SESSION_ASSIGNED',countStatusId:'CYCLE_CNT_IN_PRGS',quantities:{}},
  unsynced:{editable:false,statusId:'SESSION_SUBMITTED',countStatusId:'CYCLE_CNT_IN_PRGS',quantities:{p:1}}};
 const status=async(_action,{sessionId})=>{if(!remotes[sessionId])throw Error('HotWax unavailable');return remotes[sessionId];};
 return {data,storage,status};
}

test('pruning removes every key of finished sessions and keeps open, unsynced and unverified ones',async()=>{
 const f=await fixture();
 assert.equal(await pruneLocalSessions({storage:f.storage,owner:'owner',request:f.status}),2);
 const catalog=f.data.get('hotwax-count:owner:sessions');
 assert.deepEqual(catalog.sessions.map(s=>s.sessionId).sort(),['open','unknown','unsynced']);
 assert.ok([...f.data.keys()].every(key=>!/voided|submitted/.test(key)),[...f.data.keys()].join('\n'));
 assert.ok([...f.data.keys()].some(key=>key.includes('session:unsynced')));
});

test('pruning stops before removing when a session open begins, and skips the open session',async()=>{
 const f=await fixture();
 assert.equal(await pruneLocalSessions({storage:f.storage,owner:'owner',request:f.status,isCurrent:()=>false}),0);
 assert.equal(await pruneLocalSessions({storage:f.storage,owner:'owner',request:f.status,keep:'voided'}),1);
 assert.ok(f.data.get('hotwax-count:owner:sessions').sessions.some(s=>s.sessionId==='voided'));
});
