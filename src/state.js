import { uid, makeCanvas, copyCanvas, clamp } from './util.js';

/**
 * Document model.
 *
 * A doc is `w × h` plus an ordered layer stack (index 0 = bottom).
 * Layers come in two flavours:
 *   - raster (`image`, `draw`) own a <canvas> of their natural pixel size
 *   - vector (`shape`, `text`) carry data re-rendered on every frame
 * Both are placed by the same box transform: x, y, w, h, rot.
 *
 * Undo is snapshot-based. Layer canvases are copy-on-write — a snapshot keeps
 * the same canvas reference, and anything about to touch pixels calls
 * `beforePixels(layer)` first, which swaps in a private copy. So a snapshot
 * costs an object clone, not a full raster copy.
 */

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what = 'all') { for (const fn of listeners) fn(what); }

export const doc = {
  w: 0,
  h: 0,
  layers: [],
  selection: null,   // layer id
  loaded: false
};

export const view = { zoom: 1, x: 0, y: 0 };   // doc -> screen: p * zoom + (x,y)

/* ------------------------------------------------------------------ layers */

function baseLayer(kind, name, props) {
  return {
    id: uid(), kind, name,
    x: 0, y: 0, w: 0, h: 0, rot: 0,
    opacity: 1, blend: 'source-over',
    visible: true, locked: false,
    ...props
  };
}

export function makeImageLayer(canvas, name = 'Image') {
  return baseLayer('image', name, { canvas, w: canvas.width, h: canvas.height });
}

export function makeDrawLayer(w, h, name = 'Drawing') {
  return baseLayer('draw', name, { canvas: makeCanvas(w, h), w, h });
}

export function makeShapeLayer(shape, name) {
  return baseLayer('shape', name || shape.type[0].toUpperCase() + shape.type.slice(1), { shape });
}

export function makeTextLayer(text, name) {
  return baseLayer('text', name || (text.value.slice(0, 18) || 'Text'), { text });
}

export function layerById(id) { return doc.layers.find((l) => l.id === id) || null; }
export function selected() { return doc.selection ? layerById(doc.selection) : null; }

export function addLayer(layer, { select = true, above = null } = {}) {
  const at = above == null ? doc.layers.length : doc.layers.findIndex((l) => l.id === above) + 1;
  doc.layers.splice(at, 0, layer);
  if (select) doc.selection = layer.id;
  return layer;
}

export function removeLayer(id) {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  doc.layers.splice(i, 1);
  if (doc.selection === id) doc.selection = doc.layers[Math.min(i, doc.layers.length - 1)]?.id ?? null;
}

export function moveLayer(id, delta) {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const j = clamp(i + delta, 0, doc.layers.length - 1);
  if (i === j) return;
  doc.layers.splice(j, 0, doc.layers.splice(i, 1)[0]);
}

export function reorderLayer(id, toIndex) {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const [l] = doc.layers.splice(i, 1);
  doc.layers.splice(clamp(toIndex, 0, doc.layers.length), 0, l);
}

/** Copy-on-write guard — call before mutating a raster layer's pixels. */
export function beforePixels(layer) {
  if (layer.canvas && layer._shared) {
    layer.canvas = copyCanvas(layer.canvas);
    layer._shared = false;
  }
  return layer.canvas;
}

/* ----------------------------------------------------------------- history */

const past = [];
const future = [];
const LIMIT = 60;

function snapshotLayer(l) {
  const c = { ...l };
  if (c.shape) c.shape = { ...c.shape, points: c.shape.points ? c.shape.points.map((p) => ({ ...p })) : undefined };
  if (c.text) c.text = { ...c.text };
  if (c.canvas) c._shared = true;   // snapshot and live layer now share pixels
  return c;
}

function snapshot() {
  // Mark every live raster layer shared too, so the next pixel write copies.
  for (const l of doc.layers) if (l.canvas) l._shared = true;
  return { w: doc.w, h: doc.h, selection: doc.selection, layers: doc.layers.map(snapshotLayer) };
}

function restore(s) {
  doc.w = s.w; doc.h = s.h;
  doc.selection = s.selection;
  doc.layers = s.layers.map((l) => ({ ...l, _shared: true }));
}

/** Record the state *before* a mutation. Call, then mutate, then emit(). */
export function pushHistory() {
  past.push(snapshot());
  if (past.length > LIMIT) past.shift();
  future.length = 0;
}

export function undo() {
  if (!past.length) return false;
  future.push(snapshot());
  restore(past.pop());
  emit('all');
  return true;
}

export function redo() {
  if (!future.length) return false;
  past.push(snapshot());
  restore(future.pop());
  emit('all');
  return true;
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;
export function clearHistory() { past.length = 0; future.length = 0; }

/* --------------------------------------------------------------- doc setup */

export function newDocFromCanvas(canvas, name = 'Background') {
  clearHistory();
  doc.w = canvas.width;
  doc.h = canvas.height;
  doc.layers = [makeImageLayer(canvas, name)];
  doc.selection = doc.layers[0].id;
  doc.loaded = true;
}

/** Crop to a doc-space rect: resize the canvas and shift every layer. */
export function cropTo(rect) {
  const x = Math.round(rect.x), y = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  doc.w = w; doc.h = h;
  for (const l of doc.layers) { l.x -= x; l.y -= y; }
}

export function resizeDoc(w, h) {
  const sx = w / doc.w, sy = h / doc.h;
  for (const l of doc.layers) { l.x *= sx; l.y *= sy; l.w *= sx; l.h *= sy; }
  doc.w = Math.max(1, Math.round(w));
  doc.h = Math.max(1, Math.round(h));
}
