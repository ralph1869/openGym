import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { HttpError, b64url, unb64url, randomToken, sha256, equalHash, utf8 } from './crypto.js';
import { MAX_STATE_BYTES, forClient, readState, prepareState, writeState } from './state.js';

const TTL = 5 * 60000;
const publicUser = u => ({ id: u.id, name: u.name, admin: false });
const CAPS = { passkey_management: false, device_link: false, pairing: false, push: false, media_upload: false, admin: false, coach: false };
function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers
  }});
}
function site(env) {
  let origin;
  try { origin = new URL(env.ORIGIN); } catch { throw new HttpError(503, 'Instance origin is not configured', 'not-configured'); }
  const local = ['localhost', '127.0.0.1'].includes(origin.hostname);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      (!local && origin.protocol !== 'https:') || (env.RP_ID && env.RP_ID !== origin.hostname)) {
    throw new HttpError(503, 'Instance origin or RP_ID is invalid', 'not-configured');
  }
  return { origin: origin.origin, rpID: origin.hostname, secure: origin.protocol === 'https:' };
}
function cookieName(env) { return site(env).secure ? '__Host-gymsid' : 'gymsid'; }
function cookie(env, token, days = 0) {
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${site(env).secure ? '; Secure' : ''}`;
}
function cookieToken(req, env) {
  const vals = (req.headers.get('Cookie') || '').split(';').map(x => x.trim())
    .filter(x => x.startsWith(cookieName(env) + '=')).map(x => x.slice(cookieName(env).length + 1));
  if (!vals.length || vals.some(x => x !== vals[0]) || !/^[A-Za-z0-9_-]{43}$/.test(vals[0])) return null;
  return vals[0];
}
async function session(req, env) {
  const token = cookieToken(req, env);
  if (!token) return null;
  return env.DB.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.hash=? AND s.expires>? AND s.version=u.session_version`).bind(await sha256(token), Date.now()).first();
}
async function requireUser(req, env) {
  const u = await session(req, env);
  if (!u) throw new HttpError(401, 'not signed in');
  return u;
}
function csrf(req, env) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const expected = site(env).origin;
  const origin = req.headers.get('Origin'), fetchSite = req.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== expected) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new HttpError(403, 'Request must come from this instance', 'csrf');
  }
  if (!(req.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'application/json required');
  }
}
async function readBody(req, limit = 64 * 1024) {
  if (Number(req.headers.get('Content-Length')) > limit) throw new HttpError(413, 'request too large');
  const reader = req.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HttpError(400, 'invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  return body;
}
async function throttle(req, env) {
  const now = Date.now(), bucket = Math.floor(now / TTL);
  const key = await sha256(`auth|${req.headers.get('CF-Connecting-IP') || 'local'}|${bucket}`);
  const r = await env.DB.prepare(`INSERT INTO rate_limits(key,count,expires) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(key, (bucket + 1) * TTL).first();
  if (r.count > 60) throw new HttpError(429, 'Too many authentication attempts. Try again later.', 'rate-limit');
  // Bounded retention; no raw addresses, credentials or user state in logs.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM challenges WHERE expires<=?').bind(now)
  ]);
}
async function putChallenge(env, data) {
  const cid = randomToken();
  await env.DB.prepare(`INSERT INTO challenges(id,kind,challenge,user_id,name,invite_hash,expires)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM challenges)<1000`)
    .bind(cid, data.kind, data.challenge, data.uid || null, data.name || null, data.inviteHash || null, Date.now() + TTL).run()
    .then(r => { if (r.meta.changes !== 1) throw new HttpError(429, 'Authentication is busy. Try again later.'); });
  return cid;
}
async function takeChallenge(env, cid, kind) {
  if (typeof cid !== 'string' || cid.length > 100) throw new HttpError(400, 'challenge expired, try again', 'challenge-expired');
  const r = await env.DB.prepare('DELETE FROM challenges WHERE id=? AND kind=? AND expires>? RETURNING *')
    .bind(cid, kind, Date.now()).first();
  if (!r) throw new HttpError(400, 'challenge expired, try again', 'challenge-expired');
  return r;
}
async function newSession(env, u) {
  const token = randomToken(), days = Math.min(90, Math.max(1, Number(env.SESSION_DAYS) || 30));
  const statement = env.DB.prepare('INSERT INTO sessions(hash,user_id,version,expires) VALUES (?,?,?,?)')
    .bind(await sha256(token), u.id, u.session_version || 0, Date.now() + days * 86400000);
  return { statement, header: cookie(env, token, days) };
}
async function registrationOpen(env) {
  return /^[a-f0-9]{64}$/i.test(env.REGISTRATION_TOKEN_SHA256 || '') && !(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first());
}
async function handle(req, env, path) {
  const key = req.method + ' ' + path;
  if (key === 'GET /api/health') {
    await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    return json(200, { ok: true, storage: 'd1', version: '1.4.1+cloudflare' });
  }
  if (key === 'GET /api/config') return json(200, {
    invite_only: true, allow_guest: false, password_login: false,
    registration_open: await registrationOpen(env), default_lang: env.DEFAULT_LANG || 'zh-CN',
    deployment: 'cloudflare-personal', capabilities: CAPS, coach: null,
    source_url: env.SOURCE_URL || 'https://github.com/ralph1869/openGym/tree/feat/cloudflare-d1'
  });
  csrf(req, env);
  if (/^POST \/api\/(login|register)\//.test(key)) await throttle(req, env);
  if (key === 'POST /api/register/options') {
    const body = await readBody(req), name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
    if (!name) throw new HttpError(400, 'name required');
    if (!(await registrationOpen(env))) throw new HttpError(403, 'Registration is closed for this personal instance', 'registration-closed');
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const hash = await sha256(code);
    if (!code || !equalHash(hash, env.REGISTRATION_TOKEN_SHA256.toLowerCase())) throw new HttpError(403, 'a valid invite code is required', 'invite');
    const uid = randomToken(), { rpID } = site(env);
    const options = await generateRegistrationOptions({ rpName: 'openGym', rpID, userID: utf8.encode(uid),
      userName: name, userDisplayName: name, attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: [] });
    const cid = await putChallenge(env, { kind: 'register', challenge: options.challenge, uid, name, inviteHash: hash });
    return json(200, { cid, options });
  }
  if (key === 'POST /api/register/verify') {
    const body = await readBody(req), c = await takeChallenge(env, body.cid, 'register');
    if (!equalHash(c.invite_hash, (env.REGISTRATION_TOKEN_SHA256 || '').toLowerCase()) || !(await registrationOpen(env))) {
      throw new HttpError(403, 'Registration is closed or invite is no longer valid', 'invite');
    }
    const { rpID, origin } = site(env);
    let v;
    try { v = await verifyRegistrationResponse({ response: body.credential, expectedChallenge: c.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
    catch { throw new HttpError(400, 'Passkey could not be verified. Check the hostname and try again.', 'passkey'); }
    if (!v.verified) throw new HttpError(400, 'Passkey could not be verified', 'passkey');
    const cred = v.registrationInfo.credential, now = Date.now();
    const u = { id: c.user_id, name: c.name, session_version: 0 }, s = await newSession(env, u);
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users(slot,id,name,created) VALUES (1,?,?,?)').bind(u.id, u.name, now),
        env.DB.prepare(`INSERT INTO credentials(id,user_id,public_key,counter,transports,created,last_used)
          VALUES (?,?,?,?,?,?,?)`).bind(cred.id, u.id, b64url(cred.publicKey), cred.counter || 0, JSON.stringify(cred.transports || []), now, now),
        s.statement
      ]);
    } catch (e) {
      if (await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first()) throw new HttpError(409, 'This personal instance already has an account', 'registration-closed');
      throw e;
    }
    return json(200, { user: publicUser(u) }, { 'Set-Cookie': s.header });
  }
  if (key === 'POST /api/login/options') {
    await readBody(req);
    const options = await generateAuthenticationOptions({ rpID: site(env).rpID, userVerification: 'required', allowCredentials: [] });
    return json(200, { cid: await putChallenge(env, { kind: 'login', challenge: options.challenge }), options });
  }
  if (key === 'POST /api/login/verify') {
    const body = await readBody(req), c = await takeChallenge(env, body.cid, 'login');
    const cred = await env.DB.prepare('SELECT * FROM credentials WHERE id=?').bind(String(body.credential?.id || '').slice(0, 2048)).first();
    if (!cred) throw new HttpError(400, 'Passkey could not be verified', 'passkey');
    const { rpID, origin } = site(env); let v;
    try { v = await verifyAuthenticationResponse({ response: body.credential, expectedChallenge: c.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: cred.id, publicKey: unb64url(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports) } }); }
    catch { throw new HttpError(400, 'Passkey could not be verified', 'passkey'); }
    if (!v.verified) throw new HttpError(400, 'Passkey could not be verified', 'passkey');
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(cred.user_id).first();
    if (!u) throw new HttpError(401, 'not signed in');
    const s = await newSession(env, u);
    await env.DB.batch([
      env.DB.prepare('UPDATE credentials SET counter=MAX(counter,?),last_used=? WHERE id=?')
        .bind(v.authenticationInfo.newCounter, Date.now(), cred.id), s.statement
    ]);
    return json(200, { user: publicUser(u) }, { 'Set-Cookie': s.header });
  }
  if (key === 'GET /api/me') return json(200, { user: publicUser(await requireUser(req, env)) });
  if (key === 'POST /api/logout') {
    const token = cookieToken(req, env);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await sha256(token)).run();
    return json(200, { ok: true }, { 'Set-Cookie': cookie(env, '') });
  }
  if (key === 'POST /api/logout/all') {
    const u = await requireUser(req, env);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').bind(u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id),
      env.DB.prepare('DELETE FROM challenges WHERE user_id=?').bind(u.id)
    ]);
    return json(200, { ok: true }, { 'Set-Cookie': cookie(env, '') });
  }
  if (key === 'GET /api/data' || key === 'GET /api/data/rev') {
    const u = await requireUser(req, env), state = await readState(env.DB, u.id);
    return json(200, key.endsWith('/rev') ? { rev: state?._rev || 0, ...(state?._wid ? { wid: state._wid } : {}) }
      : { state: forClient(state), rev: state?._rev || 0 });
  }
  if (key === 'PUT /api/data') {
    const u = await requireUser(req, env), body = await readBody(req, MAX_STATE_BYTES + 64 * 1024);
    const cur = await readState(env.DB, u.id), next = prepareState(cur, body);
    if (!next || !(await writeState(env.DB, u.id, cur, next))) {
      const latest = await readState(env.DB, u.id);
      return json(409, { error: 'conflict', rev: latest?._rev || 0, state: forClient(latest) });
    }
    return json(200, { ok: true, ts: next.state._ts || null, rev: next.clientRev, wid: next.state._wid });
  }
  if (/^\/api\/(coach|media|push|admin|account|device-link|pair|activity)(\/|$)/.test(path)) {
    await requireUser(req, env);
    throw new HttpError(501, 'This feature is unavailable in the Cloudflare personal edition', 'unsupported');
  }
  return json(404, { error: 'not found' });
}
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    try {
      if (path === '/api' || path.startsWith('/api/')) return await handle(req, env, path);
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404 || !['GET', 'HEAD'].includes(req.method)) return asset;
      if (!path.startsWith('/exercise-media/') && !path.split('/').at(-1).includes('.') &&
          (req.headers.get('Accept') || '').includes('text/html')) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', req.url), req));
      }
      return asset;
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status === 429 ? { 'Retry-After': '300' } : {});
      // Never log request bodies, credential responses, SQL bindings, user state or tokens.
      console.error('openGym request failed', e?.name || 'Error');
      return json(503, { error: 'Storage or authentication service is unavailable. Your local changes have not been accepted.', code: 'unavailable' });
    }
  }
};
