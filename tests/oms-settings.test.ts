import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeOmsUrl, readOmsSetting, saveOmsSetting} from '../shared/oms-settings';

test('OMS setting accepts a bare HTTPS origin and rejects credentials and paths', () => {
  assert.equal(normalizeOmsUrl(' https://demo-maarg.hotwax.io/ '), 'https://demo-maarg.hotwax.io');
  for (const value of ['http://demo-maarg.hotwax.io', 'https://user:password@example.com', 'https://example.com/rest', 'https://example.com?token=value', 'https://localhost']) {
    assert.throws(() => normalizeOmsUrl(value));
  }
});

// Shopify transport fixture only; the actual app-owned metafield is also read back on the demo shop.
test('save uses the current installation and compare digest, then verifies readback', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  let value: string | null = null;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.variables.metafields) {
      value = body.variables.metafields[0].value;
      return Response.json({data: {metafieldsSet: {userErrors: []}}});
    }
    return Response.json({data: {currentAppInstallation: {id: 'gid://shopify/AppInstallation/1',
      omsUrl: value ? {type: 'url', value, compareDigest: 'saved-digest'} : null}}});
  };
  try {
    const setting = await readOmsSetting();
    const saved = await saveOmsSetting(setting, 'https://demo-maarg.hotwax.io');
    assert.deepEqual(requests[1].variables.metafields, [{ownerId: setting.ownerId,
      namespace: 'hotwax_config', key: 'oms_url', type: 'url', value: saved.url, compareDigest: null}]);
    assert.equal(saved.digest, 'saved-digest');
    assert.equal(requests.length, 3);
  } finally {globalThis.fetch = original;}
});
