import {readFileSync} from 'node:fs';
import {brotliCompressSync, constants} from 'node:zlib';
// Shopify rejects a UI extension whose compiled bundle exceeds 64 KB compressed
// (Brotli quality 11, matching Shopify CLI's bundle measurement).
// Fail the build first, keeping a small margin.
const LIMIT = 64 * 1024, MARGIN = 512;
let failed = false;
for (const handle of ['hotwax-cycle-count', 'app-home']) {
  const bytes = brotliCompressSync(readFileSync(`extensions/${handle}/dist/${handle}.js`), {
    params: {[constants.BROTLI_PARAM_QUALITY]: 11},
  }).length;
  console.log(`${handle}: ${bytes} bytes Brotli-compressed (limit ${LIMIT}, build gate ${LIMIT - MARGIN})`);
  if (bytes > LIMIT - MARGIN) failed = true;
}
if (failed) {console.error('An extension bundle is too close to the 64 KB limit.'); process.exit(1);}
