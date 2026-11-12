import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CountQuantityEdits} from '../extensions/hotwax-cycle-count/src/count-quantity-edits.js';

const item={productId:'product-1',quantity:3};

test('completing flushes the focused quantity even before the field changes or blurs',async()=>{
  const writes=[];
  const edits=new CountQuantityEdits(async(_,change)=>{writes.push(change.quantity);return change.quantity;});
  edits.setDraft(item,'7');
  await edits.flush();
  await edits.flush();
  assert.deepEqual(writes,[7]);
});

test('completing joins an in-flight correction without writing it twice',async()=>{
  const writes=[];
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const edits=new CountQuantityEdits(async(_,change)=>{writes.push(change.quantity);await blocked;return change.quantity;});
  edits.setDraft(item,'8');
  const writing=edits.commit(item,{quantity:8});
  let finished=false;
  const completing=edits.flush().then(()=>{finished=true;});
  await Promise.resolve();
  assert.equal(finished,false);
  release();
  await Promise.all([writing,completing]);
  assert.deepEqual(writes,[8]);
});

test('a failed save leaves the draft available for another attempt',async()=>{
  let fail=true;
  const writes=[];
  const edits=new CountQuantityEdits(async(_,change)=>{
    if(fail)throw Error('local save interrupted');
    writes.push(change.quantity);
    return change.quantity;
  });
  edits.setDraft(item,'0');
  await assert.rejects(edits.flush(),/interrupted/);
  fail=false;
  await edits.flush();
  assert.deepEqual(writes,[0]);
});

test('completion rejects an invalid quantity and keeps an empty input unchanged',async()=>{
  const edits=new CountQuantityEdits(async()=>assert.fail('Unexpected quantity write.'));
  edits.setDraft(item,'3.5');
  await assert.rejects(edits.flush(),/whole number/);
  edits.setDraft(item,'');
  await edits.flush();
});
