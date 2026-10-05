import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
// Shopify rejects a UI extension whose compiled bundle exceeds 64 KB compressed
// (gzip, as the CLI reports it). Fail the build first, keeping a small margin.
const LIMIT = 64 * 1024, MARGIN = 512;
let failed = false;
for (const handle of ['hotwax-cycle-count', 'app-home']) {
  const bytes = gzipSync(readFileSync(`extensions/${handle}/dist/${handle}.js`)).length;
  console.log(`${handle}: ${bytes} bytes compressed (limit ${LIMIT}, build gate ${LIMIT - MARGIN})`);
  if (bytes > LIMIT - MARGIN) failed = true;
}
if (failed) {console.error('An extension bundle is too close to the 64 KB limit.'); process.exit(1);}
