export function normalizeOmsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Enter a valid HTTPS address for your OMS.'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Use the HTTPS OMS address without a path, credentials, or query parameters.');
  }
  return url.origin;
}

export const READ_OMS_SETTING = `query CycleCountOmsSetting {
  currentAppInstallation {
    id
    omsUrl: metafield(namespace: "hotwax_config", key: "oms_url") { type value compareDigest }
  }
}`;
export const SAVE_OMS_SETTING = `mutation CycleCountOmsSetting($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { namespace key type value }
    userErrors { field message code }
  }
}`;

async function query(document: string, variables = {}) {
  const response = await fetch('shopify:admin/api/2026-07/graphql.json', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query: document, variables}),
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length) throw new Error('Shopify could not load or save the OMS connection. Try again.');
  return result.data;
}

export async function readOmsSetting() {
  const {currentAppInstallation: installation} = await query(READ_OMS_SETTING);
  if (!installation?.id) throw new Error('Shopify could not identify this app installation.');
  if (installation.omsUrl && installation.omsUrl.type !== 'url') throw new Error('The saved OMS setting has an unexpected type.');
  return {ownerId: installation.id, url: installation.omsUrl?.value ?? '', digest: installation.omsUrl?.compareDigest ?? null};
}

export async function saveOmsSetting(setting: Awaited<ReturnType<typeof readOmsSetting>>, input: string) {
  const url = normalizeOmsUrl(input);
  const result = await query(SAVE_OMS_SETTING, {metafields: [{
    ownerId: setting.ownerId, namespace: 'hotwax_config', key: 'oms_url', type: 'url',
    value: url, compareDigest: setting.digest,
  }]});
  if (result.metafieldsSet.userErrors.length) throw new Error('The connection could not be saved. Reload this page to check for another change, then try again.');
  const saved = await readOmsSetting();
  if (saved.ownerId !== setting.ownerId || saved.url !== url) throw new Error('The saved connection could not be verified. Reload before retrying.');
  return saved;
}
