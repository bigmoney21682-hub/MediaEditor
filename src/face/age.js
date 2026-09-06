import { makeCanvas, copyCanvas, clamp, lerp } from '../util.js';
import { triangulate } from './delaunay.js';
import { warpImage, borderPoints, hull, smoothPath, inflate } from './warp.js';
import {
  FACE_OVAL, JAW, LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW, LIPS_OUTER,
  IDX, faceScale, groupPoints
} from './landmarks.js';

/**
 * On-device age transform.
 *
 * This is a *simulation*, not a generative model: it reshapes the face with a
 * landmark-driven mesh warp and layers physically-motivated texture and colour
 * changes (creases, skin detail, pigmentation, hair desaturation) over it.
 * Results read as convincingly older/younger but are not a prediction of how a
 * specific person will actually look. For photoreal output, use the AI backend
 * in `remote.js`.
 *
 * Everything is authored in face-local units (a fraction of the temple-to-temple
 * distance) along the face's own up/right axes, so it is resolution- and
 * rotation-independent.
 */

/** years -> effect amount. 25y is the full-strength anchor. */
export function amountForYears(years) {
  return clamp(0.22 + 0.78 * Math.pow(clamp(years, 0, 40) / 25, 0.78), 0, 1.25);
}

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* ------------------------------------------------------------ face basis */

function basis(pts) {
  const chin = pts[IDX.chin], top = pts[IDX.foreheadTop];
  let ux = top.x - chin.x, uy = top.y - chin.y;
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul; uy /= ul;
  // Right vector is the perpendicular, oriented towards the subject's left eye.
  let rx = -uy, ry = ux;
  const eL = pts[IDX.eyeOuterL], eR = pts[IDX.eyeOuterR];
  if ((eL.x - eR.x) * rx + (eL.y - eR.y) * ry < 0) { rx = -rx; ry = -ry; }
  return { U: { x: ux, y: uy }, R: { x: rx, y: ry }, S: faceScale(pts) };
}

/* --------------------------------------------------------------- geometry */

/**
 * Displace landmarks to age or de-age the face.
 * `a` is the effect amount; `dir` is +1 for older, -1 for younger.
 */
function reshape(pts, a, dir) {
  const { U, R, S } = basis(pts);
  const dst = pts.map((p) => ({ x: p.x, y: p.y }));
  // move point i by `r` (right) and `u` (up) in face-local units of S
  const mv = (i, r, u) => {
    const p = dst[i];
    p.x += (R.x * r + U.x * u) * S;
    p.y += (R.y * r + U.y * u) * S;
  };
  const sideOf = (i) => {
    const p = pts[i], c = pts[IDX.noseTip];
    return Math.sign((p.x - c.x) * R.x + (p.y - c.y) * R.y) || 1;
  };
  const k = a * dir;

  // --- jaw & jowls: gravity pulls the lower face down and out with age
  for (const i of JAW) {
    const p = pts[i];
    // height 0 at chin, 1 at the top of the jaw line
    const h = clamp(((p.x - pts[IDX.chin].x) * U.x + (p.y - pts[IDX.chin].y) * U.y) / (S * 0.62), 0, 1);
    const sag = (1 - Math.abs(h - 0.45) * 1.35) * 0.030;   // strongest at the jowl
    mv(i, sideOf(i) * 0.010 * k * (1 - h), -Math.max(0, sag) * k);
  }
  mv(IDX.chin, 0, -0.014 * k);

  // --- mid-face volume: cheeks fall with age, lift and fill when younger
  for (const i of [IDX.cheekL, IDX.cheekR, 50, 280, 118, 347, 101, 330, 36, 266, 187, 411]) {
    if (!dst[i]) continue;
    mv(i, sideOf(i) * (dir > 0 ? 0.004 : -0.012) * a, -0.024 * k);
  }
  // Temples hollow with age
  mv(IDX.templeL, -0.006 * k, -0.004 * k);
  mv(IDX.templeR, 0.006 * k, -0.004 * k);

  // --- brows and lids droop
  for (const i of [...LEFT_BROW, ...RIGHT_BROW]) mv(i, 0, -0.020 * k);
  for (const i of [386, 385, 384, 387, 388, 159, 158, 157, 160, 161]) mv(i, 0, -0.012 * k);
  // Under-eye hollows deepen
  for (const i of [374, 373, 380, 145, 144, 153]) mv(i, 0, -0.006 * k);
  if (dir < 0) {   // younger: slightly larger, more open eyes
    for (const i of [...LEFT_EYE, ...RIGHT_EYE]) {
      const c = i > 300 ? pts[IDX.eyeInnerL] : pts[IDX.eyeInnerR];
      dst[i].x += (pts[i].x - c.x) * 0.05 * a;
      dst[i].y += (pts[i].y - c.y) * 0.05 * a;
    }
  }

  // --- nose lengthens and widens over a lifetime
  mv(IDX.noseTip, 0, -0.012 * k);
  mv(IDX.noseLeftWing, 0.008 * k, -0.005 * k);
  mv(IDX.noseRightWing, -0.008 * k, -0.005 * k);

  // --- lips thin with age, plump when younger
  const lipC = { x: pts[IDX.mouthTop].x / 2 + pts[IDX.mouthBottom].x / 2, y: pts[IDX.mouthTop].y / 2 + pts[IDX.mouthBottom].y / 2 };
  for (const i of LIPS_OUTER) {
    const p = pts[i];
    dst[i].x += (p.x - lipC.x) * -0.16 * k;
    dst[i].y += (p.y - lipC.y) * -0.16 * k;
  }
  // Mouth corners turn down
  mv(IDX.mouthLeft, 0.004 * k, -0.010 * k);
  mv(IDX.mouthRight, -0.004 * k, -0.010 * k);

  return dst;
}

/* ------------------------------------------------------------------ masks */

function featherMask(w, h, drawFn, blurPx) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${blurPx}px)`;
  ctx.fillStyle = '#fff';
  drawFn(ctx);
  ctx.filter = 'none';
  return c;
}

function faceMask(w, h, pts, { inflateBy = 1.06, feather = 0.06 } = {}) {
  const S = faceScale(pts);
  const poly = inflate(hull(groupPoints(pts, FACE_OVAL)), inflateBy);
  return featherMask(w, h, (ctx) => { smoothPath(ctx, poly); ctx.fill(); }, Math.max(2, S * feather));
}

/** Face mask with eyes, brows, nostrils and lips punched out. */
function skinMask(w, h, pts) {
  const S = faceScale(pts);
  const m = faceMask(w, h, pts, { inflateBy: 1.0, feather: 0.05 });
  const ctx = m.getContext('2d');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.filter = `blur(${Math.max(2, S * 0.035)}px)`;
  ctx.fillStyle = '#fff';
  for (const g of [LEFT_EYE, RIGHT_EYE, LIPS_OUTER, LEFT_BROW, RIGHT_BROW]) {
    smoothPath(ctx, inflate(hull(groupPoints(pts, g)), 1.35));
    ctx.fill();
  }
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  return m;
}

/** Rough hair region: a head-sized ellipse minus the face, keyed to dark pixels. */
function hairMask(src, pts) {
  const w = src.width, h = src.height;
  const { U, R, S } = basis(pts);
  const top = pts[IDX.foreheadTop], chin = pts[IDX.chin];
  const cx = top.x - U.x * S * 0.10, cy = top.y - U.y * S * 0.10;

  const m = makeCanvas(w, h);
  const ctx = m.getContext('2d');
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(U.y, U.x) + Math.PI / 2);
  ctx.filter = `blur(${S * 0.07}px)`;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(0, 0, S * 0.80, S * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Punch the face out so skin never grays.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.filter = `blur(${S * 0.05}px)`;
  smoothPath(ctx, inflate(hull(groupPoints(pts, FACE_OVAL)), 0.98));
  ctx.fill();
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';

  // Key on luminance inside the ellipse's bounding box: hair is darker than sky,
  // walls and most backgrounds, so this keeps the effect off the background.
  const x0 = clamp(Math.floor(cx - S), 0, w), y0 = clamp(Math.floor(cy - S), 0, h);
  const bw = clamp(Math.ceil(S * 2), 1, w - x0), bh = clamp(Math.ceil(S * 2), 1, h - y0);
  const md = ctx.getImageData(x0, y0, bw, bh);
  const sd = src.getContext('2d').getImageData(x0, y0, bw, bh);
  for (let i = 0; i < md.data.length; i += 4) {
    if (!md.data[i + 3]) continue;
    const luma = (sd.data[i] * 0.299 + sd.data[i + 1] * 0.587 + sd.data[i + 2] * 0.114) / 255;
    const key = clamp(1.35 - luma * 1.7, 0, 1);   // full effect under ~0.2 luma
    md.data[i + 3] = md.data[i + 3] * key;
  }
  ctx.putImageData(md, x0, y0);
  // Anything outside the sampled box can't be hair.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0, y0, bw, bh);
  ctx.globalCompositeOperation = 'source-over';
  return m;
}

/** Draw `layer` onto `base` only where `mask` is opaque. */
function compositeMasked(base, layer, mask, alpha = 1, op = 'source-over') {
  const tmp = copyCanvas(layer);
  const t = tmp.getContext('2d');
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(mask, 0, 0);
  const ctx = base.getContext('2d');
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

function filtered(src, filter) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.filter = filter;
  ctx.drawImage(src, 0, 0);
  return c;
}

/* --------------------------------------------------------------- wrinkles */

/**
 * Procedural crease overlay: dark lines with a highlight lip below them, which
 * is what actually sells a crease as geometry rather than a drawn line.
 */
function creaseOverlay(w, h, pts, a, seed) {
  const { U, R, S } = basis(pts);
  const dark = makeCanvas(w, h);
  const light = makeCanvas(w, h);
  const dc = dark.getContext('2d');
  const lc = light.getContext('2d');
  const rnd = mulberry32(seed);

  const at = (p, r, u) => ({ x: p.x + (R.x * r + U.x * u) * S, y: p.y + (R.y * r + U.y * u) * S });

  /** Stroke one crease on both the shadow and highlight layers. */
  const crease = (path, width, strength) => {
    for (const [ctx, off, color, mult] of [
      [dc, 0, 'rgba(78,52,40,ALPHA)', 1],
      [lc, 0.006, 'rgba(255,240,225,ALPHA)', 0.55]
    ]) {
      ctx.beginPath();
      const q = path.map((p) => ({ x: p.x - U.x * S * off, y: p.y - U.y * S * off }));
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < q.length - 1; i++) {
        const m = { x: (q[i].x + q[i + 1].x) / 2, y: (q[i].y + q[i + 1].y) / 2 };
        ctx.quadraticCurveTo(q[i].x, q[i].y, m.x, m.y);
      }
      ctx.lineTo(q[q.length - 1].x, q[q.length - 1].y);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(0.7, width * S);
      ctx.strokeStyle = color.replace('ALPHA', (strength * mult).toFixed(3));
      ctx.stroke();
    }
  };

  const browL = pts[IDX.browCenterL], browR = pts[IDX.browCenterR];
  const glab = pts[IDX.glabella];
  const browMid = { x: (browL.x + browR.x) / 2, y: (browL.y + browR.y) / 2 };

  // 1. Forehead bands, spaced across the real brow-to-hairline gap so they
  //    never ride up into the hair on a low forehead.
  const hairline = pts[IDX.foreheadTop];
  const foreheadH = Math.max(0.12, ((hairline.x - browMid.x) * U.x + (hairline.y - browMid.y) * U.y) / S);
  const bands = a > 0.75 ? 4 : a > 0.45 ? 3 : 2;
  for (let i = 0; i < bands; i++) {
    const up = foreheadH * (0.26 + i * (0.52 / Math.max(1, bands - 1)) * 0.92);
    const span = 0.30 - i * 0.018;
    const path = [];
    for (let t = -1; t <= 1.001; t += 0.25) {
      const bow = (1 - t * t) * foreheadH * 0.09;
      path.push(at(browMid, t * span, up + bow + (rnd() - 0.5) * 0.008));
    }
    crease(path, 0.0085, 0.30 * a * (1 - i * 0.13));
  }

  // 2. Glabellar (frown) lines
  for (const s of [-1, 1]) {
    crease([at(glab, s * 0.035, -0.02), at(glab, s * 0.045, 0.06), at(glab, s * 0.038, 0.12)],
      0.0075, 0.26 * a);
  }

  // 3. Crow's feet
  for (const [eye, s] of [[pts[IDX.eyeOuterL], 1], [pts[IDX.eyeOuterR], -1]]) {
    for (let i = 0; i < 3; i++) {
      const ang = 0.055 - i * 0.055;
      crease(
        [at(eye, s * 0.012, ang * 0.4), at(eye, s * 0.075, ang), at(eye, s * 0.135, ang * 1.5)],
        0.006, 0.30 * a * (1 - i * 0.12)
      );
    }
  }

  // 4. Under-eye creases
  for (const [eye, s] of [[pts[IDX.eyeUnderL], 1], [pts[IDX.eyeUnderR], -1]]) {
    crease([at(eye, -s * 0.06, -0.030), at(eye, 0, -0.042), at(eye, s * 0.07, -0.030)], 0.0065, 0.22 * a);
    if (a > 0.7) crease([at(eye, -s * 0.05, -0.062), at(eye, 0, -0.072), at(eye, s * 0.06, -0.060)], 0.006, 0.14 * a);
  }

  // 5. Nasolabial folds — the single strongest ageing cue
  for (const [wing, corner, s] of [
    [pts[IDX.noseLeftWing], pts[IDX.mouthLeft], 1],
    [pts[IDX.noseRightWing], pts[IDX.mouthRight], -1]
  ]) {
    crease([
      at(wing, s * 0.012, 0.010),
      at(wing, s * 0.055, -0.055),
      { x: corner.x + R.x * S * s * 0.045, y: corner.y + R.y * S * s * 0.045 },
      at(corner, s * 0.055, -0.060)
    ], 0.011, 0.40 * a);
  }

  // 6. Marionette lines (from the mouth corners toward the jaw)
  if (a > 0.5) {
    for (const [corner, s] of [[pts[IDX.mouthLeft], 1], [pts[IDX.mouthRight], -1]]) {
      crease([at(corner, s * 0.02, -0.02), at(corner, s * 0.035, -0.09), at(corner, s * 0.030, -0.15)],
        0.008, 0.24 * (a - 0.5) * 2);
    }
  }

  // 7. Perioral (upper-lip) lines, only at high ages
  if (a > 0.85) {
    const lipTop = pts[IDX.mouthTop];
    for (let i = -3; i <= 3; i++) {
      if (!i) continue;
      const x = i * 0.020 + (rnd() - 0.5) * 0.006;
      crease([at(lipTop, x, 0.012), at(lipTop, x * 1.08, 0.045)], 0.0045, 0.16 * (a - 0.85) * 6);
    }
  }

  // 8. Neck/jaw slack under the chin
  if (a > 0.6) {
    const chin = pts[IDX.chin];
    crease([at(chin, -0.16, -0.10), at(chin, 0, -0.135), at(chin, 0.16, -0.10)], 0.010, 0.16 * a);
  }

  // Soften: real creases are not hairlines.
  const soft = (c) => filtered(c, `blur(${Math.max(0.6, S * 0.004)}px)`);
  return { dark: soft(dark), light: soft(light) };
}

/** Age spots / uneven pigmentation across the cheeks, temples and forehead. */
function pigmentOverlay(w, h, pts, a, seed) {
  const { U, R, S } = basis(pts);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed ^ 0x9e37);
  const anchors = [pts[IDX.cheekL], pts[IDX.cheekR], pts[IDX.templeL], pts[IDX.templeR], pts[IDX.foreheadTop]];
  const count = Math.round(34 * a);
  for (let i = 0; i < count; i++) {
    const base = anchors[Math.floor(rnd() * anchors.length)];
    const x = base.x + (R.x * (rnd() - 0.5) * 0.34 + U.x * (rnd() - 0.5) * 0.30) * S;
    const y = base.y + (R.y * (rnd() - 0.5) * 0.34 + U.y * (rnd() - 0.5) * 0.30) * S;
    const r = S * (0.006 + rnd() * 0.016);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const alpha = (0.05 + rnd() * 0.10) * a;
    g.addColorStop(0, `rgba(120,84,54,${alpha.toFixed(3)})`);
    g.addColorStop(1, 'rgba(120,84,54,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** Warm flush on the cheeks — reads as youthful circulation. */
function blushOverlay(w, h, pts, a) {
  const { S } = basis(pts);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  for (const p of [pts[IDX.cheekL], pts[IDX.cheekR]]) {
    const r = S * 0.30;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, `rgba(255,126,120,${(0.075 * a).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(255,126,120,${(0.038 * a).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,126,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** High-pass of `src` at 50% grey — composite with overlay to add/remove detail. */
function highPass(src, radius) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);          // = 255 - blur
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.5;
  ctx.drawImage(src, 0, 0);                       // = 127 + (src - blur)/2
  return c;
}

/* -------------------------------------------------------------- pipeline */

/**
 * @param {HTMLCanvasElement} src
 * @param {{years:number, direction:'older'|'younger', faces:Array, strength?:number,
 *          skinTexture?:boolean, hair?:boolean, geometry?:boolean}} opts
 */
export function ageTransform(src, opts) {
  const {
    years = 10, direction = 'older', faces = [], strength = 1,
    skinTexture = true, hair = true, geometry = true
  } = opts;
  const dir = direction === 'younger' ? -1 : 1;
  const a = clamp(amountForYears(years) * strength, 0, 1.4);
  const w = src.width, h = src.height;

  let work = copyCanvas(src);

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face.pts) { work = regionOnly(work, face, a, dir); continue; }
    const pts = face.pts;
    const S = faceScale(pts);
    const seed = Math.round(pts[IDX.noseTip].x * 7919 + pts[IDX.chin].y * 104729) + fi;

    // 1. Geometry
    if (geometry) {
      const dstPts = reshape(pts, a, dir);
      const anchors = borderPoints(w, h, 8);
      const srcAll = pts.concat(anchors);
      const dstAll = dstPts.concat(anchors);
      const tris = triangulate(srcAll);
      work = warpImage(work, srcAll, dstAll, tris);
    }

    const skin = skinMask(w, h, pts);
    const full = faceMask(w, h, pts);

    // 2. Skin texture
    if (skinTexture) {
      if (dir > 0) {
        // Older: amplify pore/line detail, then lay creases and pigment over it.
        const hp = highPass(work, Math.max(1.2, S * 0.012));
        compositeMasked(work, hp, skin, clamp(0.42 * a, 0, 0.55), 'overlay');
        const { dark, light } = creaseOverlay(w, h, pts, a, seed);
        compositeMasked(work, light, skin, 0.85, 'source-over');
        compositeMasked(work, dark, skin, 0.95, 'multiply');
        compositeMasked(work, pigmentOverlay(w, h, pts, a, seed), skin, 0.9, 'multiply');
      } else {
        // Younger: edge-preserving-ish smoothing — blur the skin, then put a
        // little real detail back so it doesn't turn plastic.
        const soft = filtered(work, `blur(${Math.max(1, S * 0.016 * a)}px)`);
        compositeMasked(work, soft, skin, clamp(0.72 * a, 0, 0.86));
        const hp = highPass(work, Math.max(1, S * 0.010));
        compositeMasked(work, hp, skin, 0.16 * a, 'overlay');
        compositeMasked(work, blushOverlay(w, h, pts, a), skin, 1, 'source-over');
      }
    }

    // 3. Colour: skin loses saturation and warmth-evenness with age
    const grade = dir > 0
      ? `saturate(${(1 - 0.20 * a).toFixed(3)}) contrast(${(1 - 0.05 * a).toFixed(3)}) sepia(${(0.12 * a).toFixed(3)}) brightness(${(1 - 0.035 * a).toFixed(3)})`
      : `saturate(${(1 + 0.14 * a).toFixed(3)}) contrast(${(1 + 0.05 * a).toFixed(3)}) brightness(${(1 + 0.045 * a).toFixed(3)})`;
    compositeMasked(work, filtered(work, grade), full, clamp(0.85 * a, 0, 0.9));

    // 4. Hair
    if (hair) {
      const hm = hairMask(work, pts);
      if (dir > 0) {
        const gray = filtered(work, `grayscale(1) brightness(${(1 + 0.55 * a).toFixed(3)}) contrast(0.82)`);
        compositeMasked(work, gray, hm, clamp(a * a * 0.95, 0, 0.95));
      } else {
        const rich = filtered(work, `saturate(1.25) brightness(${(1 - 0.16 * a).toFixed(3)}) contrast(1.08)`);
        compositeMasked(work, rich, hm, clamp(0.55 * a, 0, 0.6));
      }
    }
  }

  return work;
}

/** No landmarks: grade and texture an elliptical region only. */
function regionOnly(src, face, a, dir) {
  const w = src.width, h = src.height;
  const b = face.box;
  const S = Math.max(b.w, b.h);
  const mask = featherMask(w, h, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w * 0.58, b.h * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
  }, Math.max(3, S * 0.09));

  const work = copyCanvas(src);
  if (dir > 0) {
    compositeMasked(work, highPass(work, Math.max(1.2, S * 0.010)), mask, clamp(0.40 * a, 0, 0.5), 'overlay');
    compositeMasked(work, filtered(work, `saturate(${1 - 0.22 * a}) sepia(${0.14 * a}) brightness(${1 - 0.05 * a}) contrast(${1 - 0.04 * a})`), mask, 0.9 * a);
  } else {
    compositeMasked(work, filtered(work, `blur(${Math.max(1, S * 0.012 * a)}px)`), mask, clamp(0.62 * a, 0, 0.78));
    compositeMasked(work, filtered(work, `saturate(${1 + 0.16 * a}) brightness(${1 + 0.05 * a}) contrast(1.04)`), mask, 0.85 * a);
  }
  return work;
}
