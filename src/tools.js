import {
  doc, view, selected, layerById, addLayer, pushHistory, emit, beforePixels,
  makeDrawLayer, makeShapeLayer, makeTextLayer, cropTo
} from './state.js';
import {
  toDoc, toScreen, layerCorners, toLocal, pickLayer, requestRender, setOverlay,
  zoomAt, measureText, textFont, textLines
} from './render.js';
import { clamp, rotatePoint, rad, deg, makeCanvas, toast } from './util.js';

export const tools = {
  current: 'select',
  brush: { size: 24, color: '#ff4d6d', opacity: 1, hardness: 0.7, smooth: true },
  eraser: { size: 40, hardness: 0.6 },
  shape: { fill: '#7c9cff', stroke: '#ffffff', strokeWidth: 4, radius: 8, dash: false, arrow: false, filled: true },
  text: {
    font: 'Inter, system-ui, -apple-system, sans-serif', size: 64, weight: 700, italic: false,
    color: '#ffffff', align: 'left', lineHeight: 1.25, stroke: '#000000', strokeWidth: 0, bg: 'transparent'
  }
};

export const crop = { active: false, rect: null, aspect: 0 };  // aspect 0 = free

/** Lasso cut-out: `points` is the drawn outline in doc space, applied to `layerId`. */
export const cut = { points: null, layerId: null, drawing: false, mode: 'keep', feather: 2, newLayer: false };

let el = null;
let onToolChange = () => {};
let onSelectTap = () => {};
const pointers = new Map();
let drag = null;          // active gesture
let pinch = null;
let spaceDown = false;
let hoverHandle = null;

const HANDLE_HIT = 11;

export function initTools(canvasEl, hooks = {}) {
  el = canvasEl;
  onToolChange = hooks.onToolChange || (() => {});
  onSelectTap = hooks.onSelectTap || (() => {});
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDblClick);
  window.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceDown = true; });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
  setOverlay(drawOverlay);
}

/** Close any open on-canvas text editor, committing what was typed. */
export function commitText() {
  document.querySelector('.text-editor')?.__commit?.();
}

export function setTool(name) {
  commitText();
  if (tools.current === name) return;
  if (crop.active && name !== 'crop') endCrop(false);
  if (tools.current === 'cut') clearCut();
  tools.current = name;
  if (name === 'crop') beginCrop();
  onToolChange(name);
  requestRender();
}

function localPoint(e) {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* ----------------------------------------------------------- handle model */

/** Selection handles in screen space: 4 corners, 4 edges, 1 rotator. */
function handlesFor(l) {
  const c = layerCorners(l).map((p) => toScreen(p.x, p.y));
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const list = [
    { id: 'nw', ...c[0] }, { id: 'ne', ...c[1] }, { id: 'se', ...c[2] }, { id: 'sw', ...c[3] },
    { id: 'n', ...mid(c[0], c[1]) }, { id: 'e', ...mid(c[1], c[2]) },
    { id: 's', ...mid(c[2], c[3]) }, { id: 'w', ...mid(c[3], c[0]) }
  ];
  const n = list.find((h) => h.id === 'n');
  const s = list.find((h) => h.id === 's');
  const len = Math.hypot(n.x - s.x, n.y - s.y) || 1;
  list.push({ id: 'rot', x: n.x + ((n.x - s.x) / len) * 26, y: n.y + ((n.y - s.y) / len) * 26 });
  return list;
}

function hitHandle(l, p) {
  for (const h of handlesFor(l)) {
    if (Math.hypot(h.x - p.x, h.y - p.y) <= HANDLE_HIT) return h.id;
  }
  return null;
}

function cropHandles() {
  const r = crop.rect;
  const a = toScreen(r.x, r.y), b = toScreen(r.x + r.w, r.y + r.h);
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  return [
    { id: 'nw', x: a.x, y: a.y }, { id: 'ne', x: b.x, y: a.y },
    { id: 'se', x: b.x, y: b.y }, { id: 'sw', x: a.x, y: b.y },
    { id: 'n', x: mx, y: a.y }, { id: 's', x: mx, y: b.y },
    { id: 'w', x: a.x, y: my }, { id: 'e', x: b.x, y: my }
  ];
}

/* ------------------------------------------------------------- pointer io */

function onDown(e) {
  if (!doc.loaded) return;
  // The text tool opens a focused textarea; the click's own default focus
  // handling would immediately steal focus back and discard the empty layer.
  if (tools.current === 'text' && !crop.active) e.preventDefault();
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPoint(e));

  if (pointers.size === 2) {
    // A second finger means zoom, not a half-drawn lasso.
    if (drag?.kind === 'lasso') clearCut();
    startPinch(); drag = null; return;
  }
  if (pointers.size > 2) return;

  const p = localPoint(e);
  const d = toDoc(p.x, p.y);
  commitText();   // clicking the canvas ends any in-place text edit

  // Pan: space, middle button, or the hand-ish fallbacks.
  if (spaceDown || e.button === 1 || (e.button === 0 && e.altKey && tools.current === 'select')) {
    drag = { kind: 'pan', sx: p.x, sy: p.y, vx: view.x, vy: view.y };
    return;
  }

  if (crop.active) return startCropDrag(p, d);

  switch (tools.current) {
    case 'select': return startSelect(p, d, e);
    case 'draw': case 'erase': return startPaint(d, e);
    case 'rect': case 'ellipse': case 'line': return startShape(d, e);
    case 'text': return startText(d);
    case 'cut': return startLasso(p, d);
    default: return;
  }
}

function onMove(e) {
  if (!doc.loaded) return;
  const p = localPoint(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

  if (pinch && pointers.size >= 2) return movePinch();

  if (!drag) {
    // Hover feedback for cursors only.
    const l = selected();
    const prev = hoverHandle;
    hoverHandle = crop.active
      ? (cropHandles().find((h) => Math.hypot(h.x - p.x, h.y - p.y) <= HANDLE_HIT)?.id ?? null)
      : (l && tools.current === 'select' ? hitHandle(l, p) : null);
    if (prev !== hoverHandle) updateCursor();
    return;
  }

  const d = toDoc(p.x, p.y);
  switch (drag.kind) {
    case 'pan':
      view.x = drag.vx + (p.x - drag.sx);
      view.y = drag.vy + (p.y - drag.sy);
      break;
    case 'move': moveLayerDrag(d, e); break;
    case 'scale': scaleLayerDrag(d, e); break;
    case 'rotate': rotateLayerDrag(d, e); break;
    case 'paint': paintTo(d, e); break;
    case 'shape': shapeTo(d, e); break;
    case 'crop-new': case 'crop-move': case 'crop-handle': cropDragTo(d, e); break;
    case 'lasso': lassoTo(p, d); break;
  }
  requestRender();
}

function onUp(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!drag) return;
  if (drag.kind === 'shape' && drag.layer) {
    // Discard accidental zero-size shapes from a plain click.
    if (drag.layer.w < 3 && drag.layer.h < 3) {
      doc.layers.splice(doc.layers.indexOf(drag.layer), 1);
      doc.selection = null;
    }
  }
  if (drag.kind === 'paint' && drag.ctx) drag.ctx.restore();
  if (drag.kind === 'lasso') {
    cut.drawing = false;
    if (cut.points.length < 3) clearCut();
    emit('cut');
  }
  // A tap (no drag) on an object is a request to edit it.
  const tapped = drag.kind === 'move' && drag.l.x === drag.x0 && drag.l.y === drag.y0 ? drag.l : null;
  drag = null;
  emit('all');
  requestRender();
  if (tapped) onSelectTap(tapped);
}

function onWheel(e) {
  if (!doc.loaded) return;
  e.preventDefault();
  const p = localPoint(e);
  if (e.ctrlKey || e.metaKey) {
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
  }
  requestRender();
  emit('view');
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  pinch = {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    vx: view.x, vy: view.y
  };
}

function movePinch() {
  const [a, b] = [...pointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  view.x += mid.x - pinch.mid.x;
  view.y += mid.y - pinch.mid.y;
  zoomAt(mid.x, mid.y, dist / pinch.dist);
  pinch.dist = dist;
  pinch.mid = mid;
  requestRender();
  emit('view');
}

function updateCursor() {
  const map = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', rot: 'grab'
  };
  if (hoverHandle) el.style.cursor = map[hoverHandle];
  else if (tools.current === 'draw' || tools.current === 'erase') el.style.cursor = 'crosshair';
  else if (tools.current === 'select') el.style.cursor = 'default';
  else el.style.cursor = 'crosshair';
}

/* --------------------------------------------------------- select / xform */

function startSelect(p, d, e) {
  const cur = selected();
  const h = cur && cur.visible && !cur.locked ? hitHandle(cur, p) : null;
  if (h) {
    pushHistory();
    if (h === 'rot') {
      const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
      drag = { kind: 'rotate', l: cur, cx, cy, start: Math.atan2(d.y - cy, d.x - cx), rot0: cur.rot };
    } else {
      drag = { kind: 'scale', l: cur, h, box: { x: cur.x, y: cur.y, w: cur.w, h: cur.h }, rot: cur.rot };
    }
    return;
  }
  const hit = pickLayer(d.x, d.y);
  doc.selection = hit ? hit.id : null;
  emit('layers');
  if (hit) {
    pushHistory();
    drag = { kind: 'move', l: hit, ox: d.x - hit.x, oy: d.y - hit.y, x0: hit.x, y0: hit.y };
  }
  requestRender();
}

function moveLayerDrag(d, e) {
  const l = drag.l;
  let nx = d.x - drag.ox, ny = d.y - drag.oy;
  if (e.shiftKey) {   // axis lock
    if (Math.abs(nx - drag.x0) > Math.abs(ny - drag.y0)) ny = drag.y0; else nx = drag.x0;
  }
  l.x = nx; l.y = ny;
}

function scaleLayerDrag(d, e) {
  const l = drag.l, b = drag.box, h = drag.h;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  // Work in the box's un-rotated frame, then re-anchor so the opposite edge stays put.
  const p = rotatePoint(d.x, d.y, cx, cy, -drag.rot);
  let { x, y, w: bw, h: bh } = b;
  let x2 = x + bw, y2 = y + bh;
  if (h.includes('w')) x = Math.min(p.x, x2 - 4);
  if (h.includes('e')) x2 = Math.max(p.x, x + 4);
  if (h.includes('n')) y = Math.min(p.y, y2 - 4);
  if (h.includes('s')) y2 = Math.max(p.y, y + 4);
  let nw = x2 - x, nh = y2 - y;

  const corner = h.length === 2;
  const keepAspect = corner ? !e.shiftKey : e.shiftKey;
  if (keepAspect && b.w > 0 && b.h > 0) {
    const k = Math.max(nw / b.w, nh / b.h);
    const aw = b.w * k, ah = b.h * k;
    if (h.includes('w')) x = x2 - aw; else x2 = x + aw;
    if (h.includes('n')) y = y2 - ah; else y2 = y + ah;
    nw = aw; nh = ah;
  }

  // Rotating about the box centre moves the centre when the box resizes;
  // compensate so the grabbed handle tracks the cursor.
  const ncx = x + nw / 2, ncy = y + nh / 2;
  const shifted = rotatePoint(ncx, ncy, cx, cy, drag.rot);
  l.w = nw; l.h = nh;
  l.x = shifted.x - nw / 2;
  l.y = shifted.y - nh / 2;
}

function rotateLayerDrag(d, e) {
  const l = drag.l;
  const a = Math.atan2(d.y - drag.cy, d.x - drag.cx);
  let r = drag.rot0 + (a - drag.start);
  if (e.shiftKey) r = rad(Math.round(deg(r) / 15) * 15);
  l.rot = r;
}

/* --------------------------------------------------------------- painting */

/** Canvas transform that maps doc-space coords into a layer's own pixels. */
function docToLayerPixels(ctx, l) {
  const cw = l.canvas.width, ch = l.canvas.height;
  ctx.scale(cw / l.w, ch / l.h);
  ctx.translate(l.w / 2, l.h / 2);
  ctx.rotate(-l.rot);
  ctx.translate(-(l.x + l.w / 2), -(l.y + l.h / 2));
}

function startPaint(d, e) {
  const erasing = tools.current === 'erase';
  let target = selected();

  if (erasing) {
    if (!target || !target.canvas) return;
  } else if (!target || !target.canvas || target.kind === 'image') {
    // Never paint straight onto a photo — stack a drawing layer above it.
    pushHistory();
    target = addLayer(makeDrawLayer(doc.w, doc.h), { above: target?.id });
    emit('layers');
  } else {
    pushHistory();
  }
  if (!erasing && target._shared !== false) beforePixels(target);
  if (erasing) { pushHistory(); beforePixels(target); }

  const ctx = target.canvas.getContext('2d');
  ctx.save();
  docToLayerPixels(ctx, target);
  const cfg = erasing ? tools.eraser : tools.brush;
  ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = erasing ? '#000' : tools.brush.color;
  ctx.globalAlpha = erasing ? 1 : tools.brush.opacity;
  ctx.lineWidth = cfg.size;
  // Soft edges: a low-alpha wide pass under the core stroke.
  drag = { kind: 'paint', l: target, ctx, pts: [d], cfg, erasing, last: d };
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(d.x + 0.01, d.y + 0.01);
  ctx.stroke();
}

function paintTo(d, e) {
  const s = drag;
  s.pts.push(d);
  const n = s.pts.length;
  const ctx = s.ctx;
  const soft = 1 - (s.cfg.hardness ?? 0.7);
  ctx.lineWidth = s.cfg.size;
  ctx.beginPath();
  if (n >= 3 && tools.brush.smooth) {
    // Quadratic through midpoints keeps fast strokes from going polygonal.
    const a = s.pts[n - 3], b = s.pts[n - 2], c = s.pts[n - 1];
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
  } else {
    ctx.moveTo(s.last.x, s.last.y);
    ctx.lineTo(d.x, d.y);
  }
  if (soft > 0.02) {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.35;
    ctx.lineWidth = s.cfg.size * (1 + soft * 0.55);
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = s.cfg.size * (1 - soft * 0.3);
  }
  ctx.stroke();
  s.last = d;
}

/* ----------------------------------------------------------------- shapes */

function startShape(d, e) {
  pushHistory();
  const t = tools.shape;
  const type = tools.current === 'line' ? (t.arrow ? 'arrow' : 'line') : tools.current;
  const layer = makeShapeLayer({
    type,
    fill: type === 'line' || type === 'arrow' || !t.filled ? 'transparent' : t.fill,
    stroke: t.stroke,
    strokeWidth: t.strokeWidth,
    radius: t.radius,
    dash: t.dash,
    dir: 'nwse'
  });
  layer.x = d.x; layer.y = d.y; layer.w = 0; layer.h = 0;
  addLayer(layer);
  drag = { kind: 'shape', layer, ox: d.x, oy: d.y };
  emit('layers');
}

function shapeTo(d, e) {
  const { layer, ox, oy } = drag;
  let w = d.x - ox, h = d.y - oy;
  if (e.shiftKey) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m;
  }
  layer.shape.dir = (w < 0) !== (h < 0) ? 'nesw' : 'nwse';
  layer.x = Math.min(ox, ox + w);
  layer.y = Math.min(oy, oy + h);
  layer.w = Math.abs(w);
  layer.h = Math.abs(h);
}

/* ------------------------------------------------------------------- text */

function startText(d) {
  const hit = pickLayer(d.x, d.y);
  if (hit && hit.kind === 'text') { doc.selection = hit.id; editText(hit); return; }
  pushHistory();
  const t = { ...tools.text, value: '' };
  const layer = makeTextLayer(t);
  const nat = measureText({ ...t, value: 'Text' });
  t.natW = nat.w; t.natH = nat.h;
  layer.x = d.x; layer.y = d.y; layer.w = nat.w; layer.h = nat.h;
  addLayer(layer);
  emit('layers');
  editText(layer, true);
}

function onDblClick(e) {
  if (!doc.loaded || crop.active) return;
  const p = localPoint(e);
  const d = toDoc(p.x, p.y);
  const hit = pickLayer(d.x, d.y);
  if (hit && hit.kind === 'text') { doc.selection = hit.id; emit('layers'); editText(hit); }
}

/** Floating textarea aligned to the layer box, so typing happens in place. */
export function editText(layer, isNew = false) {
  const t = layer.text;
  const existing = document.querySelector('.text-editor');
  if (existing) existing.remove();

  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = t.value;
  ta.spellcheck = false;
  const stage = el.parentElement;
  const place = () => {
    const p = toScreen(layer.x, layer.y);
    const scale = (layer.w / (t.natW || layer.w)) * view.zoom;
    Object.assign(ta.style, {
      position: 'absolute',
      left: p.x + 'px',
      top: p.y + 'px',
      transformOrigin: '0 0',
      transform: `rotate(${layer.rot}rad) scale(${scale})`,
      width: Math.max(120, (t.natW || 200) + 24) + 'px',
      height: Math.max(t.size * 1.4, (t.natH || 80) + 8) + 'px',
      font: textFont(t),
      lineHeight: t.lineHeight,
      color: t.color,
      background: 'rgba(10,12,18,.55)',
      border: '1px solid #7c9cff',
      borderRadius: '4px',
      outline: 'none',
      padding: '0',
      margin: '0',
      resize: 'none',
      overflow: 'hidden',
      textAlign: t.align,
      zIndex: 30,
      caretColor: t.color
    });
  };
  place();
  stage.appendChild(ta);
  // pointerdown was prevented, so nothing will steal this focus; the extra
  // pass on the next frame covers browsers that defer focus after a click.
  ta.focus();
  ta.select();
  requestAnimationFrame(() => {
    if (ta.isConnected && document.activeElement !== ta) { ta.focus(); ta.select(); }
  });

  const sync = () => {
    t.value = ta.value;
    const nat = measureText({ ...t, value: ta.value || ' ' });
    const scale = layer.w / (t.natW || nat.w);   // keep any manual box scaling
    t.natW = nat.w; t.natH = nat.h;
    layer.w = nat.w * scale;
    layer.h = nat.h * scale;
    layer.name = (ta.value.split('\n')[0] || 'Text').slice(0, 20);
    ta.style.height = Math.max(t.size * 1.4, nat.h + 8) + 'px';
    ta.style.width = Math.max(120, nat.w + 24) + 'px';
    // Update the list label in place; a full re-render would steal focus.
    const label = document.querySelector(`.layer[data-id="${layer.id}"] .name`);
    if (label) label.textContent = layer.name;
    requestRender();
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') ta.blur();
  });
  const born = performance.now();
  let closed = false;
  const finish = () => {
    if (closed || !ta.isConnected) return;
    closed = true;
    sync();
    if (isNew && !t.value.trim()) {
      doc.layers.splice(doc.layers.indexOf(layer), 1);
      doc.selection = null;
    }
    ta.remove();
    emit('all');
    requestRender();
  };
  ta.__commit = finish;
  ta.addEventListener('blur', () => {
    // A blur in the first moments with nothing typed is the opening click
    // settling, not the user leaving — take the focus back.
    if (!ta.value && performance.now() - born < 250) { ta.focus(); return; }
    finish();
  });
}

/* ------------------------------------------------------------------- crop */

export function beginCrop() {
  crop.active = true;
  crop.rect = { x: 0, y: 0, w: doc.w, h: doc.h };
  emit('crop');
  requestRender();
}

export function endCrop(apply) {
  if (apply && crop.rect && crop.rect.w > 1 && crop.rect.h > 1) {
    pushHistory();
    cropTo(crop.rect);
  }
  crop.active = false;
  crop.rect = null;
  emit('crop');
  requestRender();
}

export function setCropAspect(a) {
  crop.aspect = a;
  if (a > 0 && crop.rect) {
    const r = crop.rect;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let w = r.w, h = w / a;
    if (h > doc.h) { h = doc.h; w = h * a; }
    if (w > doc.w) { w = doc.w; h = w / a; }
    crop.rect = clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
  }
  requestRender();
}

function clampRect(r) {
  const w = clamp(r.w, 8, doc.w), h = clamp(r.h, 8, doc.h);
  return { x: clamp(r.x, 0, doc.w - w), y: clamp(r.y, 0, doc.h - h), w, h };
}

function startCropDrag(p, d) {
  const h = cropHandles().find((x) => Math.hypot(x.x - p.x, x.y - p.y) <= HANDLE_HIT);
  const r = crop.rect;
  if (h) { drag = { kind: 'crop-handle', h: h.id, box: { ...r } }; return; }
  if (d.x >= r.x && d.x <= r.x + r.w && d.y >= r.y && d.y <= r.y + r.h) {
    drag = { kind: 'crop-move', ox: d.x - r.x, oy: d.y - r.y };
    return;
  }
  drag = { kind: 'crop-new', ox: d.x, oy: d.y };
}

function cropDragTo(d, e) {
  if (drag.kind === 'crop-move') {
    crop.rect = clampRect({ ...crop.rect, x: d.x - drag.ox, y: d.y - drag.oy });
    return;
  }
  if (drag.kind === 'crop-new') {
    let w = d.x - drag.ox, h = d.y - drag.oy;
    if (crop.aspect > 0) h = Math.sign(h || 1) * (Math.abs(w) / crop.aspect);
    crop.rect = clampRect({ x: Math.min(drag.ox, drag.ox + w), y: Math.min(drag.oy, drag.oy + h), w: Math.abs(w), h: Math.abs(h) });
    return;
  }
  const b = drag.box, id = drag.h;
  let x = b.x, y = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
  if (id.includes('w')) x = clamp(d.x, 0, x2 - 8);
  if (id.includes('e')) x2 = clamp(d.x, x + 8, doc.w);
  if (id.includes('n')) y = clamp(d.y, 0, y2 - 8);
  if (id.includes('s')) y2 = clamp(d.y, y + 8, doc.h);
  let r = { x, y, w: x2 - x, h: y2 - y };
  if (crop.aspect > 0) {
    // Preserve the aspect by adjusting the free axis away from the grabbed edge.
    const wantH = r.w / crop.aspect;
    if (id.includes('n')) r.y = y2 - wantH; else r.y = y;
    r.h = wantH;
  }
  crop.rect = clampRect(r);
}

/* ---------------------------------------------------------------- overlay */

function drawOverlay(ctx) {
  if (crop.active && crop.rect) return drawCropOverlay(ctx);
  if (tools.current === 'cut') return drawCutOverlay(ctx);
  const l = selected();
  if (!l || !l.visible || tools.current !== 'select') return;

  const c = layerCorners(l).map((p) => toScreen(p.x, p.y));
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#7c9cff';
  ctx.beginPath();
  ctx.moveTo(c[0].x, c[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
  ctx.closePath();
  ctx.stroke();

  const hs = handlesFor(l);
  const rot = hs.find((h) => h.id === 'rot');
  const n = hs.find((h) => h.id === 'n');
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(rot.x, rot.y);
  ctx.stroke();

  for (const h of hs) {
    ctx.beginPath();
    if (h.id === 'rot') ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
    else ctx.rect(h.x - 4.5, h.y - 4.5, 9, 9);
    ctx.fillStyle = h.id === hoverHandle ? '#7c9cff' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#22304f';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function drawCropOverlay(ctx) {
  const r = crop.rect;
  const a = toScreen(r.x, r.y), b = toScreen(r.x + r.w, r.y + r.h);
  const w = b.x - a.x, h = b.y - a.y;
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,15,.62)';
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.rect(a.x, a.y, w, h);
  ctx.fill('evenodd');

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(a.x, a.y, w, h);

  // Rule-of-thirds guides
  ctx.strokeStyle = 'rgba(255,255,255,.32)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(a.x + (w * i) / 3, a.y); ctx.lineTo(a.x + (w * i) / 3, b.y);
    ctx.moveTo(a.x, a.y + (h * i) / 3); ctx.lineTo(b.x, a.y + (h * i) / 3);
  }
  ctx.stroke();

  for (const hd of cropHandles()) {
    ctx.beginPath();
    ctx.rect(hd.x - 5, hd.y - 5, 10, 10);
    ctx.fillStyle = hd.id === hoverHandle ? '#7c9cff' : '#fff';
    ctx.fill();
    ctx.strokeStyle = '#22304f';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

/* -------------------------------------------------------------- cut out */

const isRaster = (l) => l && l.canvas && l.visible;

function startLasso(p, d) {
  let target = selected();
  if (!isRaster(target) || target.locked) {
    target = null;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (isRaster(l) && !l.locked && hitLayerAt(l, d)) { target = l; break; }
    }
  }
  if (!target) {
    toast('Start the outline on a photo or drawing layer.', 'err');
    return;
  }
  if (doc.selection !== target.id) { doc.selection = target.id; emit('layers'); }
  cut.layerId = target.id;
  cut.points = [d];
  cut.drawing = true;
  drag = { kind: 'lasso', last: p };
  emit('cut');
}

function hitLayerAt(l, d) {
  const q = toLocal(l, d.x, d.y);
  return q.x >= 0 && q.y >= 0 && q.x <= l.w && q.y <= l.h;
}

function lassoTo(p, d) {
  // Thin the path on screen distance so slow fingers don't pile up points.
  if (Math.hypot(p.x - drag.last.x, p.y - drag.last.y) < 3) return;
  drag.last = p;
  cut.points.push(d);
}

export function clearCut() {
  cut.points = null;
  cut.layerId = null;
  cut.drawing = false;
  emit('cut');
  requestRender();
}

export const cutReady = () => !!(cut.points && cut.points.length >= 3 && !cut.drawing && layerById(cut.layerId));

/**
 * Apply the lasso to its layer: pixels outside the outline (or inside, in
 * 'remove' mode) become transparent, then the layer is trimmed to what's left
 * so it moves and scales as a tidy cut-out.
 */
export function applyCut() {
  const src = layerById(cut.layerId);
  if (!cutReady() || !src) return clearCut();
  pushHistory();

  let l = src;
  if (cut.newLayer) {
    l = { ...src, id: Math.random().toString(36).slice(2, 10), name: (src.name + ' cut-out').slice(0, 24), canvas: src.canvas, _shared: true };
    addLayer(l, { above: src.id });
  }

  const cw = l.canvas.width, ch = l.canvas.height;
  const sx = cw / l.w, sy = ch / l.h;
  // Outline in the layer's own pixel space.
  const pts = cut.points.map((d) => { const q = toLocal(l, d.x, d.y); return { x: q.x * sx, y: q.y * sy }; });
  const feather = cut.feather * Math.max(sx, sy);

  // Mask: filled outline, softened with a shadow blur (works where ctx.filter doesn't).
  const mask = makeCanvas(cw, ch);
  const m = mask.getContext('2d');
  const trace = () => {
    m.beginPath();
    m.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) m.lineTo(pts[i].x, pts[i].y);
    m.closePath();
  };
  if (feather > 0.5) {
    const off = cw + ch + feather * 4;
    m.shadowColor = '#000';
    m.shadowBlur = feather;
    m.shadowOffsetX = off;
    m.translate(-off, 0);
    trace();
    m.fill();
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.shadowColor = 'transparent';
  } else {
    trace();
    m.fill();
  }

  const out = makeCanvas(cw, ch);
  const o = out.getContext('2d');
  o.drawImage(l.canvas, 0, 0);
  o.globalCompositeOperation = cut.mode === 'remove' ? 'destination-out' : 'destination-in';
  o.drawImage(mask, 0, 0);

  // Trim to the kept region (keep mode only — removing leaves the frame as is).
  let box = { x: 0, y: 0, w: cw, h: ch };
  if (cut.mode !== 'remove') {
    const pad = Math.ceil(feather * 1.5);
    const x0 = clamp(Math.floor(Math.min(...pts.map((q) => q.x)) - pad), 0, cw);
    const y0 = clamp(Math.floor(Math.min(...pts.map((q) => q.y)) - pad), 0, ch);
    const x1 = clamp(Math.ceil(Math.max(...pts.map((q) => q.x)) + pad), 0, cw);
    const y1 = clamp(Math.ceil(Math.max(...pts.map((q) => q.y)) + pad), 0, ch);
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      toast('The outline missed the layer — nothing to keep.', 'err');
      if (cut.newLayer) doc.layers.splice(doc.layers.indexOf(l), 1);
      clearCut();
      emit('all');
      return;
    }
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const trimmed = makeCanvas(box.w, box.h);
  trimmed.getContext('2d').drawImage(out, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

  // Re-place the smaller box so the kept pixels don't move on screen, rotation included.
  const lw = box.w / sx, lh = box.h / sy;
  const dx = box.x / sx + lw / 2 - l.w / 2, dy = box.y / sy + lh / 2 - l.h / 2;
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  const c = rotatePoint(cx + dx, cy + dy, cx, cy, l.rot);
  l.canvas = trimmed;
  l._shared = false;
  l.w = lw; l.h = lh;
  l.x = c.x - lw / 2; l.y = c.y - lh / 2;

  doc.selection = l.id;
  clearCut();
  setTool('select');
  toast('Cut out. Drag it into place — add more photos with Image to build a collage.', 'ok');
  emit('all');
  requestRender();
}

function drawCutOverlay(ctx) {
  const l = layerById(cut.layerId) || (isRaster(selected()) ? selected() : null);
  ctx.save();
  if (l) {
    const c = layerCorners(l).map((q) => toScreen(q.x, q.y));
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(124,156,255,.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    c.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.stroke();
  }
  if (!cut.points || cut.points.length < 2) return ctx.restore();

  const pts = cut.points.map((d) => toScreen(d.x, d.y));
  const trace = () => {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  };
  if (!cut.drawing) {
    // Preview what goes away.
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(8,10,15,.6)';
    ctx.beginPath();
    if (cut.mode === 'remove') trace();
    else { ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height); trace(); }
    ctx.fill('evenodd');
  }
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.strokeStyle = '#000';
  ctx.beginPath(); trace(); ctx.stroke();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = '#fff';
  ctx.beginPath(); trace(); ctx.stroke();
  ctx.restore();
}
