import {OmsConnection, OmsRow, one, rows, text} from './oms-connection';

export function selectShop(shops: OmsRow[], shopDomain: string) {
  const matching = shops.filter(row => text(row.myshopifyDomain).toLowerCase() === shopDomain);
  // A shop can also have legacy app-only records without location/product mappings.
  // Prefer the uniquely enabled integration; retain compatibility with a single
  // older record whose enabled flag is unset. Never choose between enabled shops.
  const enabled = matching.filter(row => row.isEnabled === 'Y');
  const candidates = enabled.length ? enabled : matching.filter(row => !row.isEnabled);
  return one(candidates, 'enabled OMS Shopify shop');
}

export async function shopFacility(oms: OmsConnection, shopUrl: string, shopifyLocationId: string) {
  const shopDomain = new URL(shopUrl).hostname.toLowerCase();
  const shops = rows(await oms.get(`/rest/s1/sob/shopify/shops?${new URLSearchParams({myshopifyDomain: shopDomain})}`));
  const shop = selectShop(shops, shopDomain);
  const shopId = text(shop.shopId);
  const locations = rows(await oms.get(`/rest/s1/sob/shopify/locations?${new URLSearchParams({shopId, shopifyLocationId})}`));
  const location = one(locations.filter(row => text(row.shopId) === shopId && text(row.shopifyLocationId) === shopifyLocationId), 'OMS Shopify location');
  return {shop, facilityId: text(location.facilityId)};
}
