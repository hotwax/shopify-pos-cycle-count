import {OmsConnection, one, rows, text} from './oms-connection';

export async function shopFacility(oms: OmsConnection, shopUrl: string, shopifyLocationId: string) {
  const shopDomain = new URL(shopUrl).hostname.toLowerCase();
  const shops = rows(await oms.get(`/rest/s1/sob/shopify/shops?${new URLSearchParams({myshopifyDomain: shopDomain})}`));
  const shop = one(shops.filter(row => text(row.myshopifyDomain).toLowerCase() === shopDomain), 'OMS Shopify shop');
  const shopId = text(shop.shopId);
  const locations = rows(await oms.get(`/rest/s1/sob/shopify/locations?${new URLSearchParams({shopId, shopifyLocationId})}`));
  const location = one(locations.filter(row => text(row.shopId) === shopId && text(row.shopifyLocationId) === shopifyLocationId), 'OMS Shopify location');
  return {shop, facilityId: text(location.facilityId)};
}
