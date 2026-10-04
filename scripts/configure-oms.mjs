import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

// Only public development flags are embedded. OMS URLs live in Shopify.
// The generated file is gitignored: build/deploy write release flags, dev
// writes preview flags, and tests or typechecks only create it when absent so
// they never change a running dev preview.
const release = process.argv.includes("--release");
if (process.argv.includes("--if-missing") && existsSync(resolve('shared/oms-build-config.ts'))) process.exit(0);
const values = {};
try {
  for (const line of (release ? '' : readFileSync('.env', 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*(POS_OMS_LOCAL_PREVIEW)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const localPreview = !release && (process.env.POS_OMS_LOCAL_PREVIEW || values.POS_OMS_LOCAL_PREVIEW) === 'true';
mkdirSync('shared', {recursive: true});
writeFileSync(resolve('shared/oms-build-config.ts'),
  '// Generated public development flag. No URL or credentials.\n' +
  `export const LOCAL_OMS_PREVIEW = ${JSON.stringify(localPreview)};\n` +
  `export const DEVELOPMENT_PREVIEW = ${JSON.stringify(!release)};\n`);
console.log(`OMS URL source: Shopify app-data metafield; local preview: ${localPreview}`);
