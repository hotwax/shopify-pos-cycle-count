import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectShop} from '../shared/oms-shop';

const domain = 'gorjana-sandbox.myshopify.com';
// The two record identities and flags were observed in Gorjana UAT on 2026-10-29.
const integration = {shopId: '10000', myshopifyDomain: domain, isEnabled: 'Y'};
const appOnly = {shopId: 'HC_CUSTOM_APP', myshopifyDomain: domain, isEnabled: null};

test('select the enabled integration when an app-only record shares the domain', () => {
  assert.equal(selectShop([appOnly, integration], domain).shopId, '10000');
});

test('reject ambiguous enabled shops and disabled shops', () => {
  assert.throws(() => selectShop([integration, {...integration, shopId: 'OTHER'}], domain), /found 2/);
  assert.throws(() => selectShop([{...integration, isEnabled: 'N'}], domain), /found 0/);
  assert.throws(() => selectShop([integration], 'another.myshopify.com'), /found 0/);
});

test('preserve a sole legacy shop without an enabled flag but reject ambiguous legacy records', () => {
  assert.equal(selectShop([appOnly], domain).shopId, 'HC_CUSTOM_APP');
  assert.throws(() => selectShop([appOnly, {...appOnly, shopId: 'OTHER'}], domain), /found 2/);
});
