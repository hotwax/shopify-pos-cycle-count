type RegisterIdentity = {shopDomain: string; shopId: unknown; locationId: unknown; userId: unknown; staffId: unknown};
export type InventoryScope = {shopDomain: string; shopId: string; locationId: string; userId: string; staffId: string};

function registerId(value: unknown, label: string): string {
  const id = String(value);
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error(`Shopify could not identify the ${label}. Reopen Inventory sync.`);
  return id;
}

/** The shop, location and signed-in staff member a Inventory sync screen acts for. Any shop
 * with this app works; its OMS address comes from the shop's HotWax setup (App Home). */
export function inventoryScope(identity: RegisterIdentity): InventoryScope {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(String(identity.shopDomain))) {
    throw new Error('Shopify could not identify this shop. Reopen Inventory sync.');
  }
  return {
    shopDomain: identity.shopDomain,
    shopId: registerId(identity.shopId, 'shop'),
    locationId: registerId(identity.locationId, 'location'),
    userId: registerId(identity.userId, 'account'),
    staffId: registerId(identity.staffId, 'pinned staff member'),
  };
}

export function sameInventoryScope(a: InventoryScope, b: InventoryScope): boolean {
  return a.shopDomain === b.shopDomain && a.shopId === b.shopId && a.locationId === b.locationId &&
    a.userId === b.userId && a.staffId === b.staffId;
}
