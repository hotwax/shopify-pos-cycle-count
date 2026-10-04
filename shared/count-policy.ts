export const COUNT_PERMISSIONS = [
  "COMMON_ADMIN",
  "INV_COUNT_ADMIN",
  "INVCOUNT_APP_VIEW",
  "INV_COUNT_CREATE",
  "INV_COUNT_SUBMIT",
  "INV_CNT_VIEW_QOH",
  "INV_COUNT_PRE_START",
  "PREVIEW_COUNT_ITEM",
  "INV_COUNT_LOCK_RLS",
];

export function countCapabilities(permissionIds: Iterable<string>) {
  const permissions = new Set(permissionIds);
  const admin =
    permissions.has("COMMON_ADMIN") || permissions.has("INV_COUNT_ADMIN");
  return {
    canAccess: admin || permissions.has("INVCOUNT_APP_VIEW"),
    canCreate: admin || permissions.has("INVCOUNT_APP_VIEW"),
    canPreview: admin || permissions.has("PREVIEW_COUNT_ITEM"),
    canRelease: admin || permissions.has("INV_COUNT_LOCK_RLS"),
    canPrestart: admin || permissions.has("INV_COUNT_PRE_START"),
    canSubmit: admin || permissions.has("INV_COUNT_SUBMIT"),
    canViewOnHand: admin || permissions.has("INV_CNT_VIEW_QOH"),
  };
}

export function visibleCountInventory(
  quantity: number | null,
  onHand: number | null,
  permitted: boolean,
) {
  return permitted
    ? { onHand, delta: onHand === null || quantity === null ? null : quantity - onHand }
    : {};
}
