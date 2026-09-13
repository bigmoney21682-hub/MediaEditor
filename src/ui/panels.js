import {
  doc, selected, layerById, pushHistory, emit, removeLayer, moveLayer, reorderLayer,
  addLayer, makeDrawLayer, beforePixels
} from '../state.js';
import { requestRender, measureText } from '../render.js';
import { tools, setTool, crop, setCropAspect, endCrop, editText, cut, cutReady, applyCut, clearCut, undoCutStroke } from '../tools.js';
import { el, row, slider, segmented } from './modal.js';
import { copyCanvas, makeCanvas, toast } from '../util.js';

const BLEND_MODES = [
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'],
  ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'],
  ['luminosity', 'Luminosity']
];

const FONTS = [
  ['Inter, system-ui, -apple-system, sans-serif', 'Sans'],
  ['Georgia, "Times New Roman", serif', 'Serif'],
  ['"SF Mono", ui-monospace, Menlo, monospace', 'Mono'],
  ['"Avenir Next", "Helvetica Neue", sans-serif', 'Avenir'],
  ['Impact, "Haettenschweiler", sans-serif', 'Impact'],
  ['"Comic Sans MS", "Chalkboard SE", cursive', 'Casual']
];

const CROP_ASPECTS = [
  [0, 'Free'], [1, '1:1'], [4 / 5, '4:5'], [3 / 4, '3:4'], [4 / 3, '4:3'],
  [16 / 9, '16:9'], [9 / 16, '9:16'], [3 / 2, '3:2']
];

let onPlaceImage = () => {};
export function setPlaceHandler(fn) { onPlaceImage = fn; }

/* ------------------------------------------------------------ tool panel */

export function renderToolOptions() {
  const host = document.getElementById('tool-options');
  host.replaceChildren();
  const t = tools.current;

  if (crop.active) {
    host.append(
      el('div', { class: 'row stack' },
        el('div', { class: 'chips' }, CROP_ASPECTS.map(([a, label]) => {
          const c = el('button', { class: 'chip' + (crop.aspect === a ? ' active' : '') }, label);
          c.addEventListener('click', () => { setCropAspect(a); renderToolOptions(); });
          return c;
        }))
      ),
      el('div', { class: 'hint' }, 'Drag inside the photo to set the crop, or grab an edge. Enter applies, Esc cancels.')
    );
    return;
  }

  if (t === 'draw' || t === 'erase') {
    const cfg = t === 'draw' ? tools.brush : tools.eraser;
    host.append(slider('Size', { min: 1, max: 400, value: cfg.size, format: (v) => v + 'px', onInput: (v) => (cfg.size = v) }));
    host.append(slider('Softness', {
      min: 0, max: 100, value: Math.round((1 - cfg.hardness) * 100),
      format: (v) => v + '%', onInput: (v) => (cfg.hardness = 1 - v / 100)
    }));
    if (t === 'draw') {
      const color = el('input', { type: 'color', value: tools.brush.color });
      color.addEventListener('input', () => (tools.brush.color = color.value));
      host.append(row('Color', color, swatches((c) => { tools.brush.color = c; color.value = c; })));
      host.append(slider('Opacity', {
        min: 5, max: 100, value: Math.round(tools.brush.opacity * 100),
        format: (v) => v + '%', onInput: (v) => (tools.brush.opacity = v / 100)
      }));
      host.append(el('div', { class: 'hint' }, 'Brush strokes go to their own layer above the photo, so the original stays intact.'));
    } else {
      host.append(el('div', { class: 'hint' }, 'Erases inside the selected layer only.'));
    }
    return;
  }

  if (t === 'rect' || t === 'ellipse' || t === 'line') {
    const s = tools.shape;
    if (t !== 'line') {
      const fill = el('input', { type: 'color', value: s.fill });
      fill.addEventListener('input', () => (s.fill = fill.value));
      const filled = el('input', { type: 'checkbox' });
      filled.checked = s.filled;
      filled.addEventListener('change', () => (s.filled = filled.checked));
      host.append(row('Fill', fill, filled, el('span', { class: 'hint' }, 'filled')));
    }
    const stroke = el('input', { type: 'color', value: s.stroke });
    stroke.addEventListener('input', () => (s.stroke = stroke.value));
    host.append(row('Stroke', stroke, swatches((c) => { s.stroke = c; stroke.value = c; })));
    host.append(slider('Weight', { min: 0, max: 60, value: s.strokeWidth, format: (v) => v + 'px', onInput: (v) => (s.strokeWidth = v) }));
    if (t === 'rect') host.append(slider('Corner', { min: 0, max: 200, value: s.radius, format: (v) => v + 'px', onInput: (v) => (s.radius = v) }));
    if (t === 'line') {
      const arrow = el('input', { type: 'checkbox' });
      arrow.checked = s.arrow;
      arrow.addEventListener('change', () => (s.arrow = arrow.checked));
      host.append(row('Arrow head', arrow));
    }
    const dash = el('input', { type: 'checkbox' });
    dash.checked = s.dash;
    dash.addEventListener('change', () => (s.dash = dash.checked));
    host.append(row('Dashed', dash));
    host.append(el('div', { class: 'hint' }, 'Drag on the canvas. Hold Shift for a perfect square / circle / 45°.'));
    return;
  }

  if (t === 'text') {
    const tx = tools.text;
    host.append(row('Font', selectEl(FONTS, tx.font, (v) => (tx.font = v))));
    host.append(slider('Size', { min: 8, max: 400, value: tx.size, format: (v) => v + 'px', onInput: (v) => (tx.size = v) }));
    const color = el('input', { type: 'color', value: tx.color });
    color.addEventListener('input', () => (tx.color = color.value));
    host.append(row('Color', color, swatches((c) => { tx.color = c; color.value = c; })));
    host.append(row('Align', segmented([['left', 'L'], ['center', 'C'], ['right', 'R']], tx.align, (v) => (tx.align = v))));
    host.append(row('Weight', segmented([[400, 'Reg'], [700, 'Bold'], [900, 'Black']], tx.weight, (v) => (tx.weight = v))));
    const outline = el('input', { type: 'color', value: tx.stroke });
    outline.addEventListener('input', () => (tx.stroke = outline.value));
    host.append(row('Outline', outline));
    host.append(slider('Outline w', { min: 0, max: 24, value: tx.strokeWidth, format: (v) => v + 'px', onInput: (v) => (tx.strokeWidth = v) }));
    host.append(el('div', { class: 'hint' }, 'Click the canvas to place text. Double-click any text to edit it.'));
    return;
  }

  if (t === 'cut') {
    host.append(row('Keep', segmented([['keep', 'Inside'], ['remove', 'Outside']], cut.mode, (v) => { cut.mode = v; requestRender(); })));
    host.append(slider('Soft edge', { min: 0, max: 30, value: cut.feather, format: (v) => v + 'px', onInput: (v) => (cut.feather = v) }));
    const copy = el('input', { type: 'checkbox' });
    copy.checked = cut.newLayer;
    copy.addEventListener('change', () => (cut.newLayer = copy.checked));
    host.append(row('Copy', copy, el('span', { class: 'hint' }, 'cut to a new layer, keep original')));
    if (cutReady()) {
      host.append(el('div', { class: 'chips', style: { margin: '4px 0 8px' } },
        el('button', { class: 'btn primary', onclick: () => applyCut() }, '✂ Cut'),
        el('button', { class: 'btn', onclick: () => undoCutStroke() }, '↶ Back'),
        el('button', { class: 'btn', onclick: () => clearCut() }, 'Clear')));
    }
    host.append(el('div', { class: 'hint' },
      'Trace around the person or object — the magnifier shows the edge under your finger. Pinch to zoom in and trace in pieces: each new stroke carries on the outline, and Back undoes the last one. Press Cut when you\'re round: everything else becomes transparent. For a collage, add photos with Image and cut each one out.'));
    return;
  }

  if (t === 'place') {
    host.append(
      el('button', { class: 'btn', onclick: () => onPlaceImage() }, 'Choose image…'),
      el('div', { class: 'hint', style: { marginTop: '8px' } }, 'Adds a photo as a new layer on top. You can also drag files onto the canvas or paste with ⌘V.')
    );
    return;
  }

  host.append(el('div', { class: 'hint' },
    'Click a layer to select it. Drag to move, grab a handle to resize, use the top dot to rotate. Shift constrains, Alt+drag pans.'));
}

function selectEl(options, value, onChange) {
  const s = el('select', {});
  for (const [v, label] of options) {
    const o = el('option', { value: v }, label);
    if (String(v) === String(value)) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(isNaN(+s.value) || s.value === '' ? s.value : +s.value));
  return s;
}

const SWATCHES = ['#ffffff', '#000000', '#ff4d6d', '#ffd166', '#4ade80', '#7c9cff', '#b98cff', '#ff9f45'];
function swatches(onPick) {
  const wrap = el('div', { class: 'chips', style: { flex: '1' } });
  for (const c of SWATCHES) {
    const b = el('button', {
      class: 'chip',
      title: c,
      style: { background: c, width: '16px', height: '16px', padding: '0', borderRadius: '4px' }
    });
    b.addEventListener('click', () => onPick(c));
    wrap.appendChild(b);
  }
  return wrap;
}

/* ----------------------------------------------------------- layer panel */

const thumbCache = new Map();

function thumbFor(l) {
  const key = l.id + ':' + (l.canvas ? l.canvas.width + 'x' + l.canvas.height : '') + ':' +
    (l.kind === 'text' ? l.text.value + l.text.color : '') +
    (l.kind === 'shape' ? JSON.stringify(l.shape) : '') + ':' + Math.round(l.w) + 'x' + Math.round(l.h);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const size = 34;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const w = Math.max(1, l.w), h = Math.max(1, l.h);
  const k = Math.min(size / w, size / h);
  ctx.translate((size - w * k) / 2, (size - h * k) / 2);
  ctx.scale(k, k);
  const saved = { x: l.x, y: l.y, rot: l.rot, opacity: l.opacity, blend: l.blend };
  Object.assign(l, { x: 0, y: 0, rot: 0, opacity: 1, blend: 'source-over' });
  try {
    // drawLayer is imported lazily to dodge a module cycle with render.js
    layerDrawer(ctx, l);
  } catch { /* thumbnails are cosmetic */ }
  Object.assign(l, saved);
  const url = c.toDataURL();
  if (thumbCache.size > 120) thumbCache.clear();
  thumbCache.set(key, url);
  return url;
}

let layerDrawer = () => {};
export function setLayerDrawer(fn) { layerDrawer = fn; }

export function renderLayers() {
  const host = document.getElementById('layers');
  host.replaceChildren();
  if (!doc.layers.length) {
    host.append(el('li', { class: 'empty' }, 'No layers yet.'));
    return;
  }
  // Top of the stack renders first, like every other editor.
  [...doc.layers].reverse().forEach((l) => {
    const li = el('li', {
      class: 'layer' + (l.id === doc.selection ? ' sel' : ''),
      draggable: 'true',
      'data-id': l.id
    });
    const img = el('img', { class: 'thumb', src: thumbFor(l), alt: '' });
    const eye = el('button', { class: 'eye' + (l.visible ? ' on' : ''), title: l.visible ? 'Hide' : 'Show' }, l.visible ? '👁' : '🚫');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      pushHistory();
      l.visible = !l.visible;
      emit('all');
      requestRender();
    });
    li.append(img, el('div', { class: 'meta' },
      el('span', { class: 'name' }, l.name),
      el('span', { class: 'kind' }, l.locked ? l.kind + ' · locked' : l.kind)
    ), eye);

    li.addEventListener('click', () => {
      doc.selection = l.id;
      emit('layers');
      requestRender();
    });
    li.addEventListener('dblclick', () => { if (l.kind === 'text') editText(l); });

    li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/layer', l.id));
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/layer');
      if (!id || id === l.id) return;
      pushHistory();
      reorderLayer(id, doc.layers.findIndex((x) => x.id === l.id));
      emit('all');
      requestRender();
    });
    host.append(li);
  });
}

/* ---------------------------------------------------------- layer panel 2 */

export function renderLayerOptions() {
  const host = document.getElementById('layer-options');
  host.replaceChildren();
  const l = selected();
  if (!l) {
    host.append(el('div', { class: 'empty' }, 'Select a layer to see its options.'));
    return;
  }

  const name = el('input', { type: 'text', value: l.name });
  name.addEventListener('change', () => { l.name = name.value || l.kind; emit('layers'); });
  host.append(row('Name', name));

  host.append(slider('Opacity', {
    min: 0, max: 100, value: Math.round(l.opacity * 100), format: (v) => v + '%',
    onInput: (v) => { l.opacity = v / 100; requestRender(); }
  }));
  host.append(row('Blend', selectEl(BLEND_MODES, l.blend, (v) => { pushHistory(); l.blend = v; emit('layers'); requestRender(); })));
  host.append(slider('Rotation', {
    min: -180, max: 180, value: Math.round((l.rot * 180) / Math.PI), format: (v) => v + '°',
    onInput: (v) => { l.rot = (v * Math.PI) / 180; requestRender(); }
  }));

  if (l.kind === 'text') {
    const ta = el('textarea', {
      rows: 2,
      style: { width: '100%', background: 'var(--bg-3)', color: 'var(--fg)', border: '1px solid var(--line-2)', borderRadius: '7px', padding: '6px', resize: 'vertical', font: 'inherit' }
    });
    ta.value = l.text.value;
    ta.addEventListener('input', () => {
      l.text.value = ta.value;
      const nat = measureText({ ...l.text, value: ta.value || ' ' });
      const scale = l.w / (l.text.natW || nat.w);
      l.text.natW = nat.w; l.text.natH = nat.h;
      l.w = nat.w * scale; l.h = nat.h * scale;
      requestRender();
    });
    host.append(el('div', { class: 'row stack' }, ta));
  }

  if (l.kind === 'shape') {
    const s = l.shape;
    const fill = el('input', { type: 'color', value: s.fill === 'transparent' ? '#000000' : s.fill });
    fill.addEventListener('input', () => { s.fill = fill.value; requestRender(); });
    const stroke = el('input', { type: 'color', value: s.stroke });
    stroke.addEventListener('input', () => { s.stroke = stroke.value; requestRender(); });
    host.append(row('Fill', fill, stroke, el('span', { class: 'hint' }, 'fill / stroke')));
  }

  const buttons = el('div', { class: 'chips', style: { marginTop: '4px' } });
  const act = (label, title, fn) => {
    const b = el('button', { class: 'btn tiny', title }, label);
    b.addEventListener('click', fn);
    return b;
  };
  buttons.append(
    act('▲', 'Bring forward', () => { pushHistory(); moveLayer(l.id, 1); emit('all'); requestRender(); }),
    act('▼', 'Send backward', () => { pushHistory(); moveLayer(l.id, -1); emit('all'); requestRender(); }),
    act('⧉', 'Duplicate', () => {
      pushHistory();
      const copy = { ...l, id: Math.random().toString(36).slice(2, 10), name: l.name + ' copy', x: l.x + 16, y: l.y + 16 };
      if (l.canvas) copy.canvas = copyCanvas(l.canvas);
      if (l.shape) copy.shape = { ...l.shape };
      if (l.text) copy.text = { ...l.text };
      addLayer(copy, { above: l.id });
      emit('all');
      requestRender();
    }),
    act(l.locked ? '🔒' : '🔓', 'Lock / unlock', () => { l.locked = !l.locked; emit('layers'); }),
    act('⇔', 'Flip horizontally', () => { pushHistory(); flip(l, 'x'); emit('all'); requestRender(); }),
    act('⇕', 'Flip vertically', () => { pushHistory(); flip(l, 'y'); emit('all'); requestRender(); }),
    act('⤢', 'Fit layer to canvas', () => {
      pushHistory();
      const k = Math.max(doc.w / l.w, doc.h / l.h);
      l.w *= k; l.h *= k;
      l.x = (doc.w - l.w) / 2;
      l.y = (doc.h - l.h) / 2;
      l.rot = 0;
      emit('all');
      requestRender();
    })
  );
  const del = act('Delete', 'Delete layer', () => {
    pushHistory();
    removeLayer(l.id);
    emit('all');
    requestRender();
  });
  del.classList.add('danger');
  buttons.append(del);
  host.append(buttons);
}

function flip(l, axis) {
  if (l.canvas) {
    const c = makeCanvas(l.canvas.width, l.canvas.height);
    const ctx = c.getContext('2d');
    ctx.translate(axis === 'x' ? c.width : 0, axis === 'y' ? c.height : 0);
    ctx.scale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1);
    ctx.drawImage(l.canvas, 0, 0);
    l.canvas = c;
    l._shared = false;
  } else if (l.shape && (l.shape.type === 'line' || l.shape.type === 'arrow')) {
    l.shape.dir = l.shape.dir === 'nwse' ? 'nesw' : 'nwse';
  } else {
    toast('Flip applies to image, drawing and line layers.');
  }
}

export function renderAll() {
  renderToolOptions();
  renderLayers();
  renderLayerOptions();
}
