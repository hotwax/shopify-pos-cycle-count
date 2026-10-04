import assert from 'node:assert/strict';
import {test} from 'node:test';
import {configureDirectOms, requireCountConnection} from '../shared/oms-connection';

test('demo count writes require the exact demo pair and a development preview', () => {
  configureDirectOms('https://demo-maarg.hotwax.io', true);
  assert.doesNotThrow(() => requireCountConnection('https://hotwax-demo.myshopify.com'));
  assert.throws(() => requireCountConnection('https://hc-sandbox.myshopify.com'));
  configureDirectOms('https://demo-maarg.hotwax.io', false);
  assert.doesNotThrow(() => requireCountConnection('https://hotwax-demo.myshopify.com'));
  configureDirectOms('https://other-instance.hotwax.io', true);
  assert.throws(() => requireCountConnection('https://hotwax-demo.myshopify.com'));
});

test('release counts use configured customer OMS with an authenticated Shopify shop', () => {
  configureDirectOms('https://customer.hotwax.io', false);
  assert.doesNotThrow(() => requireCountConnection('https://customer.myshopify.com'));
  assert.throws(() => requireCountConnection('https://customer.example.com'));
});
