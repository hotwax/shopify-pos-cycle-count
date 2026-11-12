import assert from 'node:assert/strict';
import {test} from 'node:test';
import {progressTotals} from '../extensions/hotwax-cycle-count/src/count-totals.js';

test('a directed count reports requested products counted, products left, extras and units', () => {
  const totals = progressTotals({type: 'DIRECTED_COUNT', items: [
    {productId: 'a', isRequested: true, quantity: 10},
    {productId: 'b', isRequested: true, quantity: 0},
    {productId: 'c', isRequested: true, quantity: null},
    {productId: 'x', isRequested: false, quantity: 4},
    {productId: 'y', isRequested: false, quantity: 2, decision: 'SKIPPED'},
  ]});
  assert.deepEqual(totals, {dynamic: false, counted: 3, requested: 3, requestedCounted: 2, extras: 1, units: 14});
});

test('a confirmed zero counts as counted, an empty quantity does not', () => {
  const totals = progressTotals({type: 'HARD_COUNT', items: [
    {productId: 'a', isRequested: true, quantity: 0},
    {productId: 'b', isRequested: true, quantity: null},
  ]});
  assert.equal(totals.requestedCounted, 1);
  assert.equal(totals.units, 0);
});

test('a dynamic count reports what is counted so far', () => {
  const totals = progressTotals({type: 'DYNAMIC_COUNT', items: [{productId: 'a', isRequested: true, quantity: 3}]});
  assert.equal(totals.dynamic, true);
  assert.equal(totals.counted, 1);
  assert.equal(totals.units, 3);
});

test('a count with no saved quantities yet reports zero', () => {
  assert.deepEqual(progressTotals({type: 'DIRECTED_COUNT', items: []}),
    {dynamic: false, counted: 0, requested: 0, requestedCounted: 0, extras: 0, units: 0});
});

import {submitReadiness} from '../extensions/hotwax-cycle-count/src/count-totals.js';

test('a count with open sessions and uncounted products lists both steps', () => {
  assert.deepEqual(submitReadiness({canFinish: false, uncounted: 96, sessions: [
    {statusId: 'SESSION_ASSIGNED'}, {statusId: 'SESSION_SUBMITTED'}, {statusId: 'SESSION_VOIDED'}]}),
    {ready: false, missing: ['Complete 1 open session', 'Count or mark out of stock 96 products']});
});

test('a count with no sessions asks for one', () => {
  assert.deepEqual(submitReadiness({canFinish: false, uncounted: 0, sessions: []}),
    {ready: false, missing: ['Count and complete at least one session']});
});

test('a ready count has nothing missing', () => {
  assert.deepEqual(submitReadiness({canFinish: true, uncounted: 0, sessions: [{statusId: 'SESSION_SUBMITTED'}]}),
    {ready: true, missing: []});
});

test('a refusal with no known cause still gives a next step', () => {
  assert.deepEqual(submitReadiness({canFinish: false, uncounted: 0, sessions: [{statusId: 'SESSION_SUBMITTED'}]}),
    {ready: false, missing: ['Refresh the count and check it again']});
});
