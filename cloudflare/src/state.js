import { stampPut } from '../../api/sync-stamps.js';
import { HttpError, randomToken, sha256, utf8 } from './crypto.js';

export const MAX_STATE_BYTES = 5 * 1024 * 1024;
// At most 786432 UTF-8 bytes per TEXT row; even the worst Unicode is below D1's 2 MB.
// A 5 MiB ASCII document needs 20 inserts, safely within the free 50-query invocation cap.
export const CHUNK_CHARS = 256 * 1024;
export function splitText(text) {
  const out = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(start, end)); start = end;
  }
  return out;
}
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const unreadable = () => new HttpError(503, 'Stored state is incomplete or damaged. Restore a verified backup before syncing.', 'state-unreadable');
export function forClient(state) {
  if (!state) return null;
  const { _unstamped, _prior, ...rest } = state;
  return rest;
}

export async function readState(db, uid) {
  // One statement gives a consistent snapshot of the manifest and all its chunks.
  const { results } = await db.prepare(`SELECT s.rev, s.wid, s.chunks, s.bytes, s.sha256,
    c.n, c.data FROM states s LEFT JOIN state_chunks c
    ON c.user_id = s.user_id AND c.wid = s.wid
    WHERE s.user_id = ? ORDER BY c.n`).bind(uid).all();
  if (!results.length) return null;
  const meta = results[0];
  if (!Number.isSafeInteger(meta.rev) || meta.rev < 1 || !meta.wid ||
      !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 32 ||
      results.length !== meta.chunks || !/^[a-f0-9]{64}$/.test(meta.sha256)) throw unreadable();
  for (let i = 0; i < results.length; i++) {
    if (results[i].n !== i || typeof results[i].data !== 'string') throw unreadable();
  }
  const text = results.map(r => r.data).join('');
  if (utf8.encode(text).byteLength !== meta.bytes || meta.bytes > MAX_STATE_BYTES ||
      await sha256(text) !== meta.sha256) throw unreadable();
  let state;
  try { state = JSON.parse(text); } catch { throw unreadable(); }
  if (!object(state) || state._rev !== meta.rev || state._wid !== meta.wid) throw unreadable();
  return state;
}

export function prepareState(cur, body) {
  const state = body.state;
  if (!object(state) || !Object.keys(state).some(k => !k.startsWith('_'))) throw new HttpError(400, 'state required');
  for (const k of ['workouts', 'routines']) {
    if (state[k] != null && !Array.isArray(state[k])) throw new HttpError(400, 'invalid state');
    if (Array.isArray(state[k])) state[k] = state[k].filter(object);
  }
  const rev = cur?._rev || 0;
  if (body.baseRev != null && (!Number.isSafeInteger(body.baseRev) || body.baseRev < 0)) throw new HttpError(400, 'invalid baseRev');
  if (body.baseWid != null && typeof body.baseWid !== 'string') throw new HttpError(400, 'invalid baseWid');
  if ((body.baseRev != null && body.baseRev !== rev) ||
      (typeof body.baseWid === 'string' && cur?._wid && body.baseWid !== cur._wid)) return null;
  delete state.active; // In-progress workouts stay local, exactly as in the Node API.
  if ((Number(cur?.resetAt) || 0) > (Number(state.resetAt) || 0)) {
    state.resetAt = cur.resetAt;
    if (object(cur.resetIds)) state.resetIds = cur.resetIds; else delete state.resetIds;
  }
  const report = {};
  try { stampPut(cur, state, { overRead: body.baseRev != null && body.baseRev === rev, stamped: body.stamped === true, report }); }
  catch (e) { if (e instanceof RangeError) throw new HttpError(400, 'invalid state'); throw e; }
  state._rev = rev + (report.changed ? 2 : 1);
  state._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
    .filter(x => typeof x === 'string').slice(-50);
  state._wid = randomToken();
  return { state, clientRev: rev + 1 };
}

export async function writeState(db, uid, cur, prepared, { authorization = null, receipt = null } = {}) {
  let text;
  try { text = JSON.stringify(prepared.state); } catch { throw new HttpError(400, 'invalid state'); }
  const bytes = utf8.encode(text).byteLength;
  if (bytes > MAX_STATE_BYTES) throw new HttpError(413, 'state exceeds the 5 MiB personal-instance limit', 'too-large');
  const chunks = splitText(text), wid = prepared.state._wid;
  const fields = [prepared.state._rev, wid, chunks.length, bytes, await sha256(text), Date.now()];
  // OAuth validity is checked again INSIDE the CAS transaction, so revocation/expiry
  // between the HTTP authentication and this write cannot grant stale write access.
  const authSQL = authorization ? ` AND EXISTS (SELECT 1 FROM oauth_access a
    JOIN oauth_grants g ON g.id=a.grant_id JOIN users u ON u.id=g.user_id
    WHERE a.hash=? AND g.id=? AND u.id=? AND g.revoked=0 AND g.sv=u.session_version
    AND a.expires>unixepoch()*1000+999 AND g.expires>unixepoch()*1000+999
    AND instr(' '||g.scope||' ',' '||?||' ')>0)` : '';
  const authParams = authorization ? [authorization.accessHash, authorization.grantId, uid, authorization.scope] : [];
  const claim = cur
    ? db.prepare(`UPDATE states SET rev=?, wid=?, chunks=?, bytes=?, sha256=?, updated=?
        WHERE user_id=? AND rev=? AND wid=?${authSQL}`).bind(...fields, uid, cur._rev, cur._wid, ...authParams)
    : db.prepare(`INSERT INTO states (rev,wid,chunks,bytes,sha256,updated,user_id)
        SELECT ?,?,?,?,?,?,? WHERE 1=1${authSQL} ON CONFLICT(user_id) DO NOTHING`).bind(...fields, uid, ...authParams);
  // D1 batch is a transaction. The CAS is checked INSIDE it, and every following write is
  // gated by the new random write id. A lost race cannot delete or insert a single chunk.
  // Any SQL failure rolls back the manifest, deletion and every inserted chunk together.
  const result = await db.batch([
    claim,
    db.prepare(`DELETE FROM state_chunks WHERE user_id=?
      AND EXISTS (SELECT 1 FROM states WHERE user_id=? AND wid=?)`).bind(uid, uid, wid),
    ...chunks.map((data, n) => db.prepare(`INSERT INTO state_chunks(user_id,wid,n,data)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM states WHERE user_id=? AND wid=?)`)
      .bind(uid, wid, n, data, uid, wid)),
    ...(receipt ? [db.prepare(`INSERT INTO mcp_receipts(user_id,key_hash,payload_hash,result,created)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM states WHERE user_id=? AND wid=?)`)
      .bind(uid, receipt.keyHash, receipt.payloadHash, JSON.stringify(receipt.result), Date.now(), uid, wid)] : [])
  ]);
  return result[0].meta.changes === 1;
}
