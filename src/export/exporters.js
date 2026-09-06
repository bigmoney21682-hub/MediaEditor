import { doc } from '../state.js';
import { renderDoc, drawLayer, measureText, textFont, textLines } from '../render.js';
import { makeCanvas, canvasToBlob, download, stamp, clamp, loadImage, canvasFromImage } from '../util.js';

export const RASTER = {
  png:  { mime: 'image/png',  ext: 'png',  alpha: true,  label: 'PNG' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg',  alpha: false, label: 'JPEG' },
  webp: { mime: 'image/webp', ext: 'webp', alpha: true,  label: 'WebP' }
};

/** Formats the browser can actually encode right now. */
export function supportedRaster() {
  const probe = makeCanvas(2, 2);
  return Object.entries(RASTER).filter(([, f]) =>
    f.mime === 'image/png' || probe.toDataURL(f.mime).startsWith('data:' + f.mime)
  ).map(([k]) => k);
}

export function flatten({ scale = 1, format = 'png', bg = '#ffffff' } = {}) {
  const needsBg = !RASTER[format]?.alpha;
  return renderDoc({ scale, background: needsBg ? bg : null });
}

export async function exportRaster({ format = 'png', scale = 1, quality = 0.92, bg = '#ffffff', name }) {
  const f = RASTER[format];
  if (!f) throw new Error('Unknown format: ' + format);
  const canvas = flatten({ scale, format, bg });
  const blob = await canvasToBlob(canvas, f.mime, f.mime === 'image/png' ? undefined : quality);
  download(blob, `${name || 'mediaeditor-' + stamp()}.${f.ext}`);
  return blob;
}

/* -------------------------------------------------------------------- PDF */

export async function exportPDF({ scale = 2, quality = 0.94, bg = '#ffffff', name, pageSize = 'fit', orientation = 'auto' }) {
  const { jsPDF } = await import('jspdf');
  const canvas = flatten({ scale, format: 'jpeg', bg });
  const imgW = doc.w, imgH = doc.h;

  let pdf, x = 0, y = 0, w, h;
  if (pageSize === 'fit') {
    // Page exactly matches the artwork — no letterboxing.
    const orient = imgW >= imgH ? 'landscape' : 'portrait';
    pdf = new jsPDF({ unit: 'pt', format: [imgW * 0.75, imgH * 0.75], orientation: orient, compress: true });
    w = pdf.internal.pageSize.getWidth();
    h = pdf.internal.pageSize.getHeight();
  } else {
    const orient = orientation === 'auto' ? (imgW >= imgH ? 'landscape' : 'portrait') : orientation;
    pdf = new jsPDF({ unit: 'pt', format: pageSize, orientation: orient, compress: true });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const k = Math.min((pw - margin * 2) / imgW, (ph - margin * 2) / imgH);
    w = imgW * k; h = imgH * k;
    x = (pw - w) / 2; y = (ph - h) / 2;
  }
  pdf.addImage(canvas.toDataURL('image/jpeg', quality), 'JPEG', x, y, w, h, undefined, 'FAST');
  pdf.save(`${name || 'mediaeditor-' + stamp()}.pdf`);
}

/* -------------------------------------------------------------------- SVG */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** True vector output: shapes and text stay editable; rasters are embedded. */
export function buildSVG() {
  const parts = [];
  for (const l of doc.layers) {
    if (!l.visible || l.opacity <= 0 || l.w <= 0 || l.h <= 0) continue;
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    const tf = `translate(${l.x.toFixed(2)} ${l.y.toFixed(2)})` +
      (l.rot ? ` rotate(${((l.rot * 180) / Math.PI).toFixed(3)} ${(l.w / 2).toFixed(2)} ${(l.h / 2).toFixed(2)})` : '');
    const attrs = `transform="${tf}" opacity="${l.opacity}"` +
      (l.blend && l.blend !== 'source-over' ? ` style="mix-blend-mode:${cssBlend(l.blend)}"` : '');

    if (l.canvas) {
      parts.push(`<g ${attrs}><image x="0" y="0" width="${l.w.toFixed(2)}" height="${l.h.toFixed(2)}" preserveAspectRatio="none" href="${l.canvas.toDataURL('image/png')}"/></g>`);
    } else if (l.kind === 'shape') {
      parts.push(`<g ${attrs}>${svgShape(l)}</g>`);
    } else if (l.kind === 'text') {
      parts.push(`<g ${attrs}>${svgText(l)}</g>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${doc.w}" height="${doc.h}" viewBox="0 0 ${doc.w} ${doc.h}">
${parts.join('\n')}
</svg>`;
}

function cssBlend(op) {
  return { 'source-over': 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
    darken: 'darken', lighten: 'lighten', 'color-dodge': 'color-dodge', 'color-burn': 'color-burn',
    'hard-light': 'hard-light', 'soft-light': 'soft-light', difference: 'difference',
    exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
    luminosity: 'luminosity' }[op] || 'normal';
}

function svgShape(l) {
  const s = l.shape, w = l.w, h = l.h;
  const common = `fill="${s.fill && s.fill !== 'transparent' ? s.fill : 'none'}" stroke="${s.stroke && s.strokeWidth > 0 ? s.stroke : 'none'}" stroke-width="${s.strokeWidth || 0}" stroke-linecap="round" stroke-linejoin="round"` +
    (s.dash ? ` stroke-dasharray="${(s.strokeWidth * 2.4).toFixed(1)} ${(s.strokeWidth * 2.2).toFixed(1)}"` : '');
  if (s.type === 'line' || s.type === 'arrow') {
    const [x1, y1, x2, y2] = s.dir === 'nesw' ? [0, h, w, 0] : [0, 0, w, h];
    let out = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" fill="none" stroke="${s.stroke}" stroke-width="${s.strokeWidth}" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.strokeWidth * 2.4} ${s.strokeWidth * 2.2}"` : ''}/>`;
    if (s.type === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1), len = Math.max(9, s.strokeWidth * 3.4);
      const p = (o) => `${(x2 - len * Math.cos(a + o)).toFixed(2)},${(y2 - len * Math.sin(a + o)).toFixed(2)}`;
      out += `<polygon points="${x2},${y2} ${p(-0.42)} ${p(0.42)}" fill="${s.stroke}"/>`;
    }
    return out;
  }
  const i = (s.strokeWidth || 0) / 2;
  if (s.type === 'ellipse') {
    return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0.5, w / 2 - i)}" ry="${Math.max(0.5, h / 2 - i)}" ${common}/>`;
  }
  const r = Math.min(s.radius || 0, w / 2 - i, h / 2 - i);
  return `<rect x="${i}" y="${i}" width="${Math.max(1, w - i * 2)}" height="${Math.max(1, h - i * 2)}" rx="${Math.max(0, r)}" ${common}/>`;
}

function svgText(l) {
  const t = l.text;
  const nat = t.natW && t.natH ? { w: t.natW, h: t.natH } : measureText(t);
  const sx = l.w / nat.w, sy = l.h / nat.h;
  const lh = t.size * (t.lineHeight || 1.25);
  const ax = t.align === 'center' ? nat.w / 2 : t.align === 'right' ? nat.w : 0;
  const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
  const pad = t.strokeWidth || 0;
  const lines = textLines(t).map((line, i) =>
    `<tspan x="${(ax + pad).toFixed(2)}" y="${(pad + i * lh + t.size * 0.82).toFixed(2)}">${esc(line)}</tspan>`
  ).join('');
  const strokeAttr = t.strokeWidth > 0 ? ` stroke="${t.stroke}" stroke-width="${t.strokeWidth * 2}" paint-order="stroke fill" stroke-linejoin="round"` : '';
  const bg = t.bg && t.bg !== 'transparent' ? `<rect x="0" y="0" width="${nat.w}" height="${nat.h}" fill="${t.bg}"/>` : '';
  return `<g transform="scale(${sx.toFixed(5)} ${sy.toFixed(5)})">${bg}<text font-family="${esc(t.font)}" font-size="${t.size}" font-weight="${t.weight || 400}"${t.italic ? ' font-style="italic"' : ''} fill="${t.color}" text-anchor="${anchor}"${strokeAttr}>${lines}</text></g>`;
}

export function exportSVG({ name } = {}) {
  const blob = new Blob([buildSVG()], { type: 'image/svg+xml' });
  download(blob, `${name || 'mediaeditor-' + stamp()}.svg`);
}

/* ------------------------------------------------------------------ video */

const VIDEO_MIMES = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/mp4', ext: 'mp4', label: 'MP4' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm', label: 'WebM (VP9)' },
  { mime: 'video/webm;codecs=vp8', ext: 'webm', label: 'WebM (VP8)' },
  { mime: 'video/webm', ext: 'webm', label: 'WebM' }
];

export function bestVideoFormat() {
  if (typeof MediaRecorder === 'undefined') return null;
  return VIDEO_MIMES.find((v) => MediaRecorder.isTypeSupported(v.mime)) || null;
}

export const VIDEO_MODES = {
  kenburns: 'Ken Burns (slow zoom)',
  pan: 'Pan across',
  reveal: 'Build up layers',
  compare: 'Before / after dissolve'
};

/**
 * Render an animation of the document and encode it with MediaRecorder.
 *
 * MediaRecorder timestamps frames by wall clock, so the animation is driven by
 * elapsed real time rather than a frame counter: the clip always comes out at
 * `seconds` long, and a slow machine drops frames instead of stretching it.
 */
export async function exportVideo({
  mode = 'kenburns', seconds = 5, fps = 30, maxWidth = 1280,
  compareWith = null, bg = '#000000', name, onProgress = () => {}
} = {}) {
  const fmt = bestVideoFormat();
  if (!fmt) throw new Error('This browser cannot record video (MediaRecorder unavailable).');

  const k = Math.min(1, maxWidth / doc.w);
  // Even dimensions: H.264 encoders reject odd ones.
  const W = Math.max(2, Math.round((doc.w * k) / 2) * 2);
  const H = Math.max(2, Math.round((doc.h * k) / 2) * 2);

  const base = mode === 'reveal' ? null : renderDoc({ scale: k, background: bg });
  // "Before" for the dissolve is the untouched bottom layer; "after" is the
  // finished composite, so the clip shows the edit arriving.
  const after = mode === 'compare' ? (compareWith || base) : null;
  const before = mode === 'compare' ? renderBaseLayerOnly(k, bg) : null;

  const out = makeCanvas(W, H);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: Math.round(W * H * fps * 0.09) });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => { rec.onstop = res; });

  const ease = (t) => t * t * (3 - 2 * t);

  const drawFrame = (t) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (mode === 'reveal') {
      const n = doc.layers.length || 1;
      ctx.save();
      ctx.scale(k, k);
      doc.layers.forEach((l, i) => {
        const start = (i / n) * 0.75;
        const p = clamp((t - start) / 0.25, 0, 1);
        if (p <= 0) return;
        const saved = l.opacity;
        l.opacity = saved * ease(p);
        drawLayer(ctx, l);
        l.opacity = saved;
      });
      ctx.restore();
    } else if (mode === 'compare') {
      ctx.drawImage(before, 0, 0, W, H);
      // Hold, dissolve, hold — so both states are readable.
      ctx.globalAlpha = ease(clamp((t - 0.3) / 0.4, 0, 1));
      ctx.drawImage(after, 0, 0, W, H);
      ctx.globalAlpha = 1;
    } else {
      const zoom = mode === 'pan' ? 1.16 : 1 + 0.2 * ease(t);
      const dw = W * zoom, dh = H * zoom;
      const px = mode === 'pan' ? ease(t) : 0.5;
      ctx.drawImage(base, -(dw - W) * px, -(dh - H) * 0.5, dw, dh);
    }
    track.requestFrame();
  };

  drawFrame(0);
  rec.start(200);   // emit chunks as we go so the tail flush stays short

  // Paced with setTimeout, not requestAnimationFrame: the recording canvas is
  // offscreen, so there is no vsync to ride, and rAF gets throttled when the
  // page has nothing visible to paint. The delay is recomputed from the clock
  // each step, so the clip lands on `seconds` even if a frame runs long.
  const durMs = Math.max(500, seconds * 1000);
  const frameMs = 1000 / fps;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const elapsed = performance.now() - t0;
      if (elapsed >= durMs) { drawFrame(1); onProgress(1); resolve(); return; }
      drawFrame(elapsed / durMs);
      onProgress(elapsed / durMs);
      const next = Math.ceil((elapsed + 0.5) / frameMs) * frameMs;
      setTimeout(step, Math.max(0, next - (performance.now() - t0)));
    };
    step();
  });

  // Let the encoder take the final frame, then flush.
  await new Promise((r) => setTimeout(r, 60));
  rec.requestData();
  rec.stop();
  await stopped;
  track.stop();

  const blob = new Blob(chunks, { type: fmt.mime.split(';')[0] });
  download(blob, `${name || 'mediaeditor-' + stamp()}.${fmt.ext}`);
  return { blob, format: fmt };
}

/** The document with only its bottom layer visible — the "before" state. */
function renderBaseLayerOnly(scale, bg) {
  const c = makeCanvas(doc.w * scale, doc.h * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  if (doc.layers[0]) drawLayer(ctx, doc.layers[0]);
  return c;
}

/* ---------------------------------------------------------------- project */

export function saveProject(name) {
  const data = {
    app: 'MediaEditor', version: 1, w: doc.w, h: doc.h,
    layers: doc.layers.map((l) => ({
      kind: l.kind, name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, rot: l.rot,
      opacity: l.opacity, blend: l.blend, visible: l.visible, locked: l.locked,
      shape: l.shape, text: l.text,
      image: l.canvas ? l.canvas.toDataURL('image/png') : undefined
    }))
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${name || 'mediaeditor-' + stamp()}.mediaeditor.json`);
}

export async function loadProject(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'MediaEditor') throw new Error('That is not a MediaEditor project file.');
  const layers = [];
  for (const l of data.layers) {
    const layer = { ...l, id: Math.random().toString(36).slice(2, 10) };
    if (l.image) {
      layer.canvas = canvasFromImage(await loadImage(l.image));
      delete layer.image;
    }
    layers.push(layer);
  }
  return { w: data.w, h: data.h, layers };
}
