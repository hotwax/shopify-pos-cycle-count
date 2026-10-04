# Native core parity — 4 October 2026

Candidate: `82773c561bc3e1bfe027f22cf64b80024b7785a3`. Accepted source baseline: `cf956cd88f4f8e7e4e2c162eca5c20bea7930b6e`. Physical Shopify POS 11.16.2 (530647), Demo / Brooklyn, terminal `POS_6230540442`, OMS operator `M100153`, real Demo OMS. This is a partial execution record, not complete regression sign-off or a customer release.

The previous storage-cleanup/search fix is described in [NATIVE-STORAGE-CLEANUP.md](NATIVE-STORAGE-CLEANUP.md). Its 106 automated tests, typecheck and build are separate from the physical results below. The clean development preview was attached through the POS Dev Console; the PR head and isolated checkout matched the candidate. Original checkout documentation and user counts were preserved.

## Physical core results

| Gate | Actual native result and independent OMS evidence |
| --- | --- |
| Dynamic scope / repeated input | QA count `POSC_687414a7504f2b7`: two native HID TextArea submissions of `MSH0232Black` each produced a separate event and increment. Appium typed the barcode and Return into the native control. This is not external HID hardware proof. |
| Unmatched filter / retry / removal | Two deliberately invalid `MSH0232` events stayed unmatched and unaggregated. The Unmatched filter showed those two events. Retry displayed “Still unmatched” and the OMS lookup reason. Removing both retained quantity four. |
| Matched undo | Undoing one matched event reduced QA Front from four to three in native UI and OMS. Its Undo action disappeared; the reversal appeared in chronological history. |
| Independent sessions | QA Front `POSI_ea6f47c77b7ce2c` retained three units; natively created QA Back `POSI_acf8389a3bdc16d` started empty and recorded one. Switching restored the correct session quantities. Independent unsaved hand drafts are verified separately below. |
| Session submission / parent eligibility | Front submitted while Back remained open: parent stayed in progress and approval remained unavailable. After both submitted, the native parent showed zero sessions still counting and enabled its primary approval action. |
| Dynamic count submission | Native review and Send for approval succeeded. OMS work status `CYCLE_CNT_CMPLTD`, both sessions `SESSION_SUBMITTED`, contributions three plus one. No final inventory approval/adjustment. |
| Directed scope / extra | Real REST fixture `POSC_0a20261004dc030`, session `POSI_0a20261004dc030`, 30 countable catalogue products. Native Start this count / open retained all 30 as uncounted. Scanning requested product `10001` counted one; product `10101` became Extra. The extra selection showed a checkbox and selected state; review/discard recorded `SKIPPED` in OMS. |
| Directed bulk zero | Native select-all, review and Confirm out of stock recorded the remaining 29 products as explicit zero, over two request batches. All 29 unique item keys/product IDs belong to one submitted session, `POSZ_93b88f6e3255ede`. The inventory view repeats item rows by inventory relation; 438 returned view rows are not 438 count items. |
| Directed count submission | Native primary approval action became available after zero completion. Review/send succeeded; OMS `CYCLE_CNT_CMPLTD`. Reviews contain 30 requested products: one quantity one and 29 quantity zero; extra `10101` remains skipped. |
| Hard scope / browsing / search / sort | Real REST fixture `POSC_0a20261004hc001`, session `POSI_0a20261004hc001`. Native summary loaded the independently read 1,723-product Brooklyn scope. Next changed to page 2/44; search `MSH0232` returned one correct product; clearing restored full scope. Alphabetical changed the leading rows. Hard summary has no Extra tab. Only visible/prefetched pages render; this run did not benchmark 2,000+ products. |
| Lock details / heartbeats | Native lock badge revealed terminal, count and session IDs. Two real OMS reads retained the same lock `fromDate`, advanced `lastHeartbeatAt` and extended its deadline by 59,694 ms. |
| Revoked / foreign ownership | For QA Hard Front only, the held lease was released and a finite `POS_QA_OTHER` lease created using the real lock APIs. The iPad detected ownership loss. Camera/HID/hand-count buttons became disabled; attempting native HID input added no visible event or OMS quantity. Recheck displayed the foreign-lock explanation. After expiry, reopen reacquired this iPad's lease and retained its unit. This does not prove physical scanner callback behavior while locked. |
| Search replacement / leave | In recovery session A, native hand-count search `M` returned 1,240 matching products. Replacing it with `MSH0232` and leaving returned to counting; re-entering and searching showed one correct match. This establishes navigation during replacement, not a measured cancellation of a specifically in-flight backend request. |
| Independent unsaved hand-count drafts | Recovery count `POSC_0a2026100400a11`, A `POSI_0a2026100400a11`, B `POSI_0a2026100400b11`: A's two-unit `10101` draft and B's three-unit `10001` draft survived Back and switching sessions independently. Both native review pages restored the appropriate quantities and images. Save recorded the correct separate contributions, confirmed by OMS readback. |
| Chronology after product sort | Recovery B recorded a later HID `MSH0232Black` event after its earlier three-unit hand count. Selecting Alphabetical in All products and returning to Scan events retained newest-first history: `MSH0232Black · 1:22:38 PM · Added 1`, then `MH09-XS-Blue · 1:21:59 PM · Added 3`. Product alphabetical order would put MH09 first; history did not follow it. |
| Modal reopen after brief POS background | Closed the modal, backgrounded Shopify POS for three seconds, then reopened the live local tile and recovery session B. Native UI restored `10001=3`, `10101=1`, newest-first history and this terminal's lock. The tile showed “All quantities synced”. This proves modal restoration after a brief lifecycle transition; it does not prove pending background uploads, process kill or offline recovery. |
| Camera entry | The native camera scanner opened and closed. No actual camera barcode was captured. External scanner status remained “POS scanner not connected”. |
| Hard bulk zero / approval | After its one counted unit and session submission, native select-all/review saved 1,722 remaining products across 69 batches. Independent paginated OMS readback: 25,848 inventory-view rows, exactly 1,722 unique import item keys/products, all zero, all in one session `POSZ_87e47032a0bf648`. Native approval submission succeeded; OMS `CYCLE_CNT_CMPLTD`. |

The counts/scope sessions above were prepared through real REST fixtures to preserve the user's creation draft. Those REST fixtures do not establish native count-creation or date-entry parity; the separate native creation pass below does. New sessions within the dynamic count were created natively.

## Native storage measurement

A temporary, read-only modal called the installed SDK's `shopify.storage.entries()` after the core pass. Only key/size/schema statistics and the business-only creation draft were displayed; no credential values were output. The inspector was then removed, restoring the candidate Modal source exactly. Its inspection screen is diagnostic host evidence, not counting-flow evidence from the clean candidate.

At the observation: **16 entries, 22,866 UTF-8 JSON bytes total**. The namespace contained five session event/item pairs (including the existing `M100461` session), control, mailbox, one legacy lease, foreground coordination, shared identity and OMS origin. No overflow values were present at this small size.

- Shared identity: **30 pairs, 895 bytes**, one `hotwax-count:identity` document.
- Event documents: 391–2,714 bytes; no title, SKU, image, primary/secondary display or barcode-code-array fields in event records.
- Count-item documents: 1,076–8,784 bytes; barcode code arrays present, no title, SKU, image or primary/secondary display fields in item records.
- Control: 2,255 bytes. Mailbox: 118 bytes. These values are observed usage, not a promised fixed slot count.
- The unchanged creation draft was verified: `Theft`, `DYNAMIC_COUNT`, start `2026-10-03`, due `2026-10-04`, empty product ID list. The inspector made no storage writes or deletions.

## Native overflow journal and process recovery

The clean implementation remains `82773c5`; PR head `67376ab` only added the earlier evidence. A dedicated third recovery session, **QA Event Capacity** (`POSI_8fea78a9f0fb7f9`), was created natively in `POSC_0a2026100400a11`.

A 100-barcode Appium keyboard command took 131,556 ms and was interrupted by POS's two-minute idle PIN screen. Exactly 68 events and 68 OMS units were reconciled. This command does not establish a lost-event defect or real scanner throughput; native keyboard injection did not keep the register unlocked.

A temporary control, restricted to this QA session, then called the existing native `enqueue` path 5,000 times with the real product barcode `MSH0232Black`. It used the candidate's lease guard, journal append, aggregation and real Demo OMS sync. This was programmatic journal stress on the physical POS extension, not external scanner proof. It accepted all 5,000 events; append/aggregation/attempted sync/inspection took 76,636 ms. The temporary control was removed and the component restored exactly before recovery testing; no diagnostic code was committed.

The measured 5,068-event journal occupied **997,922 UTF-8 JSON bytes across three native KV values**:

| Value | Bytes |
| --- | ---: |
| Root scan-events document | 55,856 |
| Overflow `:more:1b` | 450,189 |
| Overflow `:more:2b` | 491,877 |

Each value was below the candidate's 900,000-byte working limit. This proves actual native overflow at this size, not store-wide exhaustion or interrupted migration.

During the stress run, sync reported that the terminal no longer owned the session; the server still had 68 while local storage held 5,068. The OMS lease was expired when inspected. The exact timing/cause of the missed renewal was not isolated, so this is not declared a new refactor regression. After reopening the clean candidate, the terminal reacquired its lock, restored every local event and synced **5,068 units**, independently confirmed through the OMS items API.

Native Undo then produced **5,067 units and 5,069 journal entries** (the reversal remains in history). OMS independently confirmed 5,067. The reversed event lost its Undo action; the newest reversal and matched rows displayed product images. A normal full POS process restart, verified unlock and reattachment to the same preview restored 5,067, all 5,069 events, terminal ownership and synced status. Scan-history paging changed from 1/127 to 2/127 and back. No second 5,000-event batch was attempted.

[Clean native history after process recovery](evidence/native-capacity-recovered.png)

## Network interruption limit

Turning off iPad Wi-Fi made the development preview show the POS host's “Error loading extension” before any offline scan could be recorded. Wi-Fi was restored. The live tunnel/manifest were available, and a normal POS process restart plus preview reattachment recovered the clean app and existing recovery-session data. This does not prove a customer-installed offline defect or offline parity: the test involved the development preview/tunnel. No reset, reinstall or data clear was used. Offline scanning remains unfinished. The subsequent online POS Home background upload result is recorded below.

## Native creation, independent optional dates and shared mapping

Follow-up checkout/PR head at the start: `dfdee77da8bff19192eea60a5d182b7ff11ce488` (documentation only); clean implementation remains `82773c5`. All three counts below were created and started through the physical POS extension against Demo OMS, rather than inserted through REST.

| Native form | Created count / seed session | Independent OMS readback |
| --- | --- | --- |
| Dynamic, neither date | `QA Native D0`, `POSC_e21baf00518696e` / `POSI_e21baf00518696e` | `DYNAMIC_COUNT`, both estimated dates absent, `CYCLE_CNT_IN_PRGS`. Native review displayed “Start when ready · No deadline”. |
| Directed, start only | `QA Native DS`, `POSC_7f5d260590b4518` / `POSI_7f5d260590b4518` | `DIRECTED_COUNT`, start `1791090000000`, due absent. Native product search/select chose `10101`; items independently show that sole requested product with quantity unset. Native review displayed “Starts 2026-10-04 · No deadline”. |
| Hard, due only | `QA Native HD`, `POSC_896521285eec3dd` / `POSI_896521285eec3dd` | `HARD_COUNT`, start absent, due `1791262799999`. Native review displayed “Start when ready · Due 2026-10-05”; clean summary loaded the actual 1,723-product facility scope, with no Extra tab. |

Dates were entered with the native calendar. A temporary guarded draft control preserved the exact existing `Theft` creation draft, blanked only the QA draft entry for these tests and then restored the original draft through the same field setter. Original and restored JSON were compared exactly; the clean creation screen reopened with its original name, dynamic type, both dates and empty product selection. The temporary controls and generated declarations were removed exactly. No full control document replacement or storage clear occurred. WDA clearing a read-only date field did not unset it; that operation was not used as proof of optional dates. The accepted baseline uses the same native calendar component, so this is not reported as a new refactor regression.

[Clean native hard-count summary after creation](evidence/native-hard-created.png)

A temporary trace, restricted in the UI to `QA Native D0`, delegated the original `enrichScan`, `lookupIdentityBatch`, `lookupBatch` and shared-map `get` calls. It logged business IDs and timestamps in memory, never replaced API results or persisted rich data. The first actual native HID TextArea submission of `MP1133Brown` enriched through Shopify to variant **45679042199706** with an image, then called `lookupIdentityBatch`, which returned HotWax product **10060** with that same variant ID. Observed call durations: 67 ms for Shopify enrichment and 232 ms for identity lookup; these are single-call observations, not scanner-to-sync throughput benchmarks. Real Solr identifies this as `ShopifyShopProduct/10010/45679042199706`; variant `43899518189821` belongs to shop 10000 and was not used for this POS matching result.

After a modal reload, a second empty session was created natively: **QA Map B**, `POSI_f5f32bb13849738`, in the same parent. The same barcode enriched through Shopify (53 ms), then shared-map `get(45679042199706)` returned **10060**. No `lookupIdentityBatch` or `lookupBatch` ran for that scan. Independent OMS items reads confirmed one unit of 10060 in each separate session. This proves cross-session reuse after reload, rather than a same-session barcode/item cache hit. [First native trace](evidence/native-map-first.json), [second native trace](evidence/native-map-second.json).

The trace helper, workspace wrapper and generated declaration were removed exactly; `git diff --exit-code` confirmed the candidate source was clean before the further UI checks. No diagnostic code is committed.

## Measured native scan layout on the clean candidate

After removing the trace, QA Map B received real native TextArea/Return submissions for `MP1133Green`, deliberately invalid `QA-NO-PRODUCT-20261004` and another `MP1133Brown`. Native UI showed the appropriate green/brown product images and unmatched state; independent OMS reads showed 10061=1 and 10060=2. The invalid scan remained unmatched and did not add an OMS item. It remains visible in this QA session intentionally.

With the native input already focused and keyboard settled, recorded accessibility bounds for **eight buttons/tabs** (camera, HID, hand count, submit and all four list tabs) were identical before input, at the first post-input snapshot and after the observed settled feedback for all three submissions. A separate first scan in previously empty directed session `POSI_7f5d260590b4518` established the same unchanged bounds from **Ready to scan** to **Counted** and switched to Scan events; OMS confirmed requested product 10101=1. This includes first-match, replacement image, unmatched and subsequent matched transitions. [Repeated/matched/unmatched bounds](evidence/native-scan-layout.json), [initial Ready-to-Counted bounds](evidence/native-scan-layout-first.json).

The only accessibility-tree difference in these snapshots was a disabled Submit session button's static-text child being omitted; the button itself retained its bounds. This is not page movement. These are sampled native bounds, not a continuous frame-by-frame video or proof of external-scanner focus/throughput. The keyboard's initial appearance/scroll was allowed to settle before measurement. No diagnostic source code was present for this pass.

## Native legacy migration and retained hand draft

PR head before this pass: `6121bd1042becb1aae6109e3794a31b7e26d246e`; clean implementation remains `82773c5`. Dedicated session **QA Legacy Migration**, `POSI_0a20261004cafe1`, belongs to the natively created dynamic count `POSC_e21baf00518696e`.

A temporary guarded fixture used the exact baseline `cf956cd` page/COW storage writer on the physical extension's native KV store. Real Demo OMS created this QA session, supplied both products and confirmed Brown product `10060` at quantity two before the fixture. Only previously absent keys for this QA session were seeded; the current control store added its session entry without replacing unrelated fields.

The legacy fixture contained four journal events, Brown local quantity three at revision three with an older confirmed receipt for quantity two, a pending Green event with its legacy embedded product identity, one invalid unmatched barcode, and a Brown event already included in the item checkpoint but still marked unapplied in the journal. A legacy hand draft added two Brown units. This models interrupted aggregation and stale receipts with actual baseline-format native values; it is not an installation/upgrade of the complete old app binary.

After removing the temporary seed and restoring the clean candidate, native Resume counting retained Brown at **three** and recovered Green `10061` at **one**. Independent OMS items reads confirmed both. The checkpointed Brown event was not counted twice, the pending Green identity was retained, and the older two-unit receipt did not erase the newer Brown quantity. Hand count reopened the two-unit draft; review showed Already counted **3**, After saving **5**. Native Save recorded one hand-count event; independent OMS readback confirmed Brown **5**, Green **1**. The invalid event stayed unmatched.

A temporary read-only native inspector observed exactly **two current-format `hotwax-count-3` roots**, five journal events, one pending unmatched event, and no rich product objects/title/image/SKU fields in persisted event/item records. Old page roots/pages and receipt keys were gone; the legacy and current saved hand-draft entries were absent after successful save. The inspector was removed and the Modal and generated declarations restored exactly before further recovery. A normal full POS process restart, verified unlock and reattachment to the same preview reopened this clean session with Brown **5**, Green **1**, the same terminal lock and the unmatched event retained. [Business-only migration measurements](evidence/native-legacy-migration.json).

## Limits / remaining gates

Not yet proven: physical external/HID and actual camera scans; 2,000+ scope; store-wide near-capacity/interrupted migration; offline reopen, OS suspension and changed-role upload ownership. Online POS Home background upload and controlled local-preparation cancellation passed in the subsequent checks below. Existing automated crash-recovery tests are separate evidence.

The current Demo facility has 1,723 products and the countable variant query returned 1,770; no fabricated products or global inventory changes were made to inflate scope. A native PIN idle screen requires reinspection/reopen during long observations; it is not an expired signing/profile problem. No POS reset, reinstall, storage clear, customer deployment, merge, final approval or inventory adjustment occurred.

During the foreign-lock check, the session badge used “Lock needs recheck” while the explanation correctly identified another terminal. The same `leaseProblem` precedence exists in the accepted baseline. Record this as a pre-existing label issue, not a new storage-refactor regression. The foreign-lock summary's red notice was not conclusively captured before the finite QA lock expired.

The immediate Back-on-open probe did not establish cancellation: the empty QA session finished opening before a stable cancelled summary was observed. Keep this gate unfinished; an Appium click acknowledgment alone is not proof that the opening route handled Back.

Native creation fixtures also remain in progress: D0 has separate contributions 10060=1 in its seed session and QA Map B has 10060=2, 10061=1 plus one deliberately unmatched event. DS has its requested 10101=1; HD remains uncounted. No duplicate session was created after an automation navigation failure.

Recovery fixture sessions remain in progress intentionally. At the core-pass observation, A had `10101=2`; B had `10001=3` and `10101=1`; QA Event Capacity had `10101=5067`. The later background pass increased B to `10101=3`, with `10001=3` unchanged. The parent has not been submitted for approval.

Harness observations were checked against fresh native UI: the hand search field is “Find an OMS product”, successful save feedback says “Counted” instead of “Ready to scan”, and HID history uses the scanned barcode rather than SKU. Waiting for the wrong labels caused test timeouts; those were not app regressions. Dismissing the numeric keyboard allowed navigation to an offscreen Back button.

## Selected physical evidence

- [Dynamic count awaiting approval](evidence/native-core-dynamic-approval.png)
- [Hard count: 1,722 zeros completed](evidence/native-core-hard-zero.png)
- [Restored independent hand draft](evidence/native-core-hand-draft.png)
- [Chronological scan events after product sorting](evidence/native-core-chronology.png)

## Additional POS Home upload and opening cancellation checks

On candidate head `146d9d2` (implementation `82773c5`), QA Recovery B
`POSI_0a2026100400b11` accepted a native TextArea Return scan for
`MSH0232Black`. Before closing, the UI showed quantity 3 and one product
pending sync. Independent OMS read immediately after closing still showed 2.
With the extension closed, the next read at 47 seconds showed 3.
A read-only native inspector showed the background mailbox receipt for
product `10101`, revision 3, quantity 3, and status `background: true`; the
modal-owned item remained revision 3 / syncedRevision 2. Reopening adopted
syncedRevision 3. After removing the inspector, the clean extension reopened
at quantity 3. Product `10001` remained 3. An earlier attempt completed in the
foreground and is excluded from background proof.

Evidence: [native-background-upload.json](evidence/native-background-upload.json).
This proves online POS Home upload and receipt adoption, not physical scanner
input, offline execution, OS process suspension or changed-role ownership.

Opening cancellation is partial: the clean capacity session showed Opening
session at 2,666 ms, and Back at 3,471 ms returned to a usable summary without
a late route change in the observed interval. The interrupted preparation
stage was not identified. A temporary stage label later showed native journal
opening, but the native Back element became stale as opening finished before
the tap landed. No successful local-preparation cancellation is claimed.
Both temporary diagnostic modifications were restored to the candidate source.

The shared [QA Google Doc](https://docs.google.com/document/d/1QJxi_u8oLpWTde1GNrLioxo4FN-vYmlPmbO-cSfQ7dE/edit)
now records 33 cases, including TC33 for this background check and the precise
TC29 cancellation limitation.

## Controlled native local-preparation cancellation

On head `a4e4558` / implementation `82773c5`, a temporary QA-only wrapper
delayed delivery of one actual native SDK count-item read for QA Event Capacity
by eight seconds. It returned the real value unchanged and delegated all
other native reads/writes and OMS calls. Native opening showed the read stage
at 3,979 ms; the ordinary Back action completed at 5,333 ms and returned to
All counts / Start a new session. After a further ten seconds, late
preparation had not changed the summary route. Reopen retained 5,067 units
and reacquired this terminal's lock.

After restoring CountWorkspace exactly, the clean candidate reopened with
5,067 units and 5,069 events (page 1/127). Independent Demo OMS read remained
5,067. This passes cancellation through local preparation under controlled
native delivery latency; it is not a natural SDK-stall or unchanged-binary
timing benchmark. No scan was entered while opening.
[Business-only result](evidence/native-local-open-cancel.json).

TC29 in the shared QA document now records this controlled pass with its
method and limitations. The previous natural-timing attempt remains partial.

## Manual matching, absolute correction, reopen and session metadata

Clean implementation `82773c5`, evidence head `21d9a12`, physical POS 11.16.2
(530647) and real Demo OMS; no diagnostic source in this pass. In QA Map B
(`POSI_f5f32bb13849738`, parent `POSC_e21baf00518696e`), native Unmatched →
Match → product search selected Brown `10060` for the existing invalid event.
Brown advanced 2 → 3, Green stayed 1, Unmatched became zero and the same four
events remained. Independent OMS readback confirmed both quantities.

Opening Brown from Counted and saving an absolute total of four produced one
newest Set total 4 event. Native and OMS retained Brown 4 / Green 1, with five
events; it did not add four to the old quantity. The existing Unmatched filter
persisted until All events was selected. This pass did not identify the
remaining Undo action's product by native row, so source fencing is separate.

Native Submit session saved `SESSION_SUBMITTED` and read-only history. More →
Reopen session returned `SESSION_ASSIGNED`, restored this terminal's lock and
counting controls, and retained quantities 4 / 1 and the same five events.
The parent remained `CYCLE_CNT_IN_PRGS`. Native Edit session saved
QA Map B Edited / display, then saved QA Map B / register again. Independent
OMS verified both metadata states and unchanged quantities. A hidden home
tile retained an old name temporarily; whole-source text absence was not
used as persistence proof.

[Business-only results](evidence/native-session-corrections.json). The shared
QA document now includes TC34–TC37 with steps, expected/observed results and
limits. Input was through native controls, not physical scanner capture.
No final inventory approval or adjustment occurred.

Native session discard also passed (TC38). Dedicated session
`POSI_0e961501751dfb7` recorded Brown 1; its actual QA name was
QA Discardġ (native keyboard composition suffix). Before discard, the team
summary was Brown 11 / Green 2, four still counting. More → Discard session →
Discard this session made its native row/detail Voided and OMS
`SESSION_VOIDED`. The item Brown 1 remains for audit. Summary then showed
Brown 10 / Green 2, three still counting; other sessions remain
`SESSION_ASSIGNED`, QA Map B remains 4 / 1, and parent remains
`CYCLE_CNT_IN_PRGS`. The host tile's generic Session submitted label was
not used as void-status proof. No session deletion or inventory adjustment.
The shared QA document now contains 38 cases; remaining gates are explicit.

## Search audit fixes and native follow-up

The completion audit found two source regressions in the refactor: a permanent
twenty-page Shopify member-search cutoff, and query-cache reuse across
equal-sized sessions with different products. Fixed in `d0db9c2` / `2a607b0`;
see [PRODUCT-SEARCH-PAGINATION.md](PRODUCT-SEARCH-PAGINATION.md). The focused
fixtures reproduce the old failures and pass the new behavior. All 108 tests,
typecheck and release build passed; gzip 64,982 bytes against gate 65,024.
Count storage, aggregation, background synchronization and hand-count source
remain identical to implementation `82773c5`; no new keys or data migration.

On clean `2a607b0`, physical POS resumed QA Map B and restored this terminal's
lock. Query Gym returned Brown and Green in All and Counted (two products),
and zero in Uncounted. Independent OMS read remained Brown 4 / Green 1.
Scan events retained the same five newest-first rows, starting with Set total
4, and Unmatched (0). Native scanner status was not connected.
[Business-only measurements](evidence/native-search-follow-up.json).

TC39 and TC40 in the shared QA document distinguish native small-scope checks
from synthetic 25-page/cache regression tests. Forty cases are documented;
not every case is native and not every remaining gate is passed. A real
2,000+ catalogue, physical scanner/camera capture, installed offline behavior,
native quota/interrupted commit and restricted roles remain unfinished.
No QA count writes or final inventory adjustment were needed in this pass.
