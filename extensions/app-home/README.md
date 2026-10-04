# HotWax Cycle Count App Home

`src/AppHome.jsx` renders the shop's OMS connection form at `admin.app.home.render` using Shopify App Home web components.

The form reads and saves the current app installation's `hotwax_config.oms_url` metafield through Shopify direct API access. `shared/oms-settings.ts` validates a bare HTTPS origin, uses compare-and-set protection, and verifies the saved value. App secrets and access tokens do not belong in this setting.

Run development, validation and deployment commands from the repository root; see the [setup instructions](../../README.md). Shopify hosts this extension as part of the app version. See the [App Home UI extension guide](https://shopify.dev/docs/apps/build/app-home/app-home-ui-extensions) for supported distribution and platform requirements.
