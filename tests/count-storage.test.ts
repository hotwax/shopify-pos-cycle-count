import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountStorage} from '../extensions/hotwax-cycle-count/src/count-storage.js';
const key='hotwax-count:owner:scan-events';
const doc=(n:number)=>({version:2,sessionId:'test',nextId:n+1,events:Array.from({length:n},(_,id)=>({id:id+1,scannedValue:'barcode',aggApplied:1}))});
function fixture(){
 const data=new Map<string,any>();let calls=0,fail=0,after=false;
 const native={get:async(k:string)=>data.get(k),delete:async(k:string)=>data.delete(k),set:async(k:string,v:any)=>{calls++;if(calls===fail&&!after)throw Error('disk interrupted');data.set(k,v);if(calls===fail&&after)throw Error('ack interrupted');}};
 return {data,native,reset:(at=0,post=false)=>{calls=0;fail=at;after=post;}};
}
test('large logical documents stay below per-value limits and only changed pages are replaced',async()=>{
 const f=fixture(),storage=new CountStorage(f.native);const value=doc(50000);
 await storage.writeDocument(key,value);const before=JSON.parse(f.data.get(key));
 assert.equal(Object.keys(before.pages).length,63);assert.equal(f.data.size,64);
 assert.deepEqual(await new CountStorage(f.native).get(key),value);
 const changed={...value,events:[...value.events]};changed.events[49999]={...changed.events[49999],aggApplied:0};
 await storage.writeDocument(key,changed);const after=JSON.parse(f.data.get(key));
 assert.equal(Object.values(before.pages).filter(p=>Object.values(after.pages).includes(p)).length,62);
 assert.equal(f.data.size,64);
});
test('interruption at each copy-on-write stage preserves one complete document',async()=>{
 for(let fail=1;fail<=5;fail++){
  const f=fixture(),storage=new CountStorage(f.native);await storage.writeDocument(key,doc(1));f.reset(fail);
  let acknowledged=false;try{await storage.writeDocument(key,doc(801));acknowledged=true;}catch{}
  f.reset();const recovered=await new CountStorage(f.native).get(key);
  assert.deepEqual(recovered,acknowledged?doc(801):doc(1));
  const head=JSON.parse(f.data.get(key));assert.equal(f.data.size,Object.keys(head.pages).length+1);
 }
});
test('a lost manifest acknowledgement is reconciled without dropping or duplicating events',async()=>{
 const f=fixture(),storage=new CountStorage(f.native);await storage.writeDocument(key,doc(1));
 f.reset(3,true);await storage.writeDocument(key,doc(2));f.reset();
 assert.deepEqual(await new CountStorage(f.native).get(key),doc(2));
});
test('missing pages fail without replacing or deleting the original count',async()=>{
 const f=fixture(),storage=new CountStorage(f.native);await storage.writeDocument(key,doc(801));
 const head=f.data.get(key);f.data.delete(Object.values(JSON.parse(head).pages)[0] as string);
 await assert.rejects(new CountStorage(f.native).get(key),/page is missing/);assert.equal(f.data.get(key),head);
});

test('the shared 100-entry quota retains both operators when a write cannot fit', async()=>{
 const data=new Map<string,any>();
 const native={get:async(k:string)=>data.get(k),delete:async(k:string)=>data.delete(k),set:async(k:string,v:any)=>{
  if(!data.has(k)&&data.size>=100){const error=Object.assign(Error('Storage full'),{code:'RecordsCount'});throw error;}data.set(k,v);
 }};
 const one=new CountStorage(native), two=new CountStorage(native), first=doc(50000), second=doc(24000);
 const other='hotwax-count:another-staff:scan-events';
 await one.writeDocument(key,first);await two.writeDocument(other,second);
 assert.equal(data.size,95);
 await assert.rejects(two.writeDocument(other,doc(30000)),/no free count storage/);
 assert.deepEqual(await new CountStorage(native).get(key),first);
 assert.deepEqual(await new CountStorage(native).get(other),second);
 assert.equal(data.size,95);
 for(let i=0;data.size<100;i++)data.set(`unrelated-${i}`,"keep");
 await one.removeDocument(key);
 await two.writeDocument(other,doc(30000));
 assert.deepEqual(await new CountStorage(native).get(other),doc(30000));
 assert.equal(await new CountStorage(native).get(key),undefined);
});

test('interrupted scoped cleanup finishes on reopen and keeps other staff data',async()=>{
 const f=fixture();const storage=new CountStorage(f.native);await storage.writeDocument(key,doc(1601));
 f.data.set('unrelated-staff','preserve');let remaining=2;
 const failing={...f.native,delete:async(k:string)=>{if(--remaining===0)throw Error('interrupted cleanup');return f.native.delete(k);}};
 await assert.rejects(new CountStorage(failing).removeDocument(key),/interrupted cleanup/);
 assert.equal(await new CountStorage(f.native).get(key),undefined);
 assert.deepEqual([...f.data.entries()],[['unrelated-staff','preserve']]);
});
