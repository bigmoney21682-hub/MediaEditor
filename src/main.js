import './styles.css';
import {
  doc, view, onChange, emit, newDocFromCanvas, addLayer, makeImageLayer, makeDrawLayer,
  pushHistory, undo, redo, canUndo, canRedo, selected, removeLayer, clearHistory, moveLayer
} from './state.js';
import { attach, requestRender, fitView, zoomAt, stageSize, drawLayer, renderDoc } from './render.js';
import { initTools, setTool, tools, crop, endCrop, beginCrop, commitText } from './tools.js';
import { renderAll, renderToolOptions, renderLayers, renderLayerOptions, setPlaceHandler, setLayerDrawer } from './ui/panels.js';
import { openAgeDialog } from './ui/agedialog.js';
import { openExportDialog } from './ui/exportdialog.js';
import { loadProject } from './export/exporters.js';
import { fileToCanvas, toast, fitScale, copyCanvas, clamp } from './util.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');

attach(canvas);
setLayerDrawer(drawLayer);
initTools(canvas, { onToolChange: syncToolButtons });

/* ------------------------------------------------------------ doc loading */

const MAX_DIM = 4096;   // guards against phone photos blowing up memory

async function openFiles(files, { asLayer = false } = {}) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || f.name.endsWith('.json'));
  if (!list.length) return toast('That file type is not supported.', 'err');

  for (const file of list) {
    if (file.name.endsWith('.mediaeditor.json') || file.name.endsWith('.json')) {
      try {
        const p = await loadProject(file);
        clearHistory();
        doc.w = p.w; doc.h = p.h; doc.layers = p.layers;
        doc.selection = p.layers[p.layers.length - 1]?.id ?? null;
        doc.loaded = true;
        afterLoad();
        toast('Project opened.', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      continue;
    }

    let c;
    try { c = await fileToCanvas(file); }
    catch (e) { toast(e.message, 'err'); continue; }

    const k = fitScale(c.width, c.height, MAX_DIM, MAX_DIM, 1);
    if (k < 1) {
      const s = document.createElement('canvas');
      s.width = Math.round(c.width * k);
      s.height = Math.round(c.height * k);
      s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
      c = s;
      toast(`Large photo scaled to ${s.width}×${s.height} for performance.`);
    }

    if (!doc.loaded || (!asLayer && !doc.layers.length)) {
      newDocFromCanvas(c, file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Background');
      afterLoad();
    } else {
      pushHistory();
      const layer = makeImageLayer(c, file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Image');
      // Land it centred at a comfortable size rather than full bleed.
      const s = Math.min((doc.w * 0.6) / c.width, (doc.h * 0.6) / c.height, 1);
      layer.w = c.width * s;
      layer.h = c.height * s;
      layer.x = (doc.w - layer.w) / 2;
      layer.y = (doc.h - layer.h) / 2;
      addLayer(layer);
      emit('all');
      requestRender();
    }
  }
}

function afterLoad() {
  $('dropzone').hidden = true;
  fitView();
  emit('all');
  requestRender();
}

/* ---------------------------------------------------------------- wiring */

$('btn-open').addEventListener('click', () => $('file-input').click());
$('dz-browse').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  openFiles(e.target.files);
  e.target.value = '';
});
$('file-place').addEventListener('change', (e) => {
  openFiles(e.target.files, { asLayer: true });
  e.target.value = '';
});
setPlaceHandler(() => $('file-place').click());

$('btn-undo').addEventListener('click', () => { undo(); requestRender(); });
$('btn-redo').addEventListener('click', () => { redo(); requestRender(); });
$('btn-age').addEventListener('click', () => { commitText(); openAgeDialog(); });
$('btn-export').addEventListener('click', () => { commitText(); openExportDialog(); });
$('btn-menu').addEventListener('click', () => $('panels').classList.toggle('open'));
$('btn-add-layer').addEventListener('click', () => {
  if (!doc.loaded) return toast('Open a photo first.', 'err');
  pushHistory();
  addLayer(makeDrawLayer(doc.w, doc.h, 'Layer ' + (doc.layers.length + 1)));
  emit('all');
  requestRender();
});

for (const b of document.querySelectorAll('.tool')) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}
function syncToolButtons(name) {
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === name);
  $('crop-actions').hidden = !crop.active;
  renderToolOptions();
}
syncToolButtons(tools.current);

$('crop-apply').addEventListener('click', () => { endCrop(true); setTool('select'); fitView(); });
$('crop-cancel').addEventListener('click', () => { endCrop(false); setTool('select'); });

/* ------------------------------------------------------------------ zoom */

const setZoom = (z, anchor) => {
  const { w, h } = stageSize();
  zoomAt(anchor?.x ?? w / 2, anchor?.y ?? h / 2, z / view.zoom);
  requestRender();
  emit('view');
};
$('zoom-in').addEventListener('click', () => setZoom(view.zoom * 1.25));
$('zoom-out').addEventListener('click', () => setZoom(view.zoom / 1.25));
$('zoom-fit').addEventListener('click', () => { fitView(); requestRender(); emit('view'); });

/* ------------------------------------------------------- drag / drop / paste */

const dz = $('dropzone');
const stage = $('stage');
['dragenter', 'dragover'].forEach((ev) =>
  stage.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.hidden = false;
    dz.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  stage.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (doc.loaded) dz.hidden = true;
  })
);
stage.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files, { asLayer: doc.loaded });
});

window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    openFiles(files, { asLayer: doc.loaded });
  }
});

/* -------------------------------------------------------------- shortcuts */

const TOOL_KEYS = { v: 'select', c: 'crop', b: 'draw', e: 'erase', r: 'rect', o: 'ellipse', l: 'line', t: 'text', i: 'place' };

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (typing) return;
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    (e.shiftKey ? redo : undo)();
    requestRender();
    return;
  }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); openExportDialog(); return; }
  if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); $('file-input').click(); return; }
  if (meta && e.key === '0') { e.preventDefault(); fitView(); requestRender(); emit('view'); return; }
  if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(view.zoom * 1.25); return; }
  if (meta && e.key === '-') { e.preventDefault(); setZoom(view.zoom / 1.25); return; }
  if (meta) return;

  if (crop.active) {
    if (e.key === 'Enter') { e.preventDefault(); endCrop(true); setTool('select'); fitView(); requestRender(); }
    if (e.key === 'Escape') { e.preventDefault(); endCrop(false); setTool('select'); }
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && selected()) {
    e.preventDefault();
    pushHistory();
    removeLayer(doc.selection);
    emit('all');
    requestRender();
    return;
  }
  if (e.key === '[' && selected()) { pushHistory(); moveLayer(doc.selection, -1); emit('all'); requestRender(); return; }
  if (e.key === ']' && selected()) { pushHistory(); moveLayer(doc.selection, 1); emit('all'); requestRender(); return; }

  // Arrow keys nudge the selected layer.
  if (e.key.startsWith('Arrow') && selected()) {
    e.preventDefault();
    const l = selected();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') l.x -= step;
    if (e.key === 'ArrowRight') l.x += step;
    if (e.key === 'ArrowUp') l.y -= step;
    if (e.key === 'ArrowDown') l.y += step;
    requestRender();
    return;
  }

  const t = TOOL_KEYS[e.key.toLowerCase()];
  if (t) { e.preventDefault(); setTool(t); }
});

/* --------------------------------------------------------------- reactive */

onChange((what) => {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
  $('zoom-label').textContent = Math.round(view.zoom * 100) + '%';
  $('crop-actions').hidden = !crop.active;
  if (what === 'view') return;
  if (what === 'crop') { renderToolOptions(); return; }
  if (what === 'layers') { renderLayers(); renderLayerOptions(); return; }
  renderAll();
});

const ro = new ResizeObserver(() => {
  if (doc.loaded) requestRender();
});
ro.observe(stage);
window.addEventListener('resize', () => requestRender());

emit('all');
requestRender();

/* -------------------------------------------------------------------- PWA */

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onOfflineReady: () => toast('Ready to work offline.', 'ok')
    });
  }).catch(() => {});
}

// Surface unexpected failures rather than dying silently.
window.addEventListener('error', (e) => {
  if (e.message?.includes('ResizeObserver')) return;
  toast('Something went wrong: ' + e.message, 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  toast('Something went wrong: ' + (e.reason?.message || e.reason), 'err');
});
