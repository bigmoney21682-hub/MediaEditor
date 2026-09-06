import { doc, view } from './state.js';
import { dpr, makeCanvas, rotatePoint } from './util.js';

/* ----------------------------------------------------------- coordinates */

export const toScreen = (x, y) => ({ x: x * view.zoom + view.x, y: y * view.zoom + view.y });
export const toDoc = (x, y) => ({ x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom });

/** The four corners of a layer's box in doc space, rotation applied. */
export function layerCorners(l) {
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  return [
    [l.x, l.y], [l.x + l.w, l.y], [l.x + l.w, l.y + l.h], [l.x, l.y + l.h]
  ].map(([x, y]) => rotatePoint(x, y, cx, cy, l.rot));
}

/** Doc-space point -> the layer's un-rotated local box space. */
export function toLocal(l, x, y) {
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  const p = rotatePoint(x, y, cx, cy, -l.rot);
  return { x: p.x - l.x, y: p.y - l.y };
}

export function hitLayer(l, x, y) {
  const p = toLocal(l, x, y);
  return p.x >= 0 && p.y >= 0 && p.x <= l.w && p.y <= l.h;
}

/** Topmost visible, unlocked layer under a doc-space point. */
export function pickLayer(x, y) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible || l.locked) continue;
    if (hitLayer(l, x, y)) return l;
  }
  return null;
}

/* ------------------------------------------------------------- layer draw */

function drawShape(ctx, l) {
  const s = l.shape, w = l.w, h = l.h;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = s.strokeWidth || 0;
  ctx.strokeStyle = s.stroke || 'transparent';
  ctx.fillStyle = s.fill || 'transparent';
  if (s.dash) ctx.setLineDash([s.strokeWidth * 2.4, s.strokeWidth * 2.2]);

  if (s.type === 'line' || s.type === 'arrow') {
    // Local diagonal; `dir` remembers which way the user dragged.
    const [x1, y1, x2, y2] = s.dir === 'nesw' ? [0, h, w, 0] : [0, 0, w, h];
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (s.type === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.max(9, (s.strokeWidth || 2) * 3.4);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(a - 0.42), y2 - len * Math.sin(a - 0.42));
      ctx.lineTo(x2 - len * Math.cos(a + 0.42), y2 - len * Math.sin(a + 0.42));
      ctx.closePath();
      ctx.fillStyle = s.stroke || '#fff';
      ctx.fill();
    }
    return;
  }

  const inset = (s.strokeWidth || 0) / 2;
  ctx.beginPath();
  if (s.type === 'ellipse') {
    ctx.ellipse(w / 2, h / 2, Math.max(0.5, w / 2 - inset), Math.max(0.5, h / 2 - inset), 0, 0, Math.PI * 2);
  } else {
    const r = Math.min(s.radius || 0, w / 2 - inset, h / 2 - inset);
    ctx.roundRect(inset, inset, Math.max(1, w - inset * 2), Math.max(1, h - inset * 2), Math.max(0, r));
  }
  if (s.fill && s.fill !== 'transparent') ctx.fill();
  if (s.strokeWidth > 0 && s.stroke && s.stroke !== 'transparent') ctx.stroke();
}

export function textFont(t) {
  return `${t.italic ? 'italic ' : ''}${t.weight || 400} ${t.size}px ${t.font}`;
}

export function textLines(t) {
  return String(t.value ?? '').split('\n');
}

/** Natural (unscaled) pixel size of a text block. Also used to size its box. */
export function measureText(t) {
  const ctx = makeCanvas(1, 1).getContext('2d');
  ctx.font = textFont(t);
  const lines = textLines(t);
  const w = Math.max(1, ...lines.map((s) => ctx.measureText(s).width));
  const lh = t.size * (t.lineHeight || 1.25);
  return { w: Math.ceil(w + (t.strokeWidth || 0) * 2 + 2), h: Math.ceil(lh * lines.length + (t.strokeWidth || 0) * 2) };
}

function drawText(ctx, l) {
  const t = l.text;
  const nat = t.natW && t.natH ? { w: t.natW, h: t.natH } : measureText(t);
  ctx.scale(l.w / nat.w, l.h / nat.h);   // box scaling drives visual size

  const lines = textLines(t);
  const lh = t.size * (t.lineHeight || 1.25);
  ctx.font = textFont(t);
  ctx.textBaseline = 'top';
  ctx.textAlign = t.align || 'left';
  const ax = t.align === 'center' ? nat.w / 2 : t.align === 'right' ? nat.w : 0;
  const pad = (t.strokeWidth || 0);

  if (t.bg && t.bg !== 'transparent') {
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, nat.w, nat.h);
  }
  lines.forEach((line, i) => {
    const y = pad + i * lh;
    if (t.strokeWidth > 0 && t.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = t.stroke;
      ctx.strokeText(line, ax + pad, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, ax + pad, y);
  });
}

export function drawLayer(ctx, l) {
  if (!l.visible || l.opacity <= 0 || l.w <= 0 || l.h <= 0) return;
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.globalCompositeOperation = l.blend || 'source-over';
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  ctx.translate(cx, cy);
  if (l.rot) ctx.rotate(l.rot);
  ctx.translate(-l.w / 2, -l.h / 2);

  if (l.canvas) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(l.canvas, 0, 0, l.w, l.h);
  } else if (l.kind === 'shape') {
    drawShape(ctx, l);
  } else if (l.kind === 'text') {
    drawText(ctx, l);
  }
  ctx.restore();
}

/** Flatten the document to a fresh canvas at `scale`. No UI chrome. */
export function renderDoc({ scale = 1, background = null } = {}) {
  const c = makeCanvas(doc.w * scale, doc.h * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, doc.w, doc.h);
  }
  for (const l of doc.layers) drawLayer(ctx, l);
  return c;
}

/* ---------------------------------------------------------- screen canvas */

let canvas, ctx, overlayFn = null;
export function attach(el) {
  canvas = el;
  ctx = el.getContext('2d');
}
export function setOverlay(fn) { overlayFn = fn; }
export const stageSize = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });

export function fitView(pad = 40) {
  const { w, h } = stageSize();
  if (!doc.w || !doc.h) return;
  view.zoom = Math.min((w - pad * 2) / doc.w, (h - pad * 2) / doc.h, 8);
  centerView();
}

export function centerView() {
  const { w, h } = stageSize();
  view.x = (w - doc.w * view.zoom) / 2;
  view.y = (h - doc.h * view.zoom) / 2;
}

/** Zoom about a screen-space anchor so the point under the cursor stays put. */
export function zoomAt(sx, sy, factor) {
  const before = toDoc(sx, sy);
  view.zoom = Math.max(0.02, Math.min(view.zoom * factor, 32));
  view.x = sx - before.x * view.zoom;
  view.y = sy - before.y * view.zoom;
}

let raf = 0;
export function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; paint(); });
}

function paint() {
  if (!canvas) return;
  const k = dpr();
  const cw = Math.round(canvas.clientWidth * k), ch = Math.round(canvas.clientHeight * k);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!doc.loaded) return;

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.zoom, view.zoom);

  // Page: checkerboard so transparency reads clearly, then the layers.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, doc.w, doc.h);
  ctx.clip();
  const sq = 10 / view.zoom;
  ctx.fillStyle = '#2a2f3a';
  ctx.fillRect(0, 0, doc.w, doc.h);
  ctx.fillStyle = '#333947';
  for (let y = 0; y < doc.h; y += sq) {
    for (let x = ((y / sq) & 1) * sq; x < doc.w; x += sq * 2) ctx.fillRect(x, y, sq, sq);
  }
  for (const l of doc.layers) drawLayer(ctx, l);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1 / view.zoom;
  ctx.strokeRect(0, 0, doc.w, doc.h);
  ctx.restore();

  if (overlayFn) overlayFn(ctx);
}
