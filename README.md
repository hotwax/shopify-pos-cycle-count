# HotWax Cycle Count for Shopify POS

A native Shopify POS extension for store cycle counting, with a Shopify-hosted App Home for connecting the shop to HotWax OMS. Scans are saved on the POS device, matched to OMS products, grouped into session quantities, and synchronized into HotWax's cycle-count approval workflow.

## Counting flow

- Create a **dynamic**, **directed**, or **hard** count, with optional start and due dates. Dynamic counts include the products staff choose to count; each included product must represent its full store quantity across sessions. Directed counts use a selected scope; hard counts cover the facility scope.
- Use the count summary to review team progress, start a session, or continue an existing session. Product lists show all, uncounted and counted products; directed counts also distinguish extras.
- Count with a connected POS scanner, the camera, an explicitly enabled HID input, or hand counting. Hand counting supports inline quantities and a review step before saving scan events.
- Inspect scan events in fixed newest-first order, filter unmatched scans, retry or correct matching, and undo individual events. Product sorting does not change event chronology.
- Submit each session, resolve remaining uncounted products through counting or reviewed **Mark as out of stock** selection, then submit the count for OMS approval. A bulk zero confirmation uses one session even when its requests span multiple batches.

Submitting a count sends it for review. This app does not approve inventory adjustments.

## Architecture

| Location | Responsibility |
| --- | --- |
| `extensions/hotwax-cycle-count/src` | POS tile, native screens, scanner integration, local journal/checkpoints, terminal leases and background synchronization |
| `extensions/app-home/src` | Shop-level OMS connection setup |
| `shared` | Shopify identity exchange, OMS configuration, API adapters, permissions and count workflows |
| `tests` | Local state, recovery, matching, lease, workflow and configuration regression checks |
| `docs/oms/DynamicCountData.xml` | OMS `DYNAMIC_COUNT` enumeration required when it is not already installed |

An accepted scan is durably appended before aggregation. Shopify POS product lookup supplies display data when available, while OMS matching establishes the HotWax product ID required for aggregation. OMS product details provide a fallback when native lookup misses. Unmatched events remain available for resolution without blocking other products.

The app uses Shopify Storage API documents with paged scan journals and product checkpoints. It does not rely on IndexedDB, a custom Web Worker, or a service worker. Product and event lists render at most 40 rows per page; network writes use bounded batches. Storage remains finite and shared with other extensions: quota exhaustion refuses new writes while preserving existing scans.

Sessions are scoped to shop, facility and staff. Counting requires a confirmed, unexpired lease for the current POS terminal. Failed lock acquisition or renewal blocks further scanner events. Shopify's background target can sync already-matched quantities while its runtime is available; force-quitting POS cannot guarantee background progress.

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

`POS_OMS_LOCAL_PREVIEW=true` enables the existing test-environment write guard and development diagnostics. The guard accepts Test Maarg or the exact Demo Maarg / HotWax Demo pairing defined in the adapter. It does not provision an OMS registration or inject credentials. Keep `.env` local.

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

Build and deploy regenerate `shared/oms-build-config.ts` with development flags disabled. Building alone does not release an app. See [Shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy) for the release command. Stop the development preview before checking an installed release; an already-open POS extension may need POS to be relaunched to load the released bundle.

The initial implementation has been deployed to a demo store and opened on a physical iPad with the local development server stopped. The current local regression suite contains 69 passing tests. Raw device captures, local test readbacks, historical implementation notes and machine-specific tool configuration are deliberately excluded from this repository.

## Customer rollout boundaries

- The app verifies lease ownership/generation before writes. Atomic ownership, expiry and count-completion fencing must also be enforced by OMS to protect against concurrent or legacy clients.
- A PIN-only operator must not inherit the logged-in account's OMS authority. The existing login contract requires matching authenticated identities; broader staff delegation needs corresponding server authorization.
- Customer-scale OMS loading, simultaneous terminals, sustained hardware-scanner throughput, physical network interruption, reboot recovery and customer permissions require separate acceptance.
- This repository uses Shopify-hosted App Home. Confirm the supported distribution path and onboarding requirements before distributing the app to customers.

See [SECURITY.md](SECURITY.md) for data handling and reporting. The repository's [Apache 2.0 license](LICENSE) is preserved from its initial GitHub commit.
