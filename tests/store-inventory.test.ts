import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inventoryScope, sameInventoryScope} from '../shared/store-inventory';

const register = {shopDomain: 'gorjana-sandbox.myshopify.com', shopId: 7, locationId: 9, userId: 11, staffId: 13};
const scope = inventoryScope(register);

test('inventory scope works for any Shopify shop and requires a pinned staff identity', () => {
  assert.equal(scope.staffId, '13');
  assert.equal(inventoryScope({...register, shopDomain: 'gorjana.myshopify.com'}).shopDomain, 'gorjana.myshopify.com');
  assert.throws(() => inventoryScope({...register, shopDomain: 'gorjana.example.com'}), /identify this shop/);
  assert.throws(() => inventoryScope({...register, staffId: undefined}), /staff/);
  assert.equal(sameInventoryScope(scope, inventoryScope({...register, staffId: 14})), false);
  assert.equal(sameInventoryScope(scope, inventoryScope({...register, locationId: 10})), false);
});
