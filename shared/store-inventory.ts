type RegisterIdentity = {shopDomain: string; shopId: unknown; locationId: unknown; userId: unknown; staffId: unknown};
export type InventoryScope = {shopDomain: string; shopId: string; locationId: string; userId: string; staffId: string};

function registerId(value: unknown, label: string): string {
  const id = String(value);
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error(`Shopify could not identify the ${label}. Reopen Store inventory.`);
  return id;
}

/** The shop, location and signed-in staff member a Store inventory screen acts for. Any shop
 * with this app works; its OMS address comes from the shop's HotWax setup (App Home). */
export function inventoryScope(identity: RegisterIdentity): InventoryScope {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(String(identity.shopDomain))) {
    throw new Error('Shopify could not identify this shop. Reopen Store inventory.');
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

export function availableTarget(input: string): number {
  const text = input.trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value > 2147483647) {
    throw new Error('Enter a whole number from 0 to 2,147,483,647.');
  }
  return value;
}

export type InventoryEffect = {
  id: string; source: string; reference: string; at: string; delta: number;
  state: 'queued' | 'produced' | 'sending' | 'needsAttention' | 'confirmed' | 'discarded';
  eligible: boolean; detail?: string;
};

export type InventoryProduct = {
  itemId: string; variantId: string; title: string; variant?: string; sku?: string;
  available: number | null; checkedAt?: string; projectedAvailable: number | null;
  timing: string; estimatedFrom?: string; estimatedTo?: string;
};

export type InventoryDetail = InventoryProduct & {
  atp: number | null; onHand: number | null; committed: number | null;
  unavailable: number | null; events: InventoryEffect[];
  pushBlocked?: string; setBlocked?: string;
};

export type InventoryReview = {
  operationId: string; action: 'push' | 'set'; currentAvailable: number;
  targetAvailable: number; currentAtp: number; variance: number;
  onHandVariance?: number; committed: number | null; unavailable?: number | null; effects: InventoryEffect[];
};

export type InventoryOperation = {
  operationId: string; action?: 'push' | 'set';
  state: 'review' | 'expired' | 'queued' | 'saved' | 'sending' | 'needsAttention' | 'confirmed' | 'unknown';
  targetAvailable?: number; confirmedAt?: string; message?: string; canRetry?: boolean;
  lastConfirmed?: {available: number; checkedAt?: string | null} | null; outcomeNote?: string | null;
};

export function mustRecoverInventoryOperation(operation: InventoryOperation | null): boolean {
  return operation?.state === 'unknown' || operation?.state === 'review';
}

type CommitTransport<T> = {
  remember(id: string): Promise<void>;
  commit(id: string): Promise<T>;
  status(id: string): Promise<T>;
};

export async function commitInventoryReview<T>(id: string, api: CommitTransport<T>): Promise<T | {operationId: string; state: 'unknown'}> {
  await api.remember(id);
  try {
    return await api.commit(id);
  } catch {
    try {
      return await api.status(id);
    } catch {
      return {operationId: id, state: 'unknown'};
    }
  }
}
