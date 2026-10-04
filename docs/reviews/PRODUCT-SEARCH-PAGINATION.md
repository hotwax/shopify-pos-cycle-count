# Sparse product search pagination — 4 October 2026

Fixes: `d0db9c29d67712ee82cd9bf1ac0d053195525eaa` and
`2a607b0` (actual membership cache scope); base
`911c508efda850946ffebbea87b5ca046995d5c0`, PR #1.

The refactor's Shopify-backed member search stopped permanently after twenty
50-product pages. The UI then stopped requesting continuation even though
Shopify reported more results. A count containing a variant on page 25 could
therefore show no match. The earlier source searched the complete local
catalogue; the arbitrary new cap weakens that behavior. This is a confirmed
source/automated regression, not a reproduction on Demo's larger catalogue.

Removed the page-count cutoff. The existing four-second search pass, cursor
continuation, query cancellation generation, 40-row rendered list and bounded
query/display caches remain. Filtered non-members do not stop the search;
whole-result sort requests can finish the result set. No new storage fields,
keys, count aggregation, migration, background writer or hand-count logic.

The focused test models 25 real-shaped Shopify pages, one early counted
member and an uncounted member on page 25. Simulated time advances 250 ms per
call: pass one yields at sixteen pages; pass two resumes and finds the late
member at page 25. An Infinity request then obtains the complete cached set
without another API call. Against the prior implementation the equivalent
fixture stops at twenty calls with an empty result, incomplete=true and
capped=true. These are synthetic API/pagination tests, not native catalogue
or HotWax backend proof.

Validation: 108 tests passed; typecheck and release build passed. Main
extension gzip 64,982 bytes, existing gate 65,024 / platform 65,536. Shopify
2026-07 Product Search documentation confirms cursor pagination; Toolkit
validated ProductList's native components (custom children excluded).

Native candidate retest and remaining gates are recorded in the shared QA
document and core parity report. Demo's actual 1,723-product scope cannot
prove 2,000+ performance or 25 native search pages.

A second source regression reused query hits across sessions whenever their
member counts were equal, even if their variant IDs differed. Against the
old source, searching a second one-product session returned the first
session's product and made no new search request. The cache now invalidates
on the complete variant-to-HotWax membership, not its cardinality. A focused
fixture verifies each session receives its own member; it is unit proof,
not a native cross-session cache trace.

At clean candidate `2a607b0`, physical POS resumed QA Map B, reacquired this
terminal's lease, and searched Gym. All and Counted each showed the correct
two hydrated Brown/Green rows; Uncounted showed zero and the empty state.
Independent Demo OMS read remained Brown `10060=4` / Green `10061=1`. Native
POS reported scanner not connected. These observations validate ordinary
scoped search/filter behavior on the changed candidate, not 25 actual POS
search pages, a 2,000+ scope or physical scanner capture. No QA count writes
were needed for this smoke check.
