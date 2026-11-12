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

test('a count summary screen can open as Products, a product, or a selection screen',()=>{
  assert.deepEqual(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'products'},owner),
    {kind:'work',workEffortId:'count-7',view:'products'});
  assert.deepEqual(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'zero'},owner),
    {kind:'work',workEffortId:'count-7',view:'zero'});
  assert.deepEqual(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'product',
    product:{productId:'P1',title:'Gold chain',sku:'G-1',quantity:3,onHand:5,delta:-2,extra:'dropped'}},owner),
    {kind:'work',workEffortId:'count-7',view:'product',product:{productId:'P1',title:'Gold chain',sku:'G-1',quantity:3,onHand:5,delta:-2}});
});

test('an unknown view opens the summary and a product screen without a product is refused',()=>{
  assert.deepEqual(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'admin'},owner),
    {kind:'work',workEffortId:'count-7'});
  assert.equal(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'product'},owner),null);
});

test('a contribution screen needs both its product and its session',()=>{
  const product={productId:'P1',title:'Gold chain',sku:'G-1',quantity:3};
  assert.deepEqual(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'contribution',product,
    contribution:{sessionId:'S1',name:'Front',operator:'M1',statusId:'SESSION_ASSIGNED',quantity:3,editable:true}},owner),
    {kind:'work',workEffortId:'count-7',view:'contribution',product:{productId:'P1',title:'Gold chain',sku:'G-1',quantity:3,onHand:null,delta:null},
      contribution:{sessionId:'S1',name:'Front',operator:'M1',statusId:'SESSION_ASSIGNED',countStatusId:'',quantity:3,editable:true}});
  assert.equal(readCountPage('CycleCountSummary',{owner,workEffortId:'count-7',view:'contribution',product},owner),null);
});

test('session tasks, saved sessions and count creation open as their own screens',()=>{
  assert.deepEqual(readCountPage('CycleCountSession',{owner,sessionId:'S1',name:'Front',tool:'editSession'},owner),
    {kind:'session',sessionId:'S1',fromSummary:false,name:'Front',variantId:undefined,tool:'editSession'});
  assert.deepEqual(readCountPage('CycleCountSession',{owner,sessionId:'S1',tool:'issue',issueId:42},owner),
    {kind:'session',sessionId:'S1',fromSummary:false,name:'',variantId:undefined,tool:'issue',issueId:42});
  assert.equal(readCountPage('CycleCountSession',{owner,sessionId:'S1',tool:'issue'},owner),null);
  assert.deepEqual(readCountPage('CycleCountSession',{owner,sessionId:'S1',tool:'hand'},owner),
    {kind:'session',sessionId:'S1',fromSummary:false,name:'',variantId:undefined});
  assert.deepEqual(readCountPage('CycleCountSaved',{owner},owner),{kind:'saved'});
  assert.deepEqual(readCountPage('CycleCountCreate',{owner},owner),{kind:'new'});
  assert.equal(readCountPage('CycleCountCreate',{owner:'someone else'},owner),null);
});
