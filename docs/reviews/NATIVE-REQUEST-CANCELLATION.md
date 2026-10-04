# Native request cancellation fix — 4 October 2026

Status: implemented; automated checks passed; physical iPad retest pending runner signing renewal. This is not functional-parity sign-off or a customer release.

## Observed candidate failure

Base candidate: `f8a9ee38cc7a08348b44adc01439b4ffca82619a`, PR #1.
Pre-refactor baseline: `cf956cd88f4f8e7e4e2c162eca5c20bea7930b6e`.

On physical Shopify POS 11.16.2 (530647), the dedicated Demo OMS QA session's hand-count search retained older results and `Finding products…` for minutes. Later, Resume stayed on Opening session; Back returned home with its actions still disabled. Report: https://github.com/hotwax/shopify-pos-cycle-count/pull/1#discussion_r4176762342.

The native failing call has not been traced to its source. These source defects are independently established: the request deadline only aborted fetch signals and did not settle a pending native bridge promise; superseded searches ignored results without cancelling their request; session-open cancellation ended before `attach()` finished its local reads and journal preparation.

## Changes

- Bound the entire count request with its existing 55-second deadline, including native authentication and configuration waits. Reject cancelled work before subsequent OMS mutations or reuse of a late login result.
- Abort superseded catalog searches and ignore their late success, failure and loading callbacks.
- Keep Back cancellation active through foreground coordination, prior journal settling, shared mapping loading, lock confirmation and session journal opening. Bound total session opening to 65 seconds. A cancelled or failed journal open deactivates its engine; late notifications cannot change the screen or permit scans.
- Do not renew a lease for an inactive engine.
- A second session open awaits an unfinished shared identity-map read. A late read for an old OMS scope cannot populate the current mapping.
- Retain existing journal serialization and write acknowledgement/reconciliation. Stopping a UI wait neither proves an already sent write failed nor triggers a replay. An unresolved native journal write must settle before another engine can proceed, or the user must reopen the extension for recovery.

No storage keys, schema, migration format or product-cache sizing were changed. The unused unbound `countRequest.lookupBatch` property was removed; the actual bound request retains all four lookup/display methods. Duplicate error wording and request-method copying were tightened to preserve the unchanged bundle gate.

## Validation

- `npm test`: **105 passed / 0 failed**, including seven new cancellation and mapping tests. Native bridge/storage behavior is simulated in these tests; they do not prove iPad behavior.
- `npm run typecheck`: passed.
- `npm run build`: passed. Main extension gzip **65,024 bytes**, unchanged gate **65,024**, platform limit **65,536**. App Home **9,971 bytes**. The release bundle has the required 512-byte margin and no additional space below the build gate.
- Shopify POS UI Toolkit validation against 2026-07: CountWorkspace and CatalogPicker native components passed. Toolkit does not validate custom component internals or native runtime behavior.
- Real Demo OMS: the catalog query for `MSH0232` returned one product (`10101`). QA session count readback was still empty. These are Mac-side backend checks, using the saved Demo profile, not POS token or scanner proof.

## Physical iPad blocker and next checks

CoreDevice reports the physical iPad connected. Native Appium reconnect failed before acquiring a session: Xcode reported `No Accounts` and no usable development provisioning profile for `co.hotwax.aditya.iosTesting.WDARunner.xctrunner`; installing its cached runner reported `0xe8008011 (This provisioning profile has expired.)`. Normal automatic provisioning flags were already enabled. Aditya was asked to restore the Apple account and renew WebDriverAgentRunner signing in Xcode. No Shopify POS reset, reinstall, KV clearing or inventory adjustment was performed.

Once signing is renewed, reconnect without reset and test the exact fix commit through the local POS preview against real Demo OMS. First repeat M → MSH0232 search, leave during search, cancel an opening during local preparation, reopen/resume, and hand-count review/save with OMS readback. Then continue the original dynamic/directed/hard, multiple-session, lock/scanner, chronological/unmatched/undo, images/layout, 2k+ lists, one-session bulk zero, submission, migration/recovery/overflow and background-sync gates. Keep physical scanner proof separate from automated HID entry. Existing untested gates remain unfinished.

QA fixture to reuse: count `POSC_687414a7504f2b7`, session `POSI_ea6f47c77b7ce2c` (QA Front), facility BROOKLYN. Preserve the existing Theft creation draft and all user counts.
