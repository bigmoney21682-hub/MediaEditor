import { makeCanvas } from '../util.js';

/**
 * Piecewise-affine mesh warp.
 *
 * For every triangle we solve the affine map taking its source vertices to its
 * destination vertices, clip to the destination triangle, and blit. Triangles
 * are nudged outwards by `grow` px around their centroid so neighbouring blits
 * overlap slightly and no hairline seams show through.
 */
export function warpImage(src, srcPts, dstPts, tris, { grow = 0.6 } = {}) {
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  for (let i = 0; i < tris.length; i += 3) {
    const i0 = tris[i], i1 = tris[i + 1], i2 = tris[i + 2];
    const s = [srcPts[i0], srcPts[i1], srcPts[i2]];
    const d = [dstPts[i0], dstPts[i1], dstPts[i2]];
    const m = affine(s, d);
    if (!m) continue;
    const dg = growTri(d, grow);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dg[0].x, dg[0].y);
    ctx.lineTo(dg[1].x, dg[1].y);
    ctx.lineTo(dg[2].x, dg[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }
  return out;
}

function growTri(t, g) {
  const cx = (t[0].x + t[1].x + t[2].x) / 3;
  const cy = (t[0].y + t[1].y + t[2].y) / 3;
  return t.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * g, y: p.y + (dy / len) * g };
  });
}

/** Affine matrix mapping source triangle `s` onto destination triangle `d`. */
function affine(s, d) {
  const [p0, p1, p2] = s, [q0, q1, q2] = d;
  const det = p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y);
  if (Math.abs(det) < 1e-9) return null;
  const a = (q0.x * (p1.y - p2.y) + q1.x * (p2.y - p0.y) + q2.x * (p0.y - p1.y)) / det;
  const c = (p0.x * (q1.x - q2.x) + p1.x * (q2.x - q0.x) + p2.x * (q0.x - q1.x)) / det;
  const e = (p0.x * (p1.y * q2.x - p2.y * q1.x) + p1.x * (p2.y * q0.x - p0.y * q2.x) + p2.x * (p0.y * q1.x - p1.y * q0.x)) / det;
  const b = (q0.y * (p1.y - p2.y) + q1.y * (p2.y - p0.y) + q2.y * (p0.y - p1.y)) / det;
  const d2 = (p0.x * (q1.y - q2.y) + p1.x * (q2.y - q0.y) + p2.x * (q0.y - q1.y)) / det;
  const f = (p0.x * (p1.y * q2.y - p2.y * q1.y) + p1.x * (p2.y * q0.y - p0.y * q2.y) + p2.x * (p0.y * q1.y - p1.y * q0.y)) / det;
  return { a, b, c, d: d2, e, f };
}

/** Anchor ring around the image border so the warp decays to identity at edges. */
export function borderPoints(w, h, n = 6) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: t * w, y: 0 }, { x: t * w, y: h }, { x: 0, y: t * h }, { x: w, y: t * h });
  }
  return pts;
}

/** Convex hull (monotone chain) — used to build the face mask outline. */
export function hull(points) {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Smooth closed path through `pts` (Catmull-Rom-ish via midpoint quadratics). */
export function smoothPath(ctx, pts, closed = true) {
  if (pts.length < 3) return;
  ctx.beginPath();
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let prev = pts[pts.length - 1];
  let start = mid(prev, pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], next = pts[(i + 1) % pts.length];
    const m = mid(cur, next);
    ctx.quadraticCurveTo(cur.x, cur.y, m.x, m.y);
  }
  if (closed) ctx.closePath();
}

/** Scale a polygon about its centroid. */
export function inflate(pts, k) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}
