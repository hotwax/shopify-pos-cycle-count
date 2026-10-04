import {OmsLookupError} from './oms-connection';

export const OMS_CONFIGURATION_QUERY = `query PosOmsConfiguration {
  currentAppInstallation {
    omsUrl: metafield(namespace: "hotwax_config", key: "oms_url") { type value }
  }
}`;

/** Read the current shop's configuration under this app's own identity. */
export async function getShopOmsUrl(signal?: AbortSignal, localPreview = false): Promise<string> {
  const response = await fetch('shopify:admin/api/2026-07/graphql.json', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query: OMS_CONFIGURATION_QUERY}), signal,
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length) {
    throw new OmsLookupError('Shopify could not load the OMS connection settings. Reopen this extension.', 503);
  }
  const setting = result.data?.currentAppInstallation?.omsUrl;
  if (!setting || setting.type !== 'url' || typeof setting.value !== 'string') {
    throw new OmsLookupError('This shop has no OMS URL configured for this app. Complete HotWax setup first.', 503);
  }
  let url: URL;
  try { url = new URL(setting.value); }
  catch { throw new OmsLookupError('The shop’s OMS URL is invalid. Update HotWax setup.', 503); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new OmsLookupError('The shop’s OMS URL must be an HTTPS origin without credentials or a path.', 503);
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      (!localPreview && url.hostname.endsWith('.trycloudflare.com'))) {
    throw new OmsLookupError('This app requires a hosted OMS URL. Local tunnels are only allowed in a development preview.', 503);
  }
  return url.origin;
}
