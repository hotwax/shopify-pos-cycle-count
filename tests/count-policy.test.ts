import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countCapabilities,
  visibleCountInventory,
} from "../shared/count-policy.ts";

// These are permission/serialization unit checks; live OMS permissions are
// established separately by authenticated device requests.
test("ordinary counters do not inherit inventory visibility", () => {
  assert.deepEqual(
    countCapabilities(["INVCOUNT_APP_VIEW", "INV_COUNT_CREATE"]),
    {
      canAccess: true,
      canCreate: true,
      canSubmit: false,
      canPrestart: false,
    canPreview: false,
    canRelease: false,
      canViewOnHand: false,
    },
  );
  assert.deepEqual(visibleCountInventory(3, 10, false), {});
  assert.ok(
    !JSON.stringify(visibleCountInventory(3, 10, false)).includes("10"),
  );
});
test("store counters can create while QOH and preview stay permissioned", () => {
  assert.deepEqual(countCapabilities(["INVCOUNT_APP_VIEW"]), {
    canAccess: true,
    canCreate: true,
    canSubmit: false,
    canPrestart: false,
    canPreview: false,
    canRelease: false,
    canViewOnHand: false,
  });
  assert.deepEqual(countCapabilities(["INV_CNT_VIEW_QOH"]), {
    canAccess: false,
    canCreate: false,
    canSubmit: false,
    canPrestart: false,
    canPreview: false,
    canRelease: false,
    canViewOnHand: true,
  });
});
test("count admins have access to count and inventory visibility", () => {
  for (const permission of ["COMMON_ADMIN", "INV_COUNT_ADMIN"]) {
    assert.deepEqual(countCapabilities([permission]), {
      canAccess: true,
      canCreate: true,
      canSubmit: true,
      canPrestart: true,
      canPreview: true,
      canRelease: true,
      canViewOnHand: true,
    });
  }
  assert.deepEqual(visibleCountInventory(3, 10, true), {
    onHand: 10,
    delta: -7,
  });
  assert.deepEqual(visibleCountInventory(3, null, true), {
    onHand: null,
    delta: null,
  });
});
test("cycle count review submission requires its own permission", () => {
  const result = countCapabilities([
    "INVCOUNT_APP_VIEW",
    "INV_COUNT_CREATE",
    "INV_COUNT_SUBMIT",
  ]);
  assert.equal(result.canSubmit, true);
  assert.equal(result.canViewOnHand, false);
});
