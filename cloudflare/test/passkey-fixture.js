// Entirely synthetic WebAuthn ES256 authenticator. No private key is persisted or used by the app.
import { generateKeyPairSync, createHash, randomBytes, sign } from 'node:crypto';
const hash = b => createHash('sha256').update(b).digest();
const b64 = b => Buffer.from(b).toString('base64url');
function head(major, n) {
  if (n < 24) return Buffer.from([major << 5 | n]);
  if (n < 256) return Buffer.from([major << 5 | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = major << 5 | 25; b.writeUInt16BE(n, 1); return b; }
  throw new Error('fixture value too large');
}
function cbor(v) {
  if (Number.isInteger(v)) return head(v < 0 ? 1 : 0, v < 0 ? -1 - v : v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported fixture value');
}
export function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }), id = randomBytes(32);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  let counter = 0;
  const base = response => ({ id: b64(id), rawId: b64(id), type: 'public-key', response, clientExtensionResults: {} });
  const data = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const authData = (rpID, flags, count) => { const c = Buffer.alloc(4); c.writeUInt32BE(count); return Buffer.concat([hash(rpID), Buffer.from([flags]), c]); };
  return {
    id: b64(id),
    register(options, origin, { uv = true } = {}) {
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
      const a = Buffer.concat([authData(options.rp.id, uv ? 0x45 : 0x41, 0), Buffer.alloc(16), len, id, cose]);
      return base({ clientDataJSON: b64(data('webauthn.create', options.challenge, origin)),
        attestationObject: b64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', a]]))), transports: ['internal'] });
    },
    login(options, origin, { uv = true } = {}) {
      const d = data('webauthn.get', options.challenge, origin), a = authData(options.rpId, uv ? 0x05 : 0x01, ++counter);
      return base({ clientDataJSON: b64(d), authenticatorData: b64(a), signature: b64(sign('sha256', Buffer.concat([a, hash(d)]), privateKey)), userHandle: null });
    }
  };
}
