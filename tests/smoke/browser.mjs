/**
 * Runs the smoke checks in headless Chromium against the built package:
 * serves `dist/` and the smoke module from a local server, loads them as
 * native ES modules, and fails if the page reports an error.
 *
 *   npm run build && node tests/smoke/browser.mjs
 *
 * Needs `playwright` installed (CI adds it without saving it as a dependency).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const page = `<!doctype html><meta charset="utf-8"><script type="module">
  import * as sdk from '/dist/index.js';
  import { smoke } from '/tests/smoke/smoke.mjs';
  smoke(sdk).then((passed) => { window.__smoke = { passed }; }, (error) => { window.__smoke = { error: String(error && error.stack || error) }; });
</script>`;

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html' }).end(page);
    return;
  }
  const file = normalize(join(root, path));
  const allowed = [join(root, 'dist'), join(root, 'tests', 'smoke')].some((dir) => file.startsWith(dir));
  try {
    if (!allowed) throw new Error('outside');
    const body = await readFile(file);
    const type = ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(String(error)));
  await tab.goto(`http://127.0.0.1:${port}/`);
  const result = await tab.waitForFunction(() => window.__smoke, null, { timeout: 30_000 }).then((h) => h.jsonValue());
  if (result.error !== undefined || errors.length > 0) {
    throw new Error(`browser smoke failed:\n${result.error ?? ''}\n${errors.join('\n')}`);
  }
  console.log(`Chromium ${browser.version()}: ${result.passed.length} smoke checks passed`);
  for (const name of result.passed) console.log(`  ✓ ${name}`);
} finally {
  await browser.close();
  server.close();
}
