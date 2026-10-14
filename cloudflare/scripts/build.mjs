import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'cloudflare/dist');
rmSync(out, { recursive: true, force: true });
execFileSync('npm', ['run', 'build', '--', '--base=/', '--outDir', out], {
  cwd: path.join(root, 'frontend'), stdio: 'inherit', env: {
    ...process.env, VITE_CLOUDFLARE: '1', VITE_DEMO: '0', VITE_MOBILE: '0',
    APP_BUILD: 'cloudflare', VITE_SOURCE_URL: process.env.VITE_SOURCE_URL || 'https://github.com/ralph1869/openGym/tree/feat/cloudflare-d1',
    // Only the licensed repository's unmodified 180 px media can go to a web deployment.
    VITE_CLIP_EXT: 'mp4', APP_MEDIA_DIR: '', VITE_UMAMI_SRC: '', VITE_UMAMI_ID: ''
  }
});
execFileSync(process.execPath, ['scripts/catalogue/stage-media.mjs', out], {
  cwd: root, stdio: 'inherit', env: { ...process.env, APP_MEDIA_DIR: '', VITE_CLIP_EXT: 'mp4' }
});
for (const file of ['LICENSE', 'NOTICE.md']) cpSync(path.join(root, file), path.join(out, file));
writeFileSync(path.join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(self), microphone=(), geolocation=()
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/exercise-media/*
  Cache-Control: public, max-age=86400
`);
let files = 0, max = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else { files++; max = Math.max(max, statSync(p).size); }
  }
}
walk(out);
if (files > 20000 || max > 25 * 1024 * 1024) throw new Error('Static asset limits exceeded for a free Worker');
console.log(`Cloudflare assets: ${files} files, largest ${max} bytes; LICENSE and both notices included.`);
