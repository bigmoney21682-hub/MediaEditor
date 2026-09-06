/**
 * Bowyer–Watson Delaunay triangulation.
 * Input: [{x,y}, ...]  Output: flat index triples [i0,i1,i2, i0,i1,i2, ...]
 *
 * n is a few hundred landmarks, so the straightforward O(n²) form is plenty.
 */
export function triangulate(points) {
  const n = points.length;
  if (n < 3) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1, dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;

  // Super-triangle vertices live at the end of a working copy of the point list.
  const pts = points.concat([
    { x: mx - dmax, y: my - dmax },
    { x: mx + dmax, y: my - dmax },
    { x: mx, y: my + dmax }
  ]);
  const s0 = n, s1 = n + 1, s2 = n + 2;

  let tris = [{ a: s0, b: s1, c: s2, ...circum(pts[s0], pts[s1], pts[s2]) }];

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const edges = [];
    const keep = [];
    for (const t of tris) {
      const ddx = p.x - t.cx, ddy = p.y - t.cy;
      if (ddx * ddx + ddy * ddy <= t.r2 + 1e-9) {
        edges.push([t.a, t.b], [t.b, t.c], [t.c, t.a]);
      } else {
        keep.push(t);
      }
    }
    // Edges shared by two removed triangles are interior; only the hull remains.
    for (let e = 0; e < edges.length; e++) {
      if (!edges[e]) continue;
      let shared = false;
      for (let f = e + 1; f < edges.length; f++) {
        if (!edges[f]) continue;
        if ((edges[e][0] === edges[f][1] && edges[e][1] === edges[f][0]) ||
            (edges[e][0] === edges[f][0] && edges[e][1] === edges[f][1])) {
          edges[f] = null;
          shared = true;
        }
      }
      if (!shared) {
        const [a, b] = edges[e];
        keep.push({ a, b, c: i, ...circum(pts[a], pts[b], p) });
      }
    }
    tris = keep;
  }

  const out = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;   // drop super-triangle fans
    out.push(t.a, t.b, t.c);
  }
  return out;
}

function circum(a, b, c) {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return { cx: 0, cy: 0, r2: Infinity };
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
}
