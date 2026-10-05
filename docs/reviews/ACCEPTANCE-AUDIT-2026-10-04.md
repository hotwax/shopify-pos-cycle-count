# Storage refactor acceptance audit

Status: **Not signed off.** Source baseline `cf956cd88f4f8e7e4e2c162eca5c20bea7930b6e`.
Current deployed implementation `bcb301733b94879c5e985660e0859ea62dc7994a`;
Demo release `count-lock-banner-2026-10-04-r3`, Shopify version `1154641788929`.
Documentation head before this audit: `fa497f07d4c206a7d46f83a4483d208faceac385`.

Scope follows the storage handoff: actual store cycle counting, excluding store
settings and other Ionic/admin flows. Legacy migration is excluded by Aditya's
later explicit instruction. A passing earlier case applies to its recorded
revision; this audit does not describe the entire matrix as rerun on r3.

| Requirement | Authoritative evidence inspected | Current disposition |
| --- | --- | --- |
| Dynamic, directed and hard counts; optional independent dates | Core report: Physical core results and Native creation, with real OMS IDs/statuses | Scoped native passes recorded; date creation used the real native calendar |
| Multi-session quantities/drafts/parent eligibility | Core results and Independent unsaved hand-count drafts; session submission OMS readback | Passed at recorded implementation |
| Summary/navigation, badges, hidden IDs | Native core screenshots, session corrections, TC50 lock badge/banner | Observed native coverage; r3 adds visible blocked-scan explanation |
| Terminal lease, heartbeat, no journal writes on rejection | Actual OMS heartbeat reads; TC49 two physical foreign-lock attempts, unchanged 55 events/13-13-23 quantities; eight scan-access tests | Physical rejection after detection passed; pre-heartbeat timing is not measured |
| Native scanner, explicit HID/Return, camera | TC45-46 actual external scanner; earlier native HID; TC51 actual iPad camera and OMS 23→141 | Functional passes; exactly ten handheld triggers pending user confirmation; no latency/throughput sign-off |
| First mapping miss, shared mapping reuse, OMS identity before aggregation | Native first/second-session call trace and readbacks; persisted-field inspection | Scoped native trace passed; rich data remains runtime-only in measured records |
| Unmatched, retry feedback, images, per-event Undo and chronology | TC48 actual hardware events; native chronology under product alphabetical sort; process recovery evidence | Passed at recorded revisions; retry feedback is historical while live unmatched count updates |
| Hand-count inline quantities, review/discard, durable save | Core hand-draft/save and corrections results; independent OMS quantities | Scoped native pass |
| Large catalogue, bounded rendering, search replacement and sorting | 1,723 real products; 44-page scope/OMS order; TC44 exact-query replacement; source caps rendered page at 40 plus prefetch | Native observed scale 1,723, not 2,000+; real Demo countable catalogue has 1,771 products |
| Sparse later-page search and session cache scoping | PRODUCT-SEARCH-PAGINATION fixes and focused 25-page/equal-cardinality fixtures | Source/unit proof plus ordinary native search smoke; 25 actual native search pages not claimed |
| Directed extra select/review and null versus explicit zero | Real 30-product directed scope and OMS extra SKIPPED readback | Native passed |
| Bulk out of stock in one session | 29 directed and 1,722 hard zeros; paginated deduplicated OMS item/session readback | Native passed; backend inventory-join duplicates not treated as distinct items |
| Session/count submit for HotWax approval | Actual native actions and CYCLE_CNT_CMPLTD / SESSION_SUBMITTED OMS status reads | Passed; no final inventory approval or adjustment |
| Byte-filled storage, slim schemas, overflow and root recovery | Native 16-key measurement, identity 895 bytes; 5,068-event/997,922-byte overflow and restart | Actual native scoped passes; no claim of every crash boundary |
| Native quota failure | TC43 exactly 100 keys, next-set rejection, preserved prior checkpoint, cleanup fingerprints | Passed under guarded actual-native test; no user storage cleared |
| Foreground/background coordination and reopen | TC33 Home upload/receipt adoption; actual POS restart/recovery and TC46 offline capture/reconnect | Scoped passes |
| Clean installed offline cold start | TC47 failed before explicit app dev clean; installed r3 has now been verified after preview override cleanup | Still open; clean installed retest pending. Cleanup alone does not prove the root cause |
| Restricted operator / on-hand visibility | shared/count-policy.ts and extension TOML have zero baseline diff; permission unit tests; current real OMS operator is admin | Source policy unchanged; actual restricted-staff native run unverified |
| QA team deliverable | Existing Commerce QA Google Doc, TC50/51 and current r3 release read back | Updated in place; add pending results when actually executed |

## Remaining actions

1. Keep the camera closed; record before/after events and OMS quantity for
   exactly ten user-confirmed handheld triggers. Current baseline: 173 events,
   product 10101=141, other products 10001/10103=13/13, Unmatched=3.
2. After the hardware run is finished, disconnect Wi-Fi, normally restart POS
   and open the clean permanent tile. Restore Wi-Fi in all outcomes; retain
   user counts. Record native startup and saved quantities separately.
3. A true 2k+ real-product run needs a larger real catalogue; restricted-staff
   native proof needs the appropriate real operator/access. Do not fabricate
   backend product data or infer either gate from source/unit checks.

[Execution record](IPAD-CORE-PARITY-2026-10-04.md) contains the candidate, method,
limits and evidence for each historical pass. No merge, customer release,
POS reset/reinstall, global data clear or final inventory adjustment is authorized
by this audit. The approved Demo release is already live.
