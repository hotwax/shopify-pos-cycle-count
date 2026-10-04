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

The counts/scope sessions above were prepared through real REST fixtures to preserve the user's creation draft. They do not establish native count-creation or date-entry parity. New sessions within the dynamic count were created natively.

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

Turning off iPad Wi-Fi made the development preview show the POS host's “Error loading extension” before any offline scan could be recorded. Wi-Fi was restored. The live tunnel/manifest were available, and a normal POS process restart plus preview reattachment recovered the clean app and existing recovery-session data. This does not prove a customer-installed offline defect or offline parity: the test involved the development preview/tunnel. No reset, reinstall or data clear was used. Offline scanning and pending background upload remain unfinished gates.

## Limits / remaining gates

Not yet proven: native count creation and independently optional dates; cancellation through local preparation; measured per-scan layout movement; native shared-map-hit versus Solr call tracing; physical external/HID and actual camera scans; 2,000+ scope; store-wide near-capacity/interrupted migration; offline reopen and foreground/background upload ownership. Existing automated crash-recovery tests are separate evidence.

The current Demo facility has 1,723 products and the countable variant query returned 1,770; no fabricated products or global inventory changes were made to inflate scope. A native PIN idle screen requires reinspection/reopen during long observations; it is not an expired signing/profile problem. No POS reset, reinstall, storage clear, customer deployment, merge, final approval or inventory adjustment occurred.

During the foreign-lock check, the session badge used “Lock needs recheck” while the explanation correctly identified another terminal. The same `leaseProblem` precedence exists in the accepted baseline. Record this as a pre-existing label issue, not a new storage-refactor regression. The foreign-lock summary's red notice was not conclusively captured before the finite QA lock expired.

The immediate Back-on-open probe did not establish cancellation: the empty QA session finished opening before a stable cancelled summary was observed. Keep this gate unfinished; an Appium click acknowledgment alone is not proof that the opening route handled Back.

Recovery fixture sessions remain in progress intentionally. This retains a usable QA counting session for further recovery/scan tests. A has `10101=2`; B has `10001=3` and `10101=1`; QA Event Capacity has `10101=5067`. The parent has not been submitted for approval.

Harness observations were checked against fresh native UI: the hand search field is “Find an OMS product”, successful save feedback says “Counted” instead of “Ready to scan”, and HID history uses the scanned barcode rather than SKU. Waiting for the wrong labels caused test timeouts; those were not app regressions. Dismissing the numeric keyboard allowed navigation to an offscreen Back button.

## Selected physical evidence

- [Dynamic count awaiting approval](evidence/native-core-dynamic-approval.png)
- [Hard count: 1,722 zeros completed](evidence/native-core-hard-zero.png)
- [Restored independent hand draft](evidence/native-core-hand-draft.png)
- [Chronological scan events after product sorting](evidence/native-core-chronology.png)
