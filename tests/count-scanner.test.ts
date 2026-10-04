import assert from "node:assert/strict";
import { test } from "node:test";
import {
  subscribeScans,
  countStatus,
  submissionIncomplete,
} from "../extensions/hotwax-cycle-count/src/count-api.js";

// Signal fixtures cover event plumbing, not OMS or physical-scanner validation.
test("ignores replay but counts repeated barcode events individually", () => {
  const stale = { data: "barcode", source: "external" };
  let listener;
  let closed = false;
  const received = [];
  const scanner = {
    scannerData: {
      current: {
        value: stale,
        subscribe(callback) {
          listener = callback;
          callback(stale);
          return () => {
            closed = true;
          };
        },
      },
    },
  };
  const unsubscribe = subscribeScans(scanner, (scan) => received.push(scan));
  listener(stale);
  const first = { data: "barcode", source: "external" };
  listener(first);
  listener(first);
  listener({ data: "barcode", source: "external" });
  listener({ data: "", source: "external" });
  assert.equal(received.length, 2);
  unsubscribe();
  assert.equal(closed, true);
});
test("submitting one session leaves the overall count open", () => {
  const incomplete = {
    statusId: "SESSION_SUBMITTED",
    countStatusId: "CYCLE_CNT_IN_PRGS",
  };
  assert.equal(submissionIncomplete(incomplete), false);
  assert.equal(countStatus(incomplete), "Session submitted");
  assert.equal(
    submissionIncomplete({ ...incomplete, countStatusId: "CYCLE_CNT_CMPLTD" }),
    false,
  );
  assert.equal(
    submissionIncomplete({ ...incomplete, countStatusId: "CYCLE_CNT_CLOSED" }),
    false,
  );
});

test("first physical event is retained when subscription does not replay", () => {
  let listener;
  const received = [];
  subscribeScans(
    {
      scannerData: {
        current: {
          value: { data: "same", source: "external" },
          subscribe(callback) {
            listener = callback;
            return () => {};
          },
        },
      },
    },
    (scan) => received.push(scan),
  );
  listener({ data: "same", source: "external" });
  assert.equal(received.length, 1);
});

test("accepts every documented scanner source and ignores unavailable data", () => {
  let listener;
  const received = [];
  subscribeScans(
    {
      scannerData: {
        current: {
          value: { data: undefined, source: undefined },
          subscribe(callback) {
            listener = callback;
            return () => {};
          },
        },
      },
    },
    (scan) => received.push(scan),
  );
  listener(undefined);
  listener({ data: undefined, source: "external" });
  listener({ data: "", source: "camera" });
  for (const source of ["external", "embedded", "camera"]) {
    listener({ data: "same-barcode", source });
  }
  assert.deepEqual(received.map((scan) => scan.source), [
    "external",
    "embedded",
    "camera",
  ]);
});

test("review and cancellation statuses override the session status", () => {
  assert.equal(countStatus({ statusId: "SESSION_ASSIGNED" }), "Counting");
  assert.equal(
    countStatus({ statusId: "SESSION_SUBMITTED" }),
    "Session submitted",
  );
  assert.equal(
    countStatus({
      statusId: "SESSION_SUBMITTED",
      countStatusId: "CYCLE_CNT_CLOSED",
    }),
    "Reviewed",
  );
  assert.equal(
    countStatus({
      statusId: "SESSION_SUBMITTED",
      countStatusId: "CYCLE_CNT_CNCL",
    }),
    "Cancelled",
  );
});
