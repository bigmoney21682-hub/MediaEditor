import { FilesetResolver, ImageSegmenter, InteractiveSegmenter } from '@mediapipe/tasks-vision';
import { makeCanvas } from '../util.js';

/**
 * On-device background removal, on the same MediaPipe runtime as the face tools.
 *   - people:  selfie multiclass segmenter (hair, body, face, clothes, accessories)
 *   - objects: MagicTouch interactive segmenter, pointed at one spot
 * Both return a mask canvas at the source's pixel size whose alpha is the
 * probability that a pixel belongs to the subject.
 */

const url = (p) => new URL(p, document.baseURI).href;
const WORK = 1024;   // models run far below this anyway; bigger only costs time

let filesetPromise = null;
const fileset = () => (filesetPromise ??= FilesetResolver.forVisionTasks(url('mediapipe/wasm')));

async function create(Task, model, extra) {
  const fs = await fileset();
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: url('models/' + model), delegate },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
    ...extra
  });
  try { return await Task.createFromOptions(fs, opts('GPU')); }
  catch { return await Task.createFromOptions(fs, opts('CPU')); }
}

const lazy = (make) => {
  let p = null;
  return () => (p ??= make().catch((e) => { p = null; throw e; }));
};
const people = lazy(() => create(ImageSegmenter, 'selfie_multiclass_256x256.tflite'));
const objects = lazy(() => create(InteractiveSegmenter, 'magic_touch.tflite'));

let peopleReady = false, objectsReady = false;
/** True if the model still has to download (first use), so the UI can say so. */
export const needsDownload = (kind) => !(kind === 'person' ? peopleReady : objectsReady);

/** Work on a copy no bigger than WORK px; returns it plus the factor back to source. */
function workingCopy(src) {
  const k = Math.min(1, WORK / Math.max(src.width, src.height));
  if (k === 1) return src;
  const c = makeCanvas(Math.round(src.width * k), Math.round(src.height * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Float probabilities (w×h) → mask canvas at `outW×outH`. A gentle contrast
 * curve firms up the model's mushy edges without making them jagged, and the
 * upscale is smoothed so the low-res mask doesn't show its pixels.
 */
function probToMask(prob, w, h, outW, outH) {
  const small = makeCanvas(w, h);
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < prob.length; i++) {
    const t = Math.min(1, Math.max(0, (prob[i] - 0.3) / 0.4));
    d[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  sctx.putImageData(img, 0, 0);
  const out = makeCanvas(outW, outH);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, outW, outH);
  return out;
}

/** Fraction of the mask that is confidently subject. */
function coverage(prob) {
  let n = 0;
  for (let i = 0; i < prob.length; i++) if (prob[i] > 0.5) n++;
  return n / prob.length;
}

/** Mask of every person in `src`, or null when nobody is found. */
export async function segmentPeople(src) {
  const seg = await people();
  peopleReady = true;
  const res = seg.segment(workingCopy(src));
  try {
    const bg = res.confidenceMasks?.[0];
    if (!bg) return null;
    const p = bg.getAsFloat32Array();
    const fg = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) fg[i] = 1 - p[i];   // class 0 is background
    if (coverage(fg) < 0.004) return null;
    return probToMask(fg, bg.width, bg.height, src.width, src.height);
  } finally {
    res.close?.();
  }
}

/** Mask of the object at (u, v), both 0..1 across `src`. Null if nothing sensible. */
export async function segmentObjectAt(src, u, v) {
  const seg = await objects();
  objectsReady = true;
  const res = seg.segment(workingCopy(src), { keypoint: { x: u, y: v } });
  try {
    const m = res.confidenceMasks?.[0];
    if (!m) return null;
    const p = m.getAsFloat32Array();
    const cov = coverage(p);
    if (cov < 0.002 || cov > 0.97) return null;
    return probToMask(p, m.width, m.height, src.width, src.height);
  } finally {
    res.close?.();
  }
}

/** Bounding box of the mask's visible pixels, or null if it's empty. */
export function maskBounds(mask) {
  // Scan a reduced copy; exact edges don't matter, the box gets padded.
  const k = Math.min(1, 512 / Math.max(mask.width, mask.height));
  const w = Math.max(1, Math.round(mask.width * k)), h = Math.max(1, Math.round(mask.height * k));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, w, h);
  const a = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 2;
  const X0 = Math.max(0, Math.floor((x0 - pad) / k)), Y0 = Math.max(0, Math.floor((y0 - pad) / k));
  const X1 = Math.min(mask.width, Math.ceil((x1 + 1 + pad) / k)), Y1 = Math.min(mask.height, Math.ceil((y1 + 1 + pad) / k));
  return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
}
