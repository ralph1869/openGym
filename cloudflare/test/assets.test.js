import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = new URL('../dist/', import.meta.url).pathname;
test('the production bundle serves the app, every licensed media asset and notices; API and missing assets stay errors', async t => {
  for (const [dir, ext] of [['still', '.webp'], ['clip', '.mp4']]) {
    const source = new URL(`../../catalogue/media/${dir}/`, import.meta.url), dest = new URL(`../dist/exercise-media/${dir}/`, import.meta.url);
    const files = readdirSync(source).filter(f => f.endsWith(ext));
    assert.equal(files.length, 6554);
    assert.deepEqual(readdirSync(dest).sort(), files.sort());
    const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
    for (const f of files) assert.equal(digest(new URL(f, dest)), digest(new URL(f, source)), 'media changed: ' + f);
  }
  const notices = ['LICENSE', 'NOTICE.md', 'catalogue/sources/exercises-dataset-zh-cn/LICENSE',
    'catalogue/sources/exercises-dataset-zh-cn/README.md', 'catalogue/sources/exercises-dataset-zh-cn/source.json'];
  for (const f of notices) assert.equal(readFileSync(new URL('../dist/' + f, import.meta.url), 'utf8'), readFileSync(new URL('../../' + f, import.meta.url), 'utf8'));
  assert.equal(readFileSync(new URL('../dist/exercise-media/NOTICE.md', import.meta.url), 'utf8'), readFileSync(new URL('../../catalogue/media/NOTICE.md', import.meta.url), 'utf8'));
  const bundle = await build({ entryPoints: [new URL('../src/worker.js', import.meta.url).pathname], bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', write: false });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'assets-test', log: new Log(LogLevel.ERROR), script: bundle.outputFiles[0].text,
    modules: true, compatibilityDate: '2026-10-14', d1Databases: { DB: 'assets-test' },
    bindings: { ORIGIN: 'https://gym.example' },
    assets: { directory: out, binding: 'ASSETS', run_worker_first: JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).assets.run_worker_first, routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' } }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE users(slot INTEGER PRIMARY KEY, id TEXT, name TEXT, session_version INTEGER)').run();
  const request = (p, headers = {}) => mf.dispatchFetch('https://gym.example' + p, { headers });
  for (const p of ['/', '/settings/account']) {
    const r = await request(p, { Accept: 'text/html' }); const html = await r.text();
    assert.equal(r.status, 200, p + ': ' + html.slice(0, 200));
    assert.match(html, /<div id="root">/);
  }
  for (const p of ['/exercise-media/still/0025.webp', '/exercise-media/clip/0025.mp4', '/LICENSE', '/NOTICE.md', '/exercise-media/NOTICE.md', '/sw.js', ...notices.map(f => '/' + f)]) {
    const r = await request(p); assert.equal(r.status, 200, p); assert.ok((await r.arrayBuffer()).byteLength > 10);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const p of ['/exercise-media/still/does-not-exist.webp', '/assets/missing.js']) assert.equal((await request(p, { Accept: 'text/html' })).status, 404);
  const api = await request('/api/data', { Accept: 'text/html' }); assert.equal(api.status, 401); assert.match(api.headers.get('content-type'), /application\/json/);
  assert.equal((await request('/api/missing', { Accept: 'text/html' })).status, 404);
  for (const path of ['/mcp', '/oauth/authorize', '/.well-known/oauth-authorization-server']) {
    const r = await request(path, { Accept: 'text/html' });
    assert.equal(r.status, 404); assert.match(r.headers.get('content-type'), /application\/json/);
  }
});

test('Git deploys preserve Dashboard-owned MCP variables without explicit default overrides', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.keep_vars, true);
  assert.equal(Object.hasOwn(config.vars, 'MCP_ENABLED'), false);
  assert.equal(Object.hasOwn(config.vars, 'MCP_REDIRECT_URIS'), false);
});
