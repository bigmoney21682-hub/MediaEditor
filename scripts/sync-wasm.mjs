// Copies the MediaPipe SIMD WebAssembly runtime out of node_modules and into
// public/, so it ships as a same-origin asset the service worker can cache.
// Vendoring the 11MB binary in git would only duplicate the npm dependency, and
// copying it here keeps it locked to the installed version.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const to = join(root, 'public/mediapipe/wasm');

if (!existsSync(from)) {
  console.error('MediaPipe wasm not found — run `npm install` first.');
  process.exit(1);
}

mkdirSync(to, { recursive: true });
// SIMD build only; every browser that can run this app supports it.
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  const src = join(from, f), dst = join(to, f);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log(`synced ${f} (${(statSync(dst).size / 1e6).toFixed(1)} MB)`);
}
