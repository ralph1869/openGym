import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authenticator } from './passkey-fixture.js';
import { sha256 } from '../src/crypto.js';
import { callTrainingTool } from '../src/mcp.js';
const ORIGIN = 'https://gym.example', REDIRECT = 'https://client.example/callback';
const INVITE = 'SYNTHETIC-MCP-FIXTURE', VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
let script;
before(async () => { script = (await build({ entryPoints: [new URL('../src/worker.js', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false })).outputFiles[0].text; });
async function setup(t, enabled = true, multiuser = false) {
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [{ name: 'mcp-fixture', script, modules: true, compatibilityDate: '2026-10-14', d1Databases: { DB: 'mcp-fixture' },
    bindings: { ORIGIN, RP_ID: 'gym.example', MCP_ENABLED: String(enabled), MCP_REDIRECT_URIS: JSON.stringify([REDIRECT]), REGISTRATION_TOKEN_SHA256: await sha256(INVITE) } }] }));
  t.after(() => mf.dispose()); const db = await mf.getD1Database('DB');
  let schema = ['0001_initial.sql', '0002_mcp_oauth.sql'].map(n => readFileSync(new URL('../migrations/' + n, import.meta.url), 'utf8')).join('\n');
  if (multiuser) schema = schema.replace('CHECK (slot = 1)', 'CHECK (slot IN (1,2))');
  await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  async function request(path, { method = 'GET', body, form, cookie, token, headers = {} } = {}) {
    const r = await mf.dispatchFetch(ORIGIN + path, { method,
      headers: { ...(body != null ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      ...((body != null || form) ? { body: form ? new URLSearchParams(form).toString() : JSON.stringify(body) } : {}) });
    const content = await r.text(); let data; try { data = JSON.parse(content); } catch { data = content; }
    return { status: r.status, headers: r.headers, data };
  }
  const a = authenticator();
  const options = await request('/api/register/options', { method: 'POST', body: { name: 'Synthetic owner', code: INVITE } });
  const owner = await request('/api/register/verify', { method: 'POST', body: { cid: options.data.cid, credential: a.register(options.data.options, ORIGIN) } });
  assert.equal(owner.status, 200); const cookie = owner.headers.get('set-cookie').split(';')[0], uid = owner.data.user.id;
  async function connection(scope = 'workouts:read workouts:create workouts:update', exchange = true) {
    const registered = await request('/oauth/register', { method: 'POST', body: { client_name: 'Synthetic client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', scope } });
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    const authorization = { client_id: registered.data.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: ORIGIN + '/mcp', scope, state: 'synthetic-client-csrf-state' };
    const opts = await request('/oauth/consent/options', { method: 'POST', cookie, body: { authorization, approved_scope: scope } }); assert.equal(opts.status, 200);
    const approved = await request('/oauth/consent/verify', { method: 'POST', cookie, body: { cid: opts.data.cid, credential: a.login(opts.data.options, ORIGIN) } }); assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const redirect = new URL(approved.data.redirect_url); assert.equal(redirect.searchParams.get('state'), authorization.state); assert.equal(redirect.searchParams.get('iss'), ORIGIN);
    const form = { grant_type: 'authorization_code', client_id: authorization.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER, code: redirect.searchParams.get('code'), resource: ORIGIN + '/mcp' };
    const response = exchange ? await request('/oauth/token', { method: 'POST', form }) : null;
    if (response) assert.equal(response.status, 200, JSON.stringify(response.data));
    return { ...response?.data, form, authorization, opts, approved, client_id: authorization.client_id };
  }
  let rpcId = 0;
  const rpc = (name, args = {}, token, extra = {}) => request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, token, ...extra });
  const value = async (name, args, token) => {
    const r = await rpc(name, args, token); assert.equal(r.status, 200); assert.ok(!r.data.result?.isError, JSON.stringify(r.data)); return r.data.result.structuredContent;
  };
  const appState = async () => (await request('/api/data', { cookie })).data.state;
  const seed = async state => { const r = await request('/api/data', { method: 'PUT', cookie, body: { state, baseRev: 0, stamped: true } }); assert.equal(r.status, 200); return appState(); };
  return { mf, db, request, a, cookie, uid, connection, rpc, value, appState, seed };
}
const workout = (name = 'Synthetic bench session') => ({ name, date: '2025-10-15', started_at: '2025-10-15T18:00:00+08:00', time_zone: 'Asia/Shanghai', duration_minutes: 45, unit: 'kg',
  entries: [{ exercise_id: '0025', mode: 'reps', load_basis: 'app_display', sets: [{ weight: 60, reps: 8 }, { weight: 60, reps: 8, rir: 2 }] }] });
const oldState = () => ({ unit: 'kg', workouts: [{ id: 'legacy-session', d: '2025-01-01', start: 1735725600000, end: 1735729200000, name: 'Untouched session', prs: [], entries: [{ id: '0025', target: { mode: 'reps' }, sets: [{ w: 40, r: 5, done: true }], topW: 40 }], media: [{ id: 'fixture-media' }], note: 'keep this' }], routines: [{ id: 'routine', name: 'Untouched routine', ex: [] }], bodyweight: [{ d: '2025-01-01', w: 80 }], exWeights: { '0025': { w: 40, d: '2025-01-01' } }, customEx: [], week: { '1': ['routine'] }, unknownSetting: { retained: true }, _ts: 1 });

test('MCP/OAuth remain closed unless explicitly enabled; existing Passkey session works', async t => {
  const h = await setup(t, false);
  for (const path of ['/mcp', '/oauth/authorize', '/.well-known/oauth-protected-resource/mcp', '/api/integrations']) assert.equal((await h.request(path)).status, 404);
  assert.equal((await h.request('/api/config')).data.capabilities.mcp, false);
  assert.equal((await h.request('/api/me', { cookie: h.cookie })).status, 200);
});
test('discovery, public tool metadata, HTTP validation and OAuth challenge are interoperable', async t => {
  const h = await setup(t);
  const as = await h.request('/.well-known/oauth-authorization-server'); assert.deepEqual(as.data.code_challenge_methods_supported, ['S256']); assert.equal(as.data.token_endpoint_auth_methods_supported[0], 'none');
  const resource = await h.request('/.well-known/oauth-protected-resource/mcp'); assert.equal(resource.data.resource, ORIGIN + '/mcp');
  const tools = await h.request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 0, method: 'tools/list' } });
  assert.equal(tools.data.result.tools.length, 7); assert.equal(tools.data.result.tools.find(t => t.name === 'log_workout').annotations.readOnlyHint, false);
  assert.equal(tools.data.result.tools.find(t => t.name === 'update_workout').annotations.destructiveHint, true);
  assert.equal(tools.data.result.tools[0].securitySchemes[0].type, 'oauth2');
  const unauth = await h.rpc('get_training_context', {}, null, { cookie: h.cookie }); assert.equal(unauth.status, 401); assert.match(unauth.headers.get('WWW-Authenticate'), /resource_metadata=/); assert.ok(unauth.data.result._meta['mcp/www_authenticate']);
  assert.equal((await h.request('/mcp')).status, 405);
  assert.equal((await h.request('/mcp', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal((await h.request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'log_workout' } } })).status, 400);
});
test('OAuth rejects unapproved redirects, wildcard/prefix tricks, unknown scopes and non-PKCE grants', async t => {
  const h = await setup(t);
  for (const redirects of [[REDIRECT + '/evil'], ['http://client.example/callback'], ['https://client.example/../callback'], ['https://evil.example/callback']]) assert.equal((await h.request('/oauth/register', { method: 'POST', body: { client_name: 'x', redirect_uris: redirects } })).status, 400);
  assert.equal((await h.request('/oauth/register', { method: 'POST', body: { client_name: 'x', redirect_uris: [REDIRECT], scope: 'admin workouts:read' } })).status, 400);
  const c = await h.connection('workouts:read', false);
  for (const patch of [{ code_challenge_method: 'plain' }, { resource: 'https://evil.example/mcp' }, { redirect_uri: REDIRECT + '?extra=1' }, { state: '' }]) assert.equal((await h.request('/oauth/authorize?' + new URLSearchParams({ ...c.authorization, ...patch }))).status, 400);
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: { client_id: c.client_id, grant_type: 'client_credentials' } })).data.error, 'unsupported_grant_type');
});
test('consent requires a live owner session and fresh UV Passkey proof, and cannot be replayed', async t => {
  const h = await setup(t), c = await h.connection('workouts:read', false);
  const noSession = await h.request('/oauth/authorize?' + new URLSearchParams(c.authorization)); assert.equal(noSession.status, 401); assert.match(noSession.data, /先验证/);
  const page = await h.request('/oauth/authorize?' + new URLSearchParams(c.authorization), { cookie: h.cookie }); assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/); assert.match(page.data, /最多 7 天/);
  assert.equal((await h.request('/oauth/consent/options', { method: 'POST', body: { authorization: c.authorization } })).status, 401);
  let opts = await h.request('/oauth/consent/options', { method: 'POST', cookie: h.cookie, body: { authorization: c.authorization } });
  assert.equal((await h.request('/oauth/consent/verify', { method: 'POST', cookie: h.cookie, body: { cid: opts.data.cid, credential: h.a.login(opts.data.options, ORIGIN, { uv: false }) } })).status, 403);
  opts = await h.request('/oauth/consent/options', { method: 'POST', cookie: h.cookie, body: { authorization: c.authorization } });
  const credential = h.a.login(opts.data.options, ORIGIN), body = { cid: opts.data.cid, credential };
  assert.equal((await h.request('/oauth/consent/verify', { method: 'POST', cookie: h.cookie, body })).status, 200);
  assert.equal((await h.request('/oauth/consent/verify', { method: 'POST', cookie: h.cookie, body })).status, 400);
});
test('PKCE, exact redirect, audience, one-time code and hashed token persistence', async t => {
  const h = await setup(t), c = await h.connection('workouts:read', false);
  for (const patch of [{ code_verifier: 'x'.repeat(64) }, { redirect_uri: REDIRECT + '?x=1' }, { resource: 'https://evil.example/mcp' }]) assert.equal((await h.request('/oauth/token', { method: 'POST', form: { ...c.form, ...patch } })).status, 400);
  const tokens = await h.request('/oauth/token', { method: 'POST', form: c.form }); assert.equal(tokens.status, 200);
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: c.form })).status, 400);
  for (const [table, raw] of [['oauth_codes', c.form.code], ['oauth_access', tokens.data.access_token], ['oauth_refresh', tokens.data.refresh_token]]) {
    const row = await h.db.prepare(`SELECT hash FROM ${table}`).first(); assert.match(row.hash, /^[a-f0-9]{64}$/); assert.notEqual(row.hash, raw);
  }
});
test('official MCP SDK can initialize, list tools, append, query and close against the actual D1 Worker', async t => {
  const h = await setup(t), c = await h.connection();
  const sdk = new Client({ name: 'synthetic-dot-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(ORIGIN + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + c.access_token } }, fetch: async (url, init) => {
    const r = new Request(url, init);
    return h.mf.dispatchFetch(r.url, { method: r.method, headers: Object.fromEntries(r.headers), ...(!['GET', 'HEAD'].includes(r.method) ? { body: await r.text() } : {}) });
  } });
  await sdk.connect(transport); const listed = await sdk.listTools(); assert.equal(listed.tools.length, 7);
  const context = (await sdk.callTool({ name: 'get_training_context', arguments: {} })).structuredContent;
  const saved = await sdk.callTool({ name: 'log_workout', arguments: { request_id: 'sdk-fixture-0001', cursor: context.cursor, workout: workout() } }); assert.ok(!saved.isError, JSON.stringify(saved));
  const queried = await sdk.callTool({ name: 'list_workouts', arguments: {} }); assert.equal(queried.structuredContent.workouts.length, 1);
  const app = await h.appState(); assert.equal(app.workouts[0].id, saved.structuredContent.workout_id); assert.equal(app.workouts[0].entries[0].sets[0].w, 60);
  await sdk.close();
});
test('append preserves all existing training/settings and retries commit only once', async t => {
  const h = await setup(t), baseline = await h.seed(oldState()), c = await h.connection(), token = c.access_token;
  const context = await h.value('get_training_context', {}, token), args = { request_id: 'append-fixture-01', cursor: context.cursor, workout: workout() };
  const first = await h.value('log_workout', args, token), again = await h.value('log_workout', args, token); assert.equal(again.replayed, true); assert.deepEqual(first.cursor, again.cursor);
  const stored = await h.appState(); assert.equal(stored.workouts.length, 2);
  for (const key of ['bodyweight', 'routines', 'week', 'exWeights', 'unknownSetting']) assert.deepEqual(stored[key], baseline[key]);
  assert.deepEqual(stored.workouts[0], baseline.workouts[0]); assert.equal(stored.workouts[1].d, '2025-10-15'); assert.deepEqual(stored.workouts[1].prs, []);
  const conflict = await h.rpc('log_workout', { ...args, workout: workout('different intent') }, token); assert.equal(conflict.data.result.structuredContent.code, 'idempotency-conflict');
  assert.equal((await h.value('get_write_result', { request_id: args.request_id }, token)).status, 'committed');
});
test('two identical concurrent requests cannot duplicate training; receipt is durable D1 metadata', async t => {
  const h = await setup(t), c = await h.connection(), context = await h.value('get_training_context', {}, c.access_token);
  const args = { request_id: 'concurrent-identical', cursor: context.cursor, workout: workout() };
  const results = await Promise.all([h.rpc('log_workout', args, c.access_token), h.rpc('log_workout', args, c.access_token)]);
  assert.ok(results.some(r => !r.data.result.isError)); assert.equal((await h.appState()).workouts.length, 1);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').first()).n, 1);
  assert.equal((await h.value('log_workout', args, c.access_token)).replayed, true);
});
test('web UI and MCP competing revisions yield one winner and preserve old records', async t => {
  const h = await setup(t); await h.seed(oldState()); const c = await h.connection(), context = await h.value('get_training_context', {}, c.access_token), current = await h.appState();
  const browser = structuredClone(current); browser.workouts.push({ ...browser.workouts[0], id: 'browser-new' });
  const [a, b] = await Promise.all([
    h.rpc('log_workout', { request_id: 'web-race-fixture', cursor: context.cursor, workout: workout() }, c.access_token),
    h.request('/api/data', { method: 'PUT', cookie: h.cookie, body: { state: browser, baseRev: context.cursor.rev, baseWid: context.cursor.wid, stamped: true } })
  ]);
  assert.equal(Number(!a.data.result.isError) + Number(b.status === 200), 1);
  assert.equal((await h.appState()).workouts.length, 2); assert.equal((await h.appState()).workouts[0].id, 'legacy-session');
  if (a.data.result.isError) assert.equal(a.data.result.structuredContent.code, 'revision-conflict'); else assert.equal(b.status, 409);
});
test('correction is narrow, version guarded, preserves media, and is separately scoped', async t => {
  const h = await setup(t); await h.seed(oldState()); const readOnly = await h.connection('workouts:read'), c = await h.connection();
  const got = await h.value('get_workout', { workout_id: 'legacy-session' }, c.access_token);
  const args = { request_id: 'correction-fixture', cursor: got.cursor, workout_id: 'legacy-session', expected_version: got.version, patch: { unit: 'kg', set_changes: [{ entry_index: 0, set_index: 0, weight: 42.5 }] } };
  const denied = await h.rpc('update_workout', args, readOnly.access_token); assert.match(denied.data.result._meta['mcp/www_authenticate'][0], /scope="workouts:read workouts:update"/);
  await h.value('update_workout', args, c.access_token); const changed = await h.appState();
  assert.equal(changed.workouts[0].entries[0].sets[0].w, 42.5); assert.equal(changed.workouts[0].note, 'keep this'); assert.deepEqual(changed.workouts[0].media, [{ id: 'fixture-media' }]);
  assert.equal((await h.value('update_workout', args, c.access_token)).replayed, true);
  const fresh = await h.value('get_training_context', {}, c.access_token);
  const conflict = await h.rpc('update_workout', { ...args, request_id: 'stale-edit-fixture', cursor: fresh.cursor }, c.access_token); assert.equal(conflict.data.result.structuredContent.code, 'workout-conflict');
});
test('invalid input, corrupt chunks and a failing receipt insert never partially change state', async t => {
  const h = await setup(t); await h.seed(oldState()); const c = await h.connection(), context = await h.value('get_training_context', {}, c.access_token), beforeState = await h.appState();
  const args = { request_id: 'rollback-fixture', cursor: context.cursor, workout: workout() };
  const bad = structuredClone(args); bad.workout.entries[0].sets[0].weight = -5;
  assert.equal((await h.rpc('log_workout', bad, c.access_token)).data.result.isError, true); assert.deepEqual(await h.appState(), beforeState);
  await h.db.exec("CREATE TRIGGER fixture_receipt_fail BEFORE INSERT ON mcp_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;");
  assert.equal((await h.rpc('log_workout', args, c.access_token)).status, 503); assert.deepEqual(await h.appState(), beforeState);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').first()).n, 0);
  await h.db.exec('DROP TRIGGER fixture_receipt_fail;'); await h.value('log_workout', args, c.access_token);
  await h.db.prepare('DELETE FROM state_chunks WHERE user_id=?').bind(h.uid).run();
  const corrupt = await h.rpc('get_training_context', {}, c.access_token); assert.equal(corrupt.data.result.structuredContent.code, 'state-unreadable');
});
test('revocation, expiry, logout-all and refresh reuse end access; bearer cannot use account APIs', async t => {
  const h = await setup(t), c = await h.connection();
  assert.equal((await h.request('/api/data', { token: c.access_token })).status, 401);
  assert.equal((await h.request('/api/integrations', { token: c.access_token })).status, 401);
  const refreshForm = { grant_type: 'refresh_token', client_id: c.client_id, refresh_token: c.refresh_token, resource: ORIGIN + '/mcp' };
  const next = await h.request('/oauth/token', { method: 'POST', form: refreshForm }); assert.equal(next.status, 200);
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: refreshForm })).status, 400);
  for (const token of [c.access_token, next.data.access_token]) assert.equal((await h.rpc('get_training_context', {}, token)).status, 401);
  const second = await h.connection(); await h.request('/api/logout/all', { method: 'POST', cookie: h.cookie, body: {} });
  assert.equal((await h.rpc('get_training_context', {}, second.access_token)).status, 401);
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: { ...refreshForm, client_id: second.client_id, refresh_token: second.refresh_token } })).status, 400);
});
test('a grant revoked after HTTP authentication is still refused inside the state transaction', async t => {
  const h = await setup(t), c = await h.connection(), context = await h.value('get_training_context', {}, c.access_token);
  const auth = await h.db.prepare('SELECT * FROM oauth_grants').first(); auth.accessHash = await sha256(c.access_token); auth.grantId = auth.id;
  await h.db.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').bind(auth.id).run();
  await assert.rejects(callTrainingTool({ DB: h.db }, auth, 'log_workout', { request_id: 'revocation-race', cursor: context.cursor, workout: workout() }), e => e.code === 'revision-conflict');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM states').first()).n, 0);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').first()).n, 0);
});
test('owner can narrow consent, revoke one connection, and expiry blocks both refresh and access', async t => {
  const h = await setup(t), c = await h.connection();
  const opts = await h.request('/oauth/consent/options', { method: 'POST', cookie: h.cookie, body: { authorization: c.authorization } });
  const stored = await h.db.prepare('SELECT request FROM oauth_consents WHERE id=?').bind(opts.data.cid).first();
  assert.equal(JSON.parse(stored.request).scope, 'workouts:read');
  assert.equal((await h.request('/oauth/consent/options', { method: 'POST', cookie: h.cookie, body: { authorization: { ...c.authorization, scope: 'workouts:read' }, approved_scope: 'workouts:read workouts:update' } })).status, 400);
  const connections = await h.request('/api/integrations', { cookie: h.cookie }); assert.equal(connections.data.connections.length, 1);
  await h.request('/api/integrations/revoke', { method: 'POST', cookie: h.cookie, body: { id: connections.data.connections[0].id } });
  assert.equal((await h.rpc('get_training_context', {}, c.access_token)).status, 401);
  const second = await h.connection(); await h.db.prepare('UPDATE oauth_access SET expires=0').run();
  assert.equal((await h.rpc('get_training_context', {}, second.access_token)).status, 401);
  await h.db.prepare('UPDATE oauth_grants SET expires=0').run();
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: second.client_id, refresh_token: second.refresh_token } })).status, 400);
});
test('consent and authorization codes expire, scope escalation and cross-client exchanges fail', async t => {
  const h = await setup(t), a = await h.connection('workouts:read', false), b = await h.connection('workouts:read', false);
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: { ...a.form, client_id: b.client_id } })).status, 400);
  await h.db.prepare('UPDATE oauth_codes SET expires=0 WHERE hash=?').bind(await sha256(a.form.code)).run();
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: a.form })).status, 400);
  const opts = await h.request('/oauth/consent/options', { method: 'POST', cookie: h.cookie, body: { authorization: a.authorization } });
  await h.db.prepare('UPDATE oauth_consents SET expires=0').run();
  assert.equal((await h.request('/oauth/consent/verify', { method: 'POST', cookie: h.cookie, body: { cid: opts.data.cid, credential: h.a.login(opts.data.options, ORIGIN) } })).status, 400);
  const c = await h.connection('workouts:read');
  assert.equal((await h.request('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: c.client_id, refresh_token: c.refresh_token, scope: 'workouts:read workouts:update' } })).status, 400);
});
test('MCP refuses nullable numbers, oversized inputs and malformed protocol versions without writing', async t => {
  const h = await setup(t), c = await h.connection(), context = await h.value('get_training_context', {}, c.access_token);
  const args = { request_id: 'invalid-null-input', cursor: context.cursor, workout: workout() }; args.workout.entries[0].sets[0].weight = null;
  assert.equal((await h.rpc('log_workout', args, c.access_token)).data.result.isError, true);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM states').first()).n, 0);
  assert.equal((await h.request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'MCP-Protocol-Version': 'future-unknown' } })).status, 400);
});
test('write throttling is grant-bound and committed retries still work without new side effects', async t => {
  const h = await setup(t), c = await h.connection(), context = await h.value('get_training_context', {}, c.access_token);
  const args = { request_id: 'rate-fixture-success', cursor: context.cursor, workout: workout() };
  await h.value('log_workout', args, c.access_token);
  const grant = await h.db.prepare('SELECT id FROM oauth_grants').first(), bucket = Math.floor(Date.now() / 60000);
  const key = await sha256('mcp-write|' + grant.id + '|' + bucket);
  await h.db.prepare('UPDATE rate_limits SET count=30 WHERE key=?').bind(key).run();
  assert.equal((await h.value('log_workout', args, c.access_token)).replayed, true);
  const fresh = await h.value('get_training_context', {}, c.access_token);
  const limited = await h.rpc('log_workout', { ...args, request_id: 'rate-fixture-blocked', cursor: fresh.cursor }, c.access_token);
  assert.equal(limited.data.result.structuredContent.code, 'rate-limit'); assert.equal((await h.appState()).workouts.length, 1);
});
test('account isolation is enforced by token owner, including custom exercises and request ids', async t => {
  const h = await setup(t, true, true), c = await h.connection(), owned = oldState();
  owned.customEx = [{ id: 'owner-private-ex', n: 'Private synthetic exercise', eq: 'barbell' }]; await h.seed(owned);
  const otherToken = 'ogma_' + 'Z'.repeat(43), gid = 'other-grant';
  await h.db.batch([
    h.db.prepare("INSERT INTO users(slot,id,name,created) VALUES(2,'other-owner','Other synthetic owner',1)"),
    h.db.prepare("INSERT INTO oauth_grants(id,user_id,client_id,scope,resource,sv,created,expires) VALUES(?,'other-owner',?,? ,?,0,1,?)").bind(gid, c.client_id, 'workouts:read workouts:create', ORIGIN + '/mcp', Date.now() + 600000),
    h.db.prepare('INSERT INTO oauth_access(hash,grant_id,expires) VALUES(?,?,?)').bind(await sha256(otherToken), gid, Date.now() + 600000)
  ]);
  assert.equal((await h.value('list_workouts', {}, otherToken)).workouts.length, 0);
  assert.equal((await h.value('search_exercises', { query: 'Private synthetic exercise' }, otherToken)).exercises.length, 0);
  assert.equal((await h.value('search_exercises', { query: 'Private synthetic exercise' }, c.access_token)).exercises.length, 1);
  assert.equal((await h.rpc('get_workout', { workout_id: 'legacy-session' }, otherToken)).data.result.structuredContent.code, 'not-found');
  assert.equal((await h.rpc('list_workouts', { user_id: h.uid }, otherToken)).data.result.isError, true);
  const ctx = await h.value('get_training_context', {}, otherToken); await h.value('log_workout', { request_id: 'other-owner-write', cursor: ctx.cursor, workout: workout('Other synthetic training') }, otherToken);
  assert.equal((await h.appState()).workouts.length, 1); assert.equal((await h.value('list_workouts', {}, otherToken)).workouts.length, 1);
});
test('consent HTML escapes untrusted client names and stale callbacks cannot bypass the owner allowlist', async t => {
  const h = await setup(t), c = await h.connection('workouts:read', false);
  await h.db.prepare('UPDATE oauth_clients SET name=? WHERE id=?').bind('</script><script>alert(1)</script>', c.client_id).run();
  const page = await h.request('/oauth/authorize?' + new URLSearchParams(c.authorization), { cookie: h.cookie });
  assert.equal(page.status, 200); assert.equal((page.data.match(/<script /g) || []).length, 1); assert.match(page.data, /&lt;\/script&gt;/); assert.ok(!page.data.includes('</script><script>alert'));
  await h.db.prepare('UPDATE oauth_clients SET redirects=? WHERE id=?').bind(JSON.stringify(['https://old-unapproved.example/callback']), c.client_id).run();
  assert.equal((await h.request('/oauth/authorize?' + new URLSearchParams({ ...c.authorization, redirect_uri: 'https://old-unapproved.example/callback' }), { cookie: h.cookie })).status, 400);
});
