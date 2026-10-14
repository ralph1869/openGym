import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../src/crypto.js';
import { splitText, CHUNK_CHARS } from '../src/state.js';
import { authenticator } from './passkey-fixture.js';

const ORIGIN = 'https://gym.example', INVITE = 'SYNTHETIC-TEST-INVITE';
const schema = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
let script;
before(async () => {
  const b = await build({ entryPoints: [new URL('../src/worker.js', import.meta.url).pathname], bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', write: false });
  script = b.outputFiles[0].text;
});
async function setup(t, bindings = {}) {
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [{ name: 'opengym-test',
    script, modules: true, compatibilityDate: '2026-10-14', d1Databases: { DB: 'opengym-test' },
    bindings: { ORIGIN, RP_ID: 'gym.example', REGISTRATION_TOKEN_SHA256: await sha256(INVITE), ...bindings } }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const r = await mf.dispatchFetch(ORIGIN + path, { method,
      headers: { ...(body != null ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body != null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json(), headers: r.headers };
  };
  const registerOptions = () => request('/api/register/options', { method: 'POST', body: { name: 'Synthetic owner', code: INVITE } });
  const verify = (options, a, extra = {}) => request('/api/register/verify', { method: 'POST', body: {
    cid: options.data.cid, credential: a.register(options.data.options, ORIGIN, extra) } });
  const register = async () => {
    const a = authenticator(), opts = await registerOptions(); assert.equal(opts.status, 200);
    const r = await verify(opts, a); assert.equal(r.status, 200, JSON.stringify(r.data));
    return { a, cookie: r.headers.get('set-cookie').split(';')[0], user: r.data.user };
  };
  const login = async a => {
    const opts = await request('/api/login/options', { method: 'POST', body: {} });
    const r = await request('/api/login/verify', { method: 'POST', body: { cid: opts.data.cid, credential: a.login(opts.data.options, ORIGIN) } });
    assert.equal(r.status, 200, JSON.stringify(r.data)); return r.headers.get('set-cookie').split(';')[0];
  };
  return { mf, db, request, registerOptions, verify, register, login };
}
const state = label => ({ workouts: [], routines: [{ id: 'r', name: label }], bodyweight: [], unit: 'kg', _ts: Date.now(), active: { secret: 'device-only' } });
const put = (h, cookie, st, rev = 0, wid) => h.request('/api/data', { method: 'PUT', cookie,
  body: { state: st, baseRev: rev, ...(wid != null ? { baseWid: wid } : {}), stamped: true } });

test('public config, private data and unsupported APIs protect anonymous callers', async t => {
  const h = await setup(t), cfg = await h.request('/api/config');
  assert.equal(cfg.status, 200); assert.equal(cfg.data.allow_guest, false); assert.equal(cfg.data.registration_open, true);
  assert.equal(cfg.data.capabilities.media_upload, false);
  for (const p of ['/api/me', '/api/data', '/api/data/rev', '/api/media/a', '/api/admin/users']) assert.equal((await h.request(p)).status, 401);
  assert.equal((await h.request('/api/no-such-route')).status, 404);
});
test('no configured invite closes signup instead of permitting a public first account', async t => {
  const h = await setup(t, { REGISTRATION_TOKEN_SHA256: '' });
  assert.equal((await h.request('/api/config')).data.registration_open, false);
  assert.equal((await h.registerOptions()).status, 403);
});
test('another Worker hostname cannot share account APIs or create challenges', async t => {
  const h = await setup(t), { cookie } = await h.register();
  const staleHost = 'https://old-gym.example';
  for (const path of ['/api/health', '/api/config', '/api/me', '/api/data']) {
    const r = await h.mf.dispatchFetch(staleHost + path, { headers: { Cookie: cookie } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'wrong-origin');
  }
  for (const path of ['/api/login/options', '/api/register/options', '/api/login/verify']) {
    const r = await h.mf.dispatchFetch(staleHost + path, { method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'wrong-origin');
  }
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM challenges').first()).n, 0);
  assert.equal((await h.request('/api/me', { cookie })).status, 200);
});
test('bad invite, registration UV and wrong WebAuthn origin are refused', async t => {
  const h = await setup(t), a = authenticator();
  assert.equal((await h.request('/api/register/options', { method: 'POST', body: { name: 'x', code: 'WRONG' } })).status, 403);
  let opts = await h.registerOptions(); assert.equal((await h.verify(opts, a, { uv: false })).status, 400);
  opts = await h.registerOptions();
  assert.equal((await h.request('/api/register/verify', { method: 'POST', body: { cid: opts.data.cid, credential: a.register(opts.data.options, 'https://evil.example') } })).status, 400);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 0);
});
test('synthetic registration, login, challenge replay and cross-ceremony attacks', async t => {
  const h = await setup(t), { a, cookie } = await h.register();
  assert.equal((await h.request('/api/me', { cookie })).status, 200);
  const options = await h.request('/api/login/options', { method: 'POST', body: {} });
  const payload = { cid: options.data.cid, credential: a.login(options.data.options, ORIGIN) };
  assert.equal((await h.request('/api/register/verify', { method: 'POST', body: payload })).status, 400);
  assert.equal((await h.request('/api/login/verify', { method: 'POST', body: payload })).status, 200);
  assert.equal((await h.request('/api/login/verify', { method: 'POST', body: payload })).status, 400);
  assert.equal((await h.request('/api/config')).data.registration_open, false);
  assert.equal((await h.registerOptions()).status, 403);
});
test('two simultaneous valid registrations create only one owner, credential and session', async t => {
  const h = await setup(t), [x, y] = await Promise.all([h.registerOptions(), h.registerOptions()]);
  const result = await Promise.all([h.verify(x, authenticator()), h.verify(y, authenticator())]);
  assert.equal(result.filter(r => r.status === 200).length, 1);
  assert.ok(result.some(r => [403, 409].includes(r.status)));
  for (const table of ['users', 'credentials', 'sessions']) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 1);
});
test('sessions are hashed, secure, expirable and revoked on logout/all', async t => {
  const h = await setup(t), { a, cookie } = await h.register();
  const stored = await h.db.prepare('SELECT hash FROM sessions').first();
  assert.notEqual(stored.hash, cookie.split('=')[1]); assert.match(stored.hash, /^[a-f0-9]{64}$/);
  assert.match(cookie, /^__Host-gymsid=/);
  const second = await h.login(a);
  assert.equal((await h.request('/api/logout', { method: 'POST', body: {}, cookie })).status, 200);
  assert.equal((await h.request('/api/me', { cookie })).status, 401);
  assert.equal((await h.request('/api/me', { cookie: second })).status, 200);
  const third = await h.login(a);
  assert.equal((await h.request('/api/logout/all', { method: 'POST', body: {}, cookie: second })).status, 200);
  assert.equal((await h.request('/api/me', { cookie: third })).status, 401);
  const fresh = await h.login(a);
  await h.db.prepare('UPDATE sessions SET expires=0').run();
  assert.equal((await h.request('/api/me', { cookie: fresh })).status, 401);
});
test('login requires UV, rejects invalid signatures, expires challenges and ambiguous cookies', async t => {
  const h = await setup(t), { a, cookie } = await h.register();
  let opts = await h.request('/api/login/options', { method: 'POST', body: {} });
  assert.equal((await h.request('/api/login/verify', { method: 'POST', body: { cid: opts.data.cid, credential: a.login(opts.data.options, ORIGIN, { uv: false }) } })).status, 400);
  opts = await h.request('/api/login/options', { method: 'POST', body: {} });
  const signed = a.login(opts.data.options, ORIGIN); signed.response.signature = 'AAAA';
  assert.equal((await h.request('/api/login/verify', { method: 'POST', body: { cid: opts.data.cid, credential: signed } })).status, 400);
  opts = await h.request('/api/login/options', { method: 'POST', body: {} });
  await h.db.prepare('UPDATE challenges SET expires=0').run();
  assert.equal((await h.request('/api/login/verify', { method: 'POST', body: { cid: opts.data.cid, credential: a.login(opts.data.options, ORIGIN) } })).status, 400);
  assert.equal((await h.request('/api/me', { cookie: cookie + '; __Host-gymsid=' + 'x'.repeat(43) })).status, 401);
});
test('CSRF and content-type guards include login and signup', async t => {
  const h = await setup(t), { cookie } = await h.register();
  for (const path of ['/api/logout', '/api/login/options', '/api/register/options']) {
    assert.equal((await h.request(path, { method: 'POST', cookie, body: {}, headers: { Origin: 'https://sibling.example' } })).status, 403);
    assert.equal((await h.request(path, { method: 'POST', cookie, body: {}, headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await h.request(path, { method: 'POST', cookie, body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  }
  assert.equal((await h.request('/api/login/options', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await h.request('/api/me', { cookie })).status, 200);
});
test('auth attempts are limited persistently in D1', async t => {
  const h = await setup(t);
  for (let i = 0; i < 60; i++) assert.equal((await h.request('/api/login/options', { method: 'POST', body: {} })).status, 200);
  const r = await h.request('/api/login/options', { method: 'POST', body: {} });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '300');
});
test('5 MiB-safe chunking preserves emoji across boundaries', () => {
  const text = 'x'.repeat(CHUNK_CHARS - 1) + '🏋️中文' + 'x'.repeat(CHUNK_CHARS);
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.equal(chunks.map(c => Buffer.from(c).toString()).join(''), text);
  assert.ok(chunks.every(c => Buffer.byteLength(c) < 2000000));
});
test('state larger than D1 single-row limit roundtrips, with a separate session on another device', async t => {
  const h = await setup(t), { a, cookie } = await h.register(), second = await h.login(a);
  const st = state('large'); st.exNotes = { synthetic: '中文🏋️'.repeat(210000) };
  const r = await put(h, cookie, st); assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = await h.request('/api/data', { cookie: second });
  assert.equal(got.data.state.exNotes.synthetic, st.exNotes.synthetic);
  assert.equal(got.data.state.active, undefined); assert.equal(got.data.state._prior, undefined);
  assert.equal(got.data.state._rev, r.data.rev); assert.equal(got.data.state._wid, r.data.wid);
  const sizes = await h.db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM state_chunks').all();
  assert.ok(sizes.results.length > 1); assert.ok(sizes.results.every(r => r.bytes < 2000000));
  assert.equal((await h.request('/api/data/rev', { cookie })).data.wid, r.data.wid);
});
test('atomic revision/write-id races permit exactly one winner and return latest state in 409', async t => {
  const h = await setup(t), { cookie } = await h.register();
  const first = await put(h, cookie, state('first'));
  const result = await Promise.all(['left', 'right'].map(label => put(h, cookie, state(label), first.data.rev, first.data.wid)));
  assert.deepEqual(result.map(r => r.status).sort(), [200, 409]);
  const got = await h.request('/api/data', { cookie });
  assert.equal(got.data.rev, first.data.rev + 1);
  assert.equal(result.find(r => r.status === 409).data.state._wid, got.data.state._wid);
  assert.equal((await put(h, cookie, state('rewound'), got.data.rev, 'wrong-write-id')).status, 409);
  const retry = await put(h, cookie, state('merged'), got.data.rev, got.data.state._wid);
  assert.equal(retry.status, 200);
});
test('first-state race is atomic and previous chunks are removed only by a successful writer', async t => {
  const h = await setup(t), { cookie } = await h.register();
  const results = await Promise.all([put(h, cookie, state('a')), put(h, cookie, state('b'))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const got = await h.request('/api/data', { cookie });
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM states').first()).n, 1);
  assert.equal((await h.db.prepare('SELECT COUNT(DISTINCT wid) AS n FROM state_chunks').first()).n, 1);
  assert.equal((await put(h, cookie, state('stale'))).status, 409);
  assert.deepEqual((await h.request('/api/data', { cookie })).data, got.data);
});
test('D1 transaction failure rolls back manifest and every chunk; retry still succeeds', async t => {
  const h = await setup(t), { cookie } = await h.register();
  const first = await put(h, cookie, state('safe')), before = await h.request('/api/data', { cookie });
  await h.db.prepare(`CREATE TRIGGER fail_chunk BEFORE INSERT ON state_chunks WHEN NEW.n=1 BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END`).run();
  const large = state('must-not-land'); large.exNotes = { synthetic: 'x'.repeat(700000) };
  assert.equal((await put(h, cookie, large, first.data.rev, first.data.wid)).status, 503);
  assert.deepEqual((await h.request('/api/data', { cookie })).data, before.data);
  await h.db.prepare('DROP TRIGGER fail_chunk').run();
  assert.equal((await put(h, cookie, large, first.data.rev, first.data.wid)).status, 200);
});
test('missing chunk, hash mismatch and malformed manifest fail closed on GET/rev/PUT', async t => {
  for (const damage of ['missing', 'hash', 'manifest']) {
    const h = await setup(t), { cookie } = await h.register();
    const first = await put(h, cookie, state('do-not-replace'));
    if (damage === 'missing') await h.db.prepare('DELETE FROM state_chunks').run();
    if (damage === 'hash') await h.db.prepare("UPDATE state_chunks SET data=replace(data,'do-not-replace','cannot-restore')").run();
    if (damage === 'manifest') await h.db.prepare("UPDATE states SET sha256='bad'").run();
    for (const path of ['/api/data', '/api/data/rev']) {
      const r = await h.request(path, { cookie }); assert.equal(r.status, 503); assert.equal(r.data.code, 'state-unreadable'); assert.equal(r.data.state, undefined);
    }
    assert.equal((await put(h, cookie, state('empty'), first.data.rev, first.data.wid)).status, 503);
    assert.equal((await h.db.prepare('SELECT rev FROM states').first()).rev, first.data.rev);
  }
});
test('invalid documents and oversized writes preserve previous state', async t => {
  const h = await setup(t), { cookie } = await h.register(), first = await put(h, cookie, state('safe'));
  for (const st of [{}, [], { workouts: 'wrong' }, { _rev: 3 }]) assert.equal((await put(h, cookie, st, first.data.rev)).status, 400);
  const large = state('too-big'); large.exNotes = { synthetic: 'x'.repeat(6 * 1024 * 1024) };
  assert.equal((await put(h, cookie, large, first.data.rev)).status, 413);
  assert.equal((await h.request('/api/data', { cookie })).data.state.routines[0].name, 'safe');
});
test('unsupported authenticated APIs return an explicit failure, with no fake success', async t => {
  const h = await setup(t), { cookie } = await h.register();
  for (const path of ['/api/media/missing', '/api/push/subscribe', '/api/coach/jobs', '/api/admin/users', '/api/account/passkeys', '/api/pair/options']) {
    const r = await h.request(path, { method: 'POST', body: {}, cookie }); assert.equal(r.status, 501); assert.equal(r.data.code, 'unsupported');
  }
});
