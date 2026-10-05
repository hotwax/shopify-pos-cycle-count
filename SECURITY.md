# Security and data handling

This is a HotWax app. Report issues through the existing HotWax engineering support channel; do not include credentials, Shopify session tokens, or customer data in public issues.

- Shopify session tokens are exchanged with the configured HTTPS OMS in memory. The resulting OMS token is reused in memory for up to four minutes per shop, location and signed-in user, and is dropped when OMS rejects it. It is never written to storage. App secrets remain in the OMS app registration.
- The app-data metafield contains only the OMS origin and belongs to this app installation.
- Every online count operation checks authenticated staff identity, OMS permissions, shop, facility, session status and, for writes, this terminal's lease. These checks run in the POS extension, which calls OMS directly; the OMS remains responsible for enforcing its API authorization.
- Count submission uses the existing review workflow. This app does not call inventory adjustment or approval APIs.
- Local storage is scoped by shop, facility and staff. It contains scan history, product quantities, Shopify variant to HotWax product pairs and the shop's OMS origin (so background sync can run without Admin API access). It never contains credentials, and product names and images are kept in memory only. Local storage is not an archival backup; finish and sync counts promptly.
- A permission or staff change requires online verification before a different operator can use the count. Online, scanning requires this terminal's confirmed, unexpired session lease, and an OMS ownership rejection blocks further scans. Offline, only the lease OMS last confirmed for this terminal allows local scans, and every sync renews that exact lease before writing. Saved scans remain on the device. Product matching and submission require a connection.
- Do not log request headers, raw authentication responses, or session tokens. API errors identify the operation and HTTP status only.

The app has been released and exercised in a demo store. Customer rollout and a formal security review remain separate acceptance steps. The app checks lease ownership before writes; the OMS must enforce ownership, expiry and count transitions atomically to protect against concurrent or legacy clients.
