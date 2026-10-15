import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { HttpError, randomToken, sha256, b64url, unb64url, utf8 } from './crypto.js';

export const SCOPES = ['workouts:read', 'workouts:create', 'workouts:update'];
export const mcpEnabled = env => env.MCP_ENABLED === 'true';
const ACCESS_MS = 15 * 60000, GRANT_MS = 7 * 86400000;
const liveTime = 'unixepoch()*1000+999'; // conservative through the current second
export function scopesOf(value = 'workouts:read') {
  if (typeof value !== 'string' || value.length > 200) throw new HttpError(400, 'Invalid scope', 'invalid_scope');
  const scopes = [...new Set(value.split(' ').filter(Boolean))].sort();
  if (!scopes.length || scopes.some(s => !SCOPES.includes(s)) || !scopes.includes('workouts:read')) throw new HttpError(400, 'Training read scope is required; unknown scopes are refused', 'invalid_scope');
  return scopes.join(' ');
}
export const hasScope = (auth, scope) => auth.scope.split(' ').includes(scope);
export function authChallenge(origin, error = 'invalid_token', scope = '') {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="${error}", error_description="Reconnect and approve the required training permissions"${scope ? `, scope="${scope}"` : ''}`;
}
export async function bearer(req, env, origin) {
  const header = req.headers.get('Authorization') || '';
  const match = /^Bearer (ogma_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return null;
  const hash = await sha256(match[1]);
  const a = await env.DB.prepare(`SELECT g.* FROM oauth_access a JOIN oauth_grants g ON g.id=a.grant_id
    JOIN users u ON u.id=g.user_id WHERE a.hash=? AND a.expires>? AND g.expires>?
    AND g.revoked=0 AND g.sv=u.session_version AND g.resource=?`).bind(hash, Date.now(), Date.now(), origin + '/mcp').first();
  return a ? { ...a, accessHash: hash, grantId: a.id } : null;
}
const oauthError = (message, code = 'invalid_request', status = 400) => { throw new HttpError(status, message, code); };
async function client(env, id) {
  if (typeof id !== 'string' || id.length > 100) oauthError('Invalid client', 'invalid_client');
  const c = await env.DB.prepare('SELECT * FROM oauth_clients WHERE id=?').bind(id).first();
  if (!c) oauthError('Unknown client', 'invalid_client');
  return c;
}
function redirectURI(raw, origin) {
  let u;
  try { u = new URL(raw); } catch { oauthError('Invalid redirect URI'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname) && new URL(origin).protocol === 'http:';
  if ((u.protocol !== 'https:' && !local) || u.username || u.password || raw.includes('#') || u.href !== raw || u.href.length > 2000) oauthError('Redirect URI must be exact HTTPS without fragments, credentials or normalization');
  return u.href;
}
function approvedCallback(env, uri) {
  let allowed; try { allowed = JSON.parse(env.MCP_REDIRECT_URIS || '[]'); } catch { return false; }
  return Array.isArray(allowed) && allowed.includes(uri);
}
async function authorization(env, params, origin) {
  const c = await client(env, params.client_id);
  if (params.response_type !== 'code' || params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || '')) oauthError('Authorization code with PKCE S256 is required');
  const redirect = redirectURI(params.redirect_uri, origin);
  if (!JSON.parse(c.redirects).includes(redirect) || !approvedCallback(env, redirect)) oauthError('Redirect URI is not registered or no longer approved');
  if (typeof params.state !== 'string' || !params.state || params.state.length > 1024) oauthError('A nonempty OAuth state is required');
  if (params.resource !== origin + '/mcp') oauthError('Wrong resource', 'invalid_target');
  const scope = scopesOf(params.scope);
  if (scope.split(' ').some(s => !c.scope.split(' ').includes(s))) oauthError('Client did not register this scope', 'invalid_scope');
  return { client_id: c.id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256',
    code_challenge: params.code_challenge, state: params.state, resource: params.resource, scope, client_name: c.name };
}
const uniqueParams = params => {
  if ([...params.keys()].length !== new Set(params.keys()).size) oauthError('Duplicate OAuth parameters');
  return Object.fromEntries(params);
};
async function form(req) {
  if (!(req.headers.get('Content-Type') || '').startsWith('application/x-www-form-urlencoded')) oauthError('Form encoding required', 'invalid_request', 415);
  const reader = req.body?.getReader(), chunks = []; let size = 0;
  if (reader) for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > 16384) { await reader.cancel(); oauthError('Request too large', 'invalid_request', 413); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return uniqueParams(new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(data)));
}
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function html(body, script = '', status = 200) {
  const nonce = randomToken();
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>openGym · AI 助手授权</title><style nonce="${nonce}">body{max-width:640px;margin:8vh auto;padding:24px;background:#111;color:#eee;font:17px/1.7 system-ui}button,a{font:inherit;color:inherit}button{padding:12px 18px;margin:10px 8px 0 0;cursor:pointer}code{overflow-wrap:anywhere}#error{color:#ffb4ab}</style><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  }});
}
const scopeLabels = { 'workouts:read': '查询训练记录和动作目录', 'workouts:create': '新增已完成训练', 'workouts:update': '更正既有训练的组数值、名称和备注' };
function consentPage(a, origin, loggedIn) {
  if (!loggedIn) return html('<h1>先验证你的 openGym 身份</h1><p>请在新标签页登录网站，然后返回此页刷新。授权不会使用邀请码或账号密码。</p><a href="/" target="_blank" rel="noopener">打开网站，用通行密钥登录</a>', '', 401);
  const denied = new URL(a.redirect_uri); denied.searchParams.set('error', 'access_denied'); denied.searchParams.set('state', a.state); denied.searchParams.set('iss', origin);
  const body = `<h1>允许 AI 助手访问训练记录？</h1><p>客户端：<strong>${escapeHTML(a.client_name)}</strong></p><p>回调地址：<code>${escapeHTML(a.redirect_uri)}</code></p><ul>${a.scope.split(' ').map(s => `<li><label><input type="checkbox" name="permission" value="${s}" ${s === 'workouts:read' ? 'checked disabled' : ''}>${scopeLabels[s]}</label></li>`).join('')}</ul><p>写入权限需要你自行勾选。仅限你的训练记录。不能删除训练、修改账号、读取凭据或读取整份个人档案。授权最多 7 天，访问令牌 15 分钟；可随时在“已连接助手”撤销。</p><button id="approve">同意并用通行密钥验证</button><a href="${escapeHTML(denied.href)}">拒绝</a><p id="error" role="alert"></p>`;
  const payload = JSON.stringify(a).replaceAll('<', '\\u003c');
  const script = `const request=${payload};const button=document.getElementById('approve');
const decode=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'授权未完成');return v;}
button.onclick=async()=>{button.disabled=true;try{const approved_scope=Array.from(document.querySelectorAll('input[name="permission"]:checked')).map(e=>e.value).join(' ');const v=await post('/oauth/consent/options',{authorization:request,approved_scope});v.options.challenge=decode(v.options.challenge);v.options.allowCredentials=(v.options.allowCredentials||[]).map(c=>({...c,id:decode(c.id)}));const c=await navigator.credentials.get({publicKey:v.options});const response={clientDataJSON:encode(c.response.clientDataJSON),authenticatorData:encode(c.response.authenticatorData),signature:encode(c.response.signature),userHandle:c.response.userHandle?encode(c.response.userHandle):null};const result=await post('/oauth/consent/verify',{cid:v.cid,credential:{id:c.id,rawId:encode(c.rawId),type:c.type,response,clientExtensionResults:c.getClientExtensionResults()}});location.assign(result.redirect_url);}catch(e){document.getElementById('error').textContent=e.name==='NotAllowedError'?'验证已取消，可重试。':e.message;button.disabled=false;}};`;
  return html(body, script);
}
function tokenInsert(db, table, hash, gid, expires) {
  return db.prepare(`INSERT INTO ${table}(hash,grant_id,expires) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM oauth_grants g
    JOIN users u ON u.id=g.user_id WHERE g.id=? AND g.revoked=0 AND g.sv=u.session_version AND g.expires>${liveTime})`).bind(hash, gid, expires, gid);
}
export async function handleOAuth(req, env, path, ctx) {
  const { json, site, requireUser, csrf, readBody, throttle } = ctx, origin = site(env).origin;
  if (!mcpEnabled(env)) return json(404, { error: 'not found' });
  const rp = origin + '/mcp';
  try {
    if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) return json(200, { resource: rp, authorization_servers: [origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'] });
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') return json(200, {
      issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register', revocation_endpoint: origin + '/oauth/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false
    });
    if (req.method === 'POST' && path === '/oauth/register') {
      if (req.headers.get('Origin') && req.headers.get('Origin') !== origin) oauthError('Unexpected origin', 'invalid_request', 403);
      await throttle(req, env);
      const b = await readBody(req, 16384);
      if ((b.token_endpoint_auth_method || 'none') !== 'none' || (b.grant_types && (!Array.isArray(b.grant_types) || b.grant_types.some(x => !['authorization_code', 'refresh_token'].includes(x)))) || (b.response_types && (!Array.isArray(b.response_types) || b.response_types.some(x => x !== 'code')))) oauthError('Only public authorization-code/PKCE clients are supported', 'invalid_client_metadata');
      if (!Array.isArray(b.redirect_uris) || !b.redirect_uris.length || b.redirect_uris.length > 5 || typeof b.client_name !== 'string' || !b.client_name.trim() || b.client_name.length > 100) oauthError('Client name and 1–5 redirect URIs required', 'invalid_client_metadata');
      const redirects = [...new Set(b.redirect_uris.map(x => redirectURI(x, origin)))], id = randomToken(), scope = scopesOf(b.scope || SCOPES.join(' '));
      if (redirects.some(uri => !approvedCallback(env, uri))) oauthError('Callback URI is not approved by the instance owner', 'invalid_client_metadata');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_grants WHERE expires<=?').bind(Date.now() - 86400000),
        env.DB.prepare('DELETE FROM oauth_codes WHERE expires<=?').bind(Date.now())
      ]);
      const result = await env.DB.prepare(`INSERT INTO oauth_clients(id,name,redirects,scope,created)
        SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_clients)<128`).bind(id, b.client_name.trim(), JSON.stringify(redirects), scope, Date.now()).run();
      if (!result.meta.changes) oauthError('Client registry is full; contact the owner', 'temporarily_unavailable', 503);
      return json(201, { client_id: id, client_name: b.client_name.trim(), redirect_uris: redirects, scope,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }
    if (req.method === 'GET' && path === '/oauth/authorize') {
      const a = await authorization(env, uniqueParams(new URL(req.url).searchParams), origin);
      let loggedIn = false; try { await requireUser(req, env); loggedIn = true; } catch (e) { if (e.status !== 401) throw e; }
      return consentPage(a, origin, loggedIn);
    }
    if (path === '/oauth/consent/options' && req.method === 'POST') {
      csrf(req, env); const u = await requireUser(req, env); await throttle(req, env);
      const b = await readBody(req, 16384), a = await authorization(env, b.authorization || {}, origin);
      const approved = scopesOf(b.approved_scope || 'workouts:read');
      if (approved.split(' ').some(s => !a.scope.split(' ').includes(s))) oauthError('Consent cannot expand requested permissions', 'invalid_scope');
      a.scope = approved;
      const options = await generateAuthenticationOptions({ rpID: site(env).rpID, userVerification: 'required', allowCredentials: [] });
      const cid = randomToken();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_consents WHERE expires<=?').bind(Date.now()),
        env.DB.prepare(`INSERT INTO oauth_consents(id,user_id,sv,challenge,request,expires)
          SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_consents)<128`).bind(cid, u.id, u.session_version, options.challenge, JSON.stringify(a), Date.now() + 5 * 60000)
      ]);
      return json(200, { cid, options });
    }
    if (path === '/oauth/consent/verify' && req.method === 'POST') {
      csrf(req, env); const u = await requireUser(req, env); await throttle(req, env);
      const b = await readBody(req), c = await env.DB.prepare('DELETE FROM oauth_consents WHERE id=? AND user_id=? AND sv=? AND expires>? RETURNING *').bind(String(b.cid || '').slice(0, 100), u.id, u.session_version, Date.now()).first();
      if (!c) oauthError('Consent expired; restart authorization', 'invalid_request');
      const credential = await env.DB.prepare('SELECT * FROM credentials WHERE id=? AND user_id=?').bind(String(b.credential?.id || '').slice(0, 2048), u.id).first();
      if (!credential) oauthError('Passkey verification failed', 'access_denied', 403);
      let verified;
      try { verified = await verifyAuthenticationResponse({ response: b.credential, expectedChallenge: c.challenge, expectedOrigin: origin,
        expectedRPID: site(env).rpID, requireUserVerification: true, credential: { id: credential.id, publicKey: unb64url(credential.public_key), counter: credential.counter, transports: JSON.parse(credential.transports) } }); }
      catch { oauthError('Passkey verification failed', 'access_denied', 403); }
      if (!verified.verified) oauthError('Passkey verification failed', 'access_denied', 403);
      const a = JSON.parse(c.request), code = randomToken();
      const result = await env.DB.batch([
        env.DB.prepare('UPDATE credentials SET counter=MAX(counter,?),last_used=? WHERE id=? AND user_id=?').bind(verified.authenticationInfo.newCounter, Date.now(), credential.id, u.id),
        env.DB.prepare(`INSERT INTO oauth_codes(hash,user_id,client_id,redirect_uri,challenge,scope,resource,sv,expires)
          SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND session_version=?)`).bind(await sha256(code), u.id, a.client_id, a.redirect_uri, a.code_challenge, a.scope, a.resource, c.sv, Date.now() + 60000, u.id, c.sv)
      ]);
      if (!result[1].meta.changes) oauthError('Session revoked', 'access_denied', 403);
      const target = new URL(a.redirect_uri); target.searchParams.set('code', code); target.searchParams.set('state', a.state); target.searchParams.set('iss', origin);
      return json(200, { redirect_url: target.href });
    }
    if (req.method === 'POST' && path === '/oauth/token') {
      if (req.headers.get('Origin') && req.headers.get('Origin') !== origin) oauthError('Unexpected origin', 'invalid_request', 403);
      await throttle(req, env); const b = await form(req); await client(env, b.client_id);
      await env.DB.prepare('DELETE FROM oauth_access WHERE expires<=?').bind(Date.now()).run();
      if (b.resource && b.resource !== rp) oauthError('Wrong resource', 'invalid_target');
      const access = 'ogma_' + randomToken(), refresh = 'ogmr_' + randomToken(), mark = randomToken(), now = Date.now();
      let gid, scope, expires;
      if (b.grant_type === 'authorization_code') {
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier || '') || typeof b.code !== 'string' || b.code.length > 100) oauthError('Invalid authorization code', 'invalid_grant');
        const hash = await sha256(b.code), c = await env.DB.prepare(`SELECT c.* FROM oauth_codes c JOIN users u ON u.id=c.user_id WHERE c.hash=? AND c.client_id=? AND c.sv=u.session_version`).bind(hash, b.client_id).first();
        const challenge = b64url(await crypto.subtle.digest('SHA-256', utf8.encode(b.code_verifier)).then(v => new Uint8Array(v)));
        if (!c || c.consumed || c.expires <= now || c.redirect_uri !== b.redirect_uri || c.resource !== rp || c.challenge !== challenge) oauthError('Invalid or expired authorization code', 'invalid_grant');
        gid = randomToken(); scope = c.scope; expires = now + GRANT_MS;
        const result = await env.DB.batch([
          env.DB.prepare(`UPDATE oauth_codes SET consumed=? WHERE hash=? AND consumed IS NULL AND expires>${liveTime}
            AND EXISTS(SELECT 1 FROM users WHERE id=? AND session_version=?)`).bind(mark, hash, c.user_id, c.sv),
          env.DB.prepare(`INSERT INTO oauth_grants(id,user_id,client_id,scope,resource,sv,created,expires)
            SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM oauth_codes WHERE hash=? AND consumed=?)`).bind(gid, c.user_id, c.client_id, scope, rp, c.sv, now, expires, hash, mark),
          tokenInsert(env.DB, 'oauth_access', await sha256(access), gid, now + ACCESS_MS),
          tokenInsert(env.DB, 'oauth_refresh', await sha256(refresh), gid, expires)
        ]);
        if (!result[0].meta.changes || !result[2].meta.changes) oauthError('Authorization code already consumed or revoked', 'invalid_grant');
      } else if (b.grant_type === 'refresh_token') {
        if (!/^ogmr_[A-Za-z0-9_-]{43}$/.test(b.refresh_token || '')) oauthError('Invalid refresh token', 'invalid_grant');
        const hash = await sha256(b.refresh_token), row = await env.DB.prepare(`SELECT r.consumed,r.expires AS refresh_expires,g.* FROM oauth_refresh r JOIN oauth_grants g ON g.id=r.grant_id JOIN users u ON u.id=g.user_id
          WHERE r.hash=? AND g.client_id=? AND g.sv=u.session_version`).bind(hash, b.client_id).first();
        if (!row || row.revoked || row.expires <= now || row.refresh_expires <= now || row.resource !== rp) oauthError('Expired or revoked refresh token', 'invalid_grant');
        if (row.consumed) { await env.DB.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').bind(row.id).run(); oauthError('Refresh token reuse revoked this connection', 'invalid_grant'); }
        if (b.scope && scopesOf(b.scope) !== row.scope) oauthError('Refresh cannot change scopes', 'invalid_scope');
        gid = row.id; scope = row.scope; expires = row.expires;
        const result = await env.DB.batch([
          env.DB.prepare(`UPDATE oauth_refresh SET consumed=? WHERE hash=? AND consumed IS NULL AND expires>${liveTime}
            AND EXISTS(SELECT 1 FROM oauth_grants g JOIN users u ON u.id=g.user_id WHERE g.id=? AND g.revoked=0 AND g.sv=u.session_version AND g.expires>${liveTime})`).bind(mark, hash, gid),
          env.DB.prepare(`INSERT INTO oauth_access(hash,grant_id,expires) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM oauth_refresh WHERE hash=? AND consumed=?)`).bind(await sha256(access), gid, now + ACCESS_MS, hash, mark),
          env.DB.prepare(`INSERT INTO oauth_refresh(hash,grant_id,expires) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM oauth_refresh WHERE hash=? AND consumed=?)`).bind(await sha256(refresh), gid, expires, hash, mark)
        ]);
        if (!result[0].meta.changes) { await env.DB.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=?').bind(gid).run(); oauthError('Refresh token already used', 'invalid_grant'); }
      } else oauthError('Only authorization_code and refresh_token are supported', 'unsupported_grant_type');
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: Math.min(ACCESS_MS / 1000, Math.max(0, Math.floor((expires - now) / 1000))), refresh_token: refresh, scope });
    }
    if (req.method === 'POST' && path === '/oauth/revoke') {
      await throttle(req, env); const b = await form(req); await client(env, b.client_id);
      if (typeof b.token !== 'string' || b.token.length > 100) oauthError('Invalid token');
      const hash = await sha256(b.token);
      await env.DB.prepare(`UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND id IN
        (SELECT grant_id FROM oauth_access WHERE hash=? UNION SELECT grant_id FROM oauth_refresh WHERE hash=?)`).bind(b.client_id, hash, hash).run();
      return json(200, {});
    }
    if ((path === '/api/integrations' && req.method === 'GET') || (path === '/oauth/connections' && req.method === 'GET')) {
      const u = await requireUser(req, env);
      const { results } = await env.DB.prepare(`SELECT g.id,c.name,g.scope,g.created,g.expires,g.revoked FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.user_id=? ORDER BY g.created DESC LIMIT 100`).bind(u.id).all();
      if (path === '/api/integrations') return json(200, { connections: results });
      const list = results.map(g => `<li>${escapeHTML(g.name)} — ${g.scope.split(' ').map(s => scopeLabels[s] || '未知权限').join('、')} — ${g.revoked || g.expires <= Date.now() ? '已失效' : `<button data-id="${g.id}">撤销授权</button>`}</li>`).join('');
      return html(`<h1>已连接的 AI 助手</h1><p>撤销后，助手不能再读写训练。训练记录会保留。</p><ul>${list || '<li>尚无授权</li>'}</ul><p id="error"></p><a href="/">返回 openGym</a>`, `for(const b of document.querySelectorAll('button[data-id]'))b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/api/integrations/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.id})});if(!r.ok)throw Error('撤销未完成，请重试');location.reload();}catch(e){document.getElementById('error').textContent=e.message;b.disabled=false;}};`);
    }
    if (path === '/api/integrations/revoke' && req.method === 'POST') {
      csrf(req, env); const u = await requireUser(req, env), b = await readBody(req, 4096);
      if (typeof b.id !== 'string' || b.id.length > 100) oauthError('Invalid connection id');
      await env.DB.prepare('UPDATE oauth_grants SET revoked=1 WHERE id=? AND user_id=?').bind(b.id, u.id).run();
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code || 'invalid_request', error_description: e.message });
    throw e;
  }
}
