export const utf8 = new TextEncoder();
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unb64url(text) {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function equalHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
