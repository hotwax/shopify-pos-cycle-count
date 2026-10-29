# HotWax Cycle Count for Shopify POS

A native Shopify POS extension for store cycle counting, with a Shopify-hosted App Home for connecting the shop to HotWax OMS. Scans are saved on the POS device, matched to OMS products, grouped into session quantities, and synchronized into HotWax's cycle-count approval workflow.

## Counting flow

- Create a **dynamic**, **directed**, or **hard** count, with optional start and due dates. Dynamic counts include the products staff choose to count; each included product must represent its full store quantity across sessions. Directed counts use a selected scope; hard counts cover the facility scope.
- Start an unscheduled Dynamic count directly from its name. Count type and dates sit under **Count options**. **Resume counting** opens the operator's session directly when there is exactly one eligible session; team/session selection remains available when needed.
- Count with a connected POS scanner, the camera, an explicitly enabled HID input, or **Enter quantities**. Quantity entry keeps Review and Add in the native header; product names lead and SKU/variant details are secondary.
- Inspect scan events in fixed newest-first order, filter unmatched scans, retry or correct matching, and undo individual events. Product sorting does not change event chronology.
- **Finish count** shows the total and one confirmation. When all products and other sessions are ready, **Send for approval** submits the session and count together. Otherwise **Finish my session** saves the operator's part and returns to the team summary. Resolve remaining products through counting or reviewed **Mark as out of stock** selection; a bulk zero confirmation uses one session across multiple batches.

Submission reads the current status before writing. If a response is lost, it checks status again without automatically repeating the write. An unresolved outcome keeps the saved quantities and offers **Check and retry**; an already-submitted session or count skips its write. Submission status and quantity checks do not reload product display or inventory enrichment.

Submitting a count sends it for review. This app does not approve or apply inventory adjustments. Discarding extra products records a `SKIPPED` review decision for those products only.

## Architecture

| Location | Responsibility |
| --- | --- |
| `extensions/hotwax-cycle-count/src` | POS tile, native screens, scanner integration, local journal/checkpoints, terminal leases and background synchronization |
| `extensions/app-home/src` | Shop-level OMS connection setup |
| `shared` | Shopify identity exchange, OMS configuration, API adapters, permissions and count workflows |
| `tests` | Local state, recovery, matching, lease, workflow and configuration regression checks |
| `docs/oms/DynamicCountData.xml` | OMS `DYNAMIC_COUNT` enumeration required when it is not already installed |

An accepted scan is durably appended before aggregation. Shopify POS product lookup supplies display data when available, while OMS matching establishes the HotWax product ID required for aggregation. OMS product details provide a fallback when native lookup misses. Unmatched events remain available for resolution without blocking other products.

The app uses Shopify Storage API values only. It does not use IndexedDB, a custom Web Worker or a service worker. Product and event lists render at most 40 rows per page, and network writes use bounded batches.

### Local storage

Shopify allows 100 entries per extension and about 1 MB per value, shared by every operator on the register.

**Count documents.**
- Each session has a scan journal and a count checkpoint. Each starts as one value that is overwritten in place, and new keys are added only when a value would pass 900,000 bytes (measured, not counted in records).
- Overflow values alternate between two slots, and the root value is written last, so a multi-value save commits atomically. A rejected write is reconciled before the next one, and an interrupted save is cleaned up on the next open.
- The documents hold only identities, quantities and replay, undo and sync state. Names and images are fetched again by Shopify variant (or from HotWax) for what is on screen, and kept in a bounded memory cache.
- A scan is stored before it is acknowledged. Scans that arrive during a write share the next one.

**Shared variant map.** One map per Shopify shop and OMS connection links Shopify variant IDs to HotWax product IDs. Its pairs come only from HotWax: this count's products and countable search results. A scan whose variant is already mapped skips the HotWax lookup.

**Product search.** Search in a session's product list uses POS product search and keeps the session's products in Shopify's relevance order, followed by local matches on identifiers and barcodes.

**Earlier releases.** Documents and small values from earlier releases are converted when the modal first opens, in place and without clearing storage. Background upload resumes once a session has been converted.

| Key | Written by | Removed |
| --- | --- | --- |
| `hotwax-count:<owner>:sessions` (control: saved sessions, leases and release fences, hand-count and count drafts, pending decisions and creations, status) | Modal | When it holds nothing (status alone does not keep it) |
| `hotwax-count:<owner>:background` (mailbox: sync receipts per checkpoint, leases it claimed, its status) | Background | When the operator has no saved sessions |
| `hotwax-count:<owner>:session:<id>:scan-events` / `:count-items`, plus `:more:<n><a/b>` overflow | Modal | By *Remove local copy*, or automatically once HotWax has finished with the session (discarded, count closed or cancelled, or submitted and approved quantities confirmed) |
| `hotwax-count:identity` (shared variant map) | Modal | Replaced when the shop or OMS connection changes |
| `hotwax-count:oms-origin` (the shop's OMS origin, for background use) | Either runtime | Replaced when the setting changes |
| `hotwax-count:foreground`, `hotwax-count:background-busy` (coordination heartbeats) | Modal and background respectively | When each runtime finishes; they expire after 15 s otherwise |

As a measured example, five sessions of 2,000 products and 4,000 scans each use 16 document values (largest 830 KiB) plus the five small keys above. See `tests/storage-redesign.test.ts`.

Within one POS runtime, the shop's OMS origin, the OMS login (up to four minutes) and the store context (up to two minutes) are reused, so most actions need one OMS round trip. A rejected login or permission drops them immediately.

Sessions are scoped to shop, facility and staff. Online, counting requires a confirmed, unexpired lease for the current POS terminal. Offline, a terminal keeps counting into its local journal on the lease OMS last confirmed for it; on reconnecting it reclaims the lease, and every sync renews that exact lease before writing, so a takeover elsewhere is reported instead of overwritten. Losing ownership (an OMS rejection) pauses scanning; an unreachable OMS does not, until the lease expires. Shopify's background target can sync already-matched quantities while its runtime is available; force-quitting POS cannot guarantee background progress.

## Setup

1. Install a supported Node.js/npm environment and the [Shopify CLI](https://shopify.dev/docs/api/shopify-cli). This checkout has been validated with Node 26 and npm 11.
2. Install dependencies:

   ```sh
   npm ci
   ```

3. The checked-in `shopify.app.toml` and extension UIDs identify the existing **HotWax Cycle Count** app. Use an account authorized for that app. For a separate app registration, use Shopify CLI's app configuration workflow before building or deploying; do not deploy another app through these identifiers.
4. Register the matching Shopify app identity in the target OMS for the app-bridge login exchange. Keep its app secret in OMS configuration only. Configure the shop/location mappings and staff permissions required by HotWax cycle counting. If necessary, have the OMS administrator load `docs/oms/DynamicCountData.xml`.
5. Open App Home and save the OMS HTTPS origin. It is stored on the current app installation in the `hotwax_config.oms_url` metafield. URLs must not contain credentials or paths. POS reads this configuration and exchanges the current Shopify session token with `/rest/s1/app-bridge/login`; credentials are not bundled or written to extension storage.
6. Add the **HotWax Cycle Count** extension tile in Shopify POS.

Optional local preview configuration:

```sh
cp .env.example .env
npm run dev -- --store your-development-store.myshopify.com
```

`POS_OMS_LOCAL_PREVIEW=true` enables the existing test-environment write guard. The guard accepts Test Maarg or the exact Demo Maarg / HotWax Demo pairing defined in the adapter. It does not provision an OMS registration or inject credentials. Keep `.env` local.

## Validation and releases

```sh
npm test
npm run typecheck
npm run build
```

`typecheck` checks the shared TypeScript configuration; Shopify's build validates the extension bundles. Local tests exercise state and adapter logic and do not replace physical scanner, multi-terminal, or live OMS acceptance.

Release only to the intended Shopify app:

```sh
npm run deploy -- --version <release-name> --message '<release-summary>'
```

`shared/oms-build-config.ts` is generated and gitignored: `npm run build` and `npm run deploy` write it with development flags disabled, `npm run dev` writes preview flags, and tests or typechecks only create it when it is missing. Always build and deploy through the npm scripts; running `shopify app build` or `shopify app deploy` directly ships whatever flags are on disk. Building alone does not release an app. See [Shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy) for the release command. Stop the development preview before checking an installed release; an already-open POS extension may need POS to be relaunched to load the released bundle.

The initial implementation has been deployed to a demo store and opened on a physical iPad with the local development server stopped. The current local regression suite contains 123 passing tests. Builds fail if an extension bundle comes within 512 bytes of Shopify's 64 KB compressed limit (`scripts/check-bundle.mjs`). Raw device captures, local test readbacks, historical implementation notes and machine-specific tool configuration are deliberately excluded from this repository.

## Customer rollout boundaries

### Gorjana sandbox

`shopify.app.gorjana-sandbox.toml` identifies the separate **Gorjana Cycle Count Sandbox** app
(`41bb8b2042d05ae284cbc6c68b54ce04`). Its custom distribution is restricted to
`gorjana-sandbox.myshopify.com`; use `https://gorjana-maarg-uat.hotwax.io` in App Home.
The default `shopify.app.toml` still identifies the original HotWax app.

Use the named scripts so both build and deployment select the same sandbox configuration:

```sh
npm run build:gorjana-sandbox
npm run deploy:gorjana-sandbox -- --version <release-name> --message '<release-summary>'
```

The UAT integration shop is `10000`. A legacy `HC_CUSTOM_APP` record shares its domain,
so lookup selects the uniquely enabled integration and rejects ambiguous enabled records.
Location mappings must also resolve uniquely; do not substitute a different facility when they do not.

UAT registers the POS app through a dedicated `GORJANA_CC_SANDBOX` remote linked with
purpose `SsctCycleCountPosApp`, separate from the existing default integration remote.
Only its client identity and signature-verification secret are needed for sign-in;
do not embed the secret in this repository or give this remote an outbound Shopify token.
UAT also requires the `DYNAMIC_COUNT` reference value from `docs/oms/DynamicCountData.xml`.

The bundle gate measures Brotli quality 11, matching Shopify CLI 4.9.4, and retains
the 512-byte margin below 64 KB. Shopify's deployment validation is the final size check.

Sandbox validation on 2026-10-29 finished on installed release
[`gorjana-sandbox-2026-10-29-r6`](https://dev.shopify.com/dashboard/129669934/apps/441352650753/versions/1186266677249)
on a physical iPad running Shopify POS 11.17.1. The simplified Create count flow
opened its first session directly. A pending one-product/three-unit quantity draft
survived a POS restart and release refresh, and Review restored the full product
name. The final **Finish count → Send for approval** flow submitted both the
session and whole count, returning directly to the approval summary.

Live UAT readback for `POSC_45a80ddef9acbdb` confirmed `CYCLE_CNT_CMPLTD`, session
`POSI_45a80ddef9acbdb` `SESSION_SUBMITTED`, one product with quantity 3 and
`approvedDate: null`. No approval or inventory adjustment was performed.
The r6 POS bundle is 57,371 bytes Brotli-compressed; App Home is 9,060 bytes.
123 local regression tests, shared TypeScript, Shopify configuration and changed
2026-07 POS component validation pass.

The earlier device submission entered **Checking submission** and then **Check
and retry** while retaining its saved quantities. Investigation measured the
legacy session-item endpoint at 17.8–18.3 seconds because it joins inventory.
Submission now uses the existing session count aggregate (1.4 seconds in the live
probe); session reopening has a bounded 25-second allowance for the legacy read.
The final device submission completed successfully. Lost-response success and
already-submitted write skipping are covered by local regression tests; no
artificial network fault was injected on the iPad.

This is a sandbox smoke test, not production acceptance. Legacy session loading
can still be slow. Physical scanner, physical network interruption/reboot,
multi-terminal, restricted-staff and VoiceOver scenarios remain unverified.
App Home rendered and saved configuration on the iPad; desktop Chrome automation
previously displayed a blank App Home and was not retested in this UX pass.

### Acceptance

- The app verifies lease ownership/generation before writes. Atomic ownership, expiry and count-completion fencing must also be enforced by OMS to protect against concurrent or legacy clients.
- A PIN-only operator must not inherit the logged-in account's OMS authority. The existing login contract requires matching authenticated identities; broader staff delegation needs corresponding server authorization.
- Customer-scale OMS loading, simultaneous terminals, sustained hardware-scanner throughput, physical network interruption, reboot recovery and customer permissions require separate acceptance.
- This repository uses Shopify-hosted App Home. Confirm the supported distribution path and onboarding requirements before distributing the app to customers.

See [SECURITY.md](SECURITY.md) for data handling and reporting. The repository's [Apache 2.0 license](LICENSE) is preserved from its initial GitHub commit.
