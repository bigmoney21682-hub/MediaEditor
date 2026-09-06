// Generates the PWA PNG icons with no image deps: rasterize by hand, encode with zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Smooth coverage from a signed distance in pixels — cheap analytic antialiasing.
const cover = (d) => clamp01(0.5 - d);

function draw(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const pad = maskable ? 96 * s : 40 * s;   // maskable keeps art inside the safe zone
  const r = maskable ? 0 : 112 * s;         // maskable fills the square; normal is squircle-ish
  const cx = size / 2, cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded-rect plate
      const qx = Math.abs(x + 0.5 - cx) - (size / 2 - (maskable ? 0 : 24 * s));
      const qy = Math.abs(y + 0.5 - cy) - (size / 2 - (maskable ? 0 : 24 * s));
      const plate = cover(Math.hypot(Math.max(qx + r, 0), Math.max(qy + r, 0)) - r);
      const t = y / size;
      let R = lerp(24, 12, t), G = lerp(28, 18, t), B = lerp(38, 24, t);

      // Photo frame
      const fx0 = pad, fy0 = pad + 26 * s, fx1 = size - pad, fy1 = size - pad - 26 * s;
      const inFrame = x > fx0 && x < fx1 && y > fy0 && y < fy1;
      if (inFrame) {
        const u = (x - fx0) / (fx1 - fx0), v = (y - fy0) / (fy1 - fy0);
        // Sky-to-violet gradient "photo"
        R = lerp(lerp(86, 168, u), 232, v * 0.55);
        G = lerp(lerp(120, 96, u), 148, v * 0.55);
        B = lerp(lerp(246, 232, u), 250, v * 0.55);
        // Sun
        const ds = Math.hypot(x - (fx0 + (fx1 - fx0) * 0.72), y - (fy0 + (fy1 - fy0) * 0.3)) - 44 * s;
        const sun = cover(ds);
        R = lerp(R, 255, sun); G = lerp(G, 236, sun); B = lerp(B, 170, sun);
        // Mountain ridge
        const mw = fx1 - fx0;
        const ridge = fy1 - (fy1 - fy0) * (0.16 + 0.42 * Math.exp(-Math.pow((x - (fx0 + mw * 0.42)) / (mw * 0.26), 2))
          + 0.3 * Math.exp(-Math.pow((x - (fx0 + mw * 0.75)) / (mw * 0.2), 2)));
        const m = cover(ridge - y);
        R = lerp(R, 30, m); G = lerp(G, 44, m); B = lerp(B, 68, m);
        // Frame border
        const edge = Math.min(x - fx0, fx1 - x, y - fy0, fy1 - y);
        const border = 1 - cover(edge - 7 * s);
        R = lerp(R, 244, border); G = lerp(G, 246, border); B = lerp(B, 252, border);
      }

      // Pen nib accent, bottom-right
      const px0 = size - pad - 150 * s, py0 = size - pad - 150 * s;
      const dx = x - px0, dy = y - py0;
      const along = (dx + dy) / Math.SQRT2, across = (dy - dx) / Math.SQRT2;
      const nib = cover(Math.max(Math.abs(across) - lerp(34 * s, 2 * s, clamp01(along / (150 * s))), -along)) *
                  cover(along - 150 * s);
      R = lerp(R, 255, nib * 0.96); G = lerp(G, 209, nib * 0.96); B = lerp(B, 102, nib * 0.96);

      px[i] = Math.round(R); px[i + 1] = Math.round(G); px[i + 2] = Math.round(B);
      px[i + 3] = Math.round(255 * plate);
    }
  }
  return encodePNG(size, size, px);
}

mkdirSync('public/icons', { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-512-maskable.png', 512, true],
  ['apple-touch-icon.png', 180, true]
]) {
  writeFileSync(`public/icons/${name}`, draw(size, maskable));
  console.log('wrote public/icons/' + name);
}
