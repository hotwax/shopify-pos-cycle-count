import assert from 'node:assert/strict';
import test from 'node:test';
import {readCountPage} from '../extensions/hotwax-cycle-count/src/count-navigation.js';

const owner='shop:brooklyn:staff';

test('a native count route restores the selected count in its original POS scope',()=>{
  assert.deepEqual(readCountPage('https://extension.invalid/CycleCountSummary',{owner,workEffortId:'count-7'},owner),
    {kind:'work',workEffortId:'count-7'});
});

test('a native session route restores its session and source page',()=>{
  assert.deepEqual(readCountPage('CycleCountSession',{owner,sessionId:'session-2',fromSummary:true,name:'Front display',variantId:123},owner),
    {kind:'session',sessionId:'session-2',fromSummary:true,name:'Front display',variantId:123});
});

test('native Back preserves the root while mismatched or incomplete entries cannot open a count',()=>{
  assert.deepEqual(readCountPage(null,undefined,owner),{kind:'home'});
  assert.equal(readCountPage('CycleCountSummary',{owner:'shop:brooklyn:other',workEffortId:'count-7'},owner),null);
  assert.equal(readCountPage('CycleCountSession',{owner},owner),null);
});
