import {Signal} from '@preact/signals-core';
// What `@shopify/ui-extensions/preact` does, without @preact/signals' JSX
// auto-tracking: this extension reads POS signals through explicit
// subscriptions, and the integration would cost about 3 KB of the 64 KB
// bundle limit. POS host values become the same Signal class either way.
const host = /** @type {any} */ (globalThis).shopify;
if (typeof host?.setSignals === 'function') host.setSignals(Signal);
