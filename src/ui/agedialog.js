import { doc, pushHistory, addLayer, makeImageLayer, emit } from '../state.js';
import { renderDoc, requestRender } from '../render.js';
import { makeCanvas, clamp, toast, loadImage, canvasFromImage, fitScale } from '../util.js';
import { detectFaces } from '../face/landmarks.js';
import { ageTransform, amountForYears } from '../face/age.js';
import { getConfig, setConfig, isConfigured, remoteAge } from '../face/remote.js';
import { openModal, el, row, slider, segmented, field } from './modal.js';

const DETECT_MAX = 1024;      // landmark detection resolution
const PREVIEW_MAX = 460;      // preview render resolution

/** Detect once, keep normalised coords, project onto whatever canvas we need. */
async function detectNormalised(src) {
  const k = fitScale(src.width, src.height, DETECT_MAX, DETECT_MAX, 1);
  const c = makeCanvas(src.width * k, src.height * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const faces = await detectFaces(c);
  return faces.map((f) => ({
    pts: f.pts.map((p) => ({ x: p.x / c.width, y: p.y / c.height })),
    box: { x: f.box.x / c.width, y: f.box.y / c.height, w: f.box.w / c.width, h: f.box.h / c.height }
  }));
}

const project = (faces, w, h) => faces.map((f) => ({
  pts: f.pts ? f.pts.map((p) => ({ x: p.x * w, y: p.y * h })) : null,
  box: { x: f.box.x * w, y: f.box.y * h, w: f.box.w * w, h: f.box.h * h }
}));

export function openAgeDialog() {
  if (!doc.loaded) return toast('Open a photo first.', 'err');
  const source = renderDoc({ background: '#ffffff' });

  const opts = {
    direction: 'older', years: 10, strength: 1,
    geometry: true, skinTexture: true, hair: true,
    backend: isConfigured() ? 'ai' : 'local'
  };
  let faces = null;        // normalised
  let manualBox = null;    // normalised, user-drawn fallback
  let previewJob = 0;

  openModal({
    title: 'Age Transform',
    wide: true,
    build(content, close) {
      const status = el('div', { class: 'busy' }, el('span', { class: 'spin' }), 'Looking for faces…');

      const beforeC = el('canvas');
      const afterC = el('canvas');
      const pair = el('div', { class: 'preview-pair' },
        el('figure', {}, beforeC, el('figcaption', {}, 'Original')),
        el('figure', {}, afterC, el('figcaption', {}, 'Preview'))
      );

      const controls = el('div', { class: 'grid-2' });
      const left = el('div');
      const right = el('div');
      controls.append(left, right);

      /* ---- direction + years ---- */
      const yearsChips = el('div', { class: 'chips' });
      const yearsSlider = slider('Custom', {
        min: 1, max: 40, value: opts.years, format: (v) => v + ' yr',
        onInput: (v) => { opts.years = v; syncChips(); schedule(); }
      });
      function syncChips() {
        yearsChips.replaceChildren(...[5, 10, 25].map((y) => {
          const b = el('button', { class: 'chip' + (opts.years === y ? ' active' : '') }, `${opts.direction === 'younger' ? '−' : '+'}${y} yrs`);
          b.addEventListener('click', () => {
            opts.years = y;
            yearsSlider.setValue(y);
            syncChips();
            schedule();
          });
          return b;
        }));
      }
      syncChips();

      left.append(
        field('Direction', segmented([['older', 'Older'], ['younger', 'Younger']], opts.direction, (v) => {
          opts.direction = v;
          syncChips();
          schedule();
        })),
        field('How far', yearsChips, yearsSlider),
        slider('Strength', {
          min: 20, max: 140, value: 100, format: (v) => v + '%',
          onInput: (v) => { opts.strength = v / 100; schedule(); }
        })
      );

      /* ---- what to change ---- */
      const check = (label, key) => {
        const c = el('input', { type: 'checkbox' });
        c.checked = opts[key];
        c.addEventListener('change', () => { opts[key] = c.checked; schedule(); });
        return row(label, c);
      };
      right.append(
        field('Apply to',
          check('Face shape', 'geometry'),
          check('Skin', 'skinTexture'),
          check('Hair', 'hair')
        )
      );

      /* ---- engine ---- */
      const engineWrap = el('div');
      const renderEngine = () => {
        engineWrap.replaceChildren(
          field('Engine',
            segmented(
              [['local', 'On-device'], ['ai', isConfigured() ? 'AI model' : 'AI (setup)']],
              opts.backend,
              (v) => {
                if (v === 'ai' && !isConfigured()) { openAISettings(renderEngine); opts.backend = 'local'; renderEngine(); return; }
                opts.backend = v;
                schedule();
              }
            ),
            el('div', { class: 'hint', style: { marginTop: '6px' } },
              opts.backend === 'ai'
                ? 'Sends the photo to the endpoint you configured. Preview is on-device; the AI runs on Apply.'
                : 'Runs entirely in this browser. A physical simulation of ageing, not a prediction of a specific face.'),
            el('button', {
              class: 'btn tiny', style: { marginTop: '6px' },
              onclick: () => openAISettings(renderEngine)
            }, isConfigured() ? 'AI settings…' : 'Set up AI backend…')
          )
        );
      };
      renderEngine();
      right.append(engineWrap);

      content.append(status, pair, controls);

      /* ---- preview plumbing ---- */
      const pk = fitScale(source.width, source.height, PREVIEW_MAX, PREVIEW_MAX, 1);
      const pw = Math.max(1, Math.round(source.width * pk)), ph = Math.max(1, Math.round(source.height * pk));
      const previewSrc = makeCanvas(pw, ph);
      previewSrc.getContext('2d').drawImage(source, 0, 0, pw, ph);
      beforeC.width = pw; beforeC.height = ph;
      beforeC.getContext('2d').drawImage(previewSrc, 0, 0);
      afterC.width = pw; afterC.height = ph;

      let timer = 0;
      function schedule() {
        clearTimeout(timer);
        timer = setTimeout(runPreview, 90);
      }

      function activeFaces() {
        if (faces && faces.length) return faces;
        if (manualBox) return [{ pts: null, box: manualBox }];
        return [];
      }

      function runPreview() {
        const job = ++previewJob;
        const list = activeFaces();
        const ctx = afterC.getContext('2d');
        if (!list.length) {
          ctx.drawImage(previewSrc, 0, 0);
          ctx.fillStyle = 'rgba(8,10,15,.55)';
          ctx.fillRect(0, 0, pw, ph);
          return;
        }
        // Preview always uses the on-device engine — it is instant and free.
        const out = ageTransform(previewSrc, { ...opts, faces: project(list, pw, ph) });
        if (job !== previewJob) return;
        ctx.clearRect(0, 0, pw, ph);
        ctx.drawImage(out, 0, 0);
      }

      /* ---- manual face box (drag on the Original) ---- */
      let dragBox = null;
      const bctx = beforeC.getContext('2d');
      const redrawBefore = () => {
        bctx.drawImage(previewSrc, 0, 0);
        const b = dragBox || (manualBox && { x: manualBox.x * pw, y: manualBox.y * ph, w: manualBox.w * pw, h: manualBox.h * ph });
        if (b) {
          bctx.strokeStyle = '#7c9cff';
          bctx.lineWidth = 2;
          bctx.setLineDash([5, 4]);
          bctx.strokeRect(b.x, b.y, b.w, b.h);
          bctx.setLineDash([]);
        }
      };
      const boxPoint = (e) => {
        const r = beforeC.getBoundingClientRect();
        return { x: ((e.clientX - r.left) / r.width) * pw, y: ((e.clientY - r.top) / r.height) * ph };
      };
      beforeC.addEventListener('pointerdown', (e) => {
        if (faces && faces.length) return;   // only needed when detection found nothing
        beforeC.setPointerCapture(e.pointerId);
        const p = boxPoint(e);
        dragBox = { x: p.x, y: p.y, w: 0, h: 0, ox: p.x, oy: p.y };
      });
      beforeC.addEventListener('pointermove', (e) => {
        if (!dragBox) return;
        const p = boxPoint(e);
        dragBox.x = Math.min(dragBox.ox, p.x);
        dragBox.y = Math.min(dragBox.oy, p.y);
        dragBox.w = Math.abs(p.x - dragBox.ox);
        dragBox.h = Math.abs(p.y - dragBox.oy);
        redrawBefore();
      });
      beforeC.addEventListener('pointerup', () => {
        if (!dragBox) return;
        if (dragBox.w > 12 && dragBox.h > 12) {
          manualBox = { x: dragBox.x / pw, y: dragBox.y / ph, w: dragBox.w / pw, h: dragBox.h / ph };
          status.replaceChildren('Manual region set. Face shape changes need landmarks, so only skin and colour are applied.');
          status.className = 'note warn';
          schedule();
        }
        dragBox = null;
        redrawBefore();
      });

      /* ---- kick off detection ---- */
      (async () => {
        try {
          faces = await detectNormalised(source);
          if (faces.length) {
            status.className = 'note';
            status.replaceChildren(`Found ${faces.length} face${faces.length > 1 ? 's' : ''}. All of them will be transformed.`);
            schedule();
          } else {
            status.className = 'note warn';
            status.replaceChildren('No face detected. Drag a box around the face on the Original to mark it manually.');
            beforeC.style.cursor = 'crosshair';
          }
        } catch (e) {
          status.className = 'note warn';
          status.replaceChildren(`Face detection could not load (${e.message}). Drag a box around the face on the Original instead.`);
          beforeC.style.cursor = 'crosshair';
        }
      })();

      content._apply = async (setBusy) => {
        const list = activeFaces();
        if (!list.length) { toast('Mark a face first — drag a box on the Original.', 'err'); return false; }

        if (opts.backend === 'ai') {
          setBusy('Sending to your AI backend…');
          try {
            const url = await remoteAge(source.toDataURL('image/jpeg', 0.94), {
              years: opts.years, direction: opts.direction,
              onStatus: (s) => setBusy(s)
            });
            const img = await loadImage(url);
            addResult(canvasFromImage(img), opts);
            return true;
          } catch (e) {
            toast('AI backend failed: ' + e.message, 'err');
            return false;
          }
        }

        setBusy('Rendering at full resolution…');
        await new Promise((r) => setTimeout(r, 30));   // let the spinner paint
        const out = ageTransform(source, { ...opts, faces: project(list, source.width, source.height) });
        addResult(out, opts);
        return true;
      };
    },

    footer(f, close) {
      const busy = el('span', { class: 'busy', style: { marginRight: 'auto', display: 'none' } });
      const cancel = el('button', { class: 'btn' }, 'Cancel');
      const apply = el('button', { class: 'btn primary' }, 'Apply as new layer');
      cancel.addEventListener('click', () => close());
      apply.addEventListener('click', async () => {
        const content = f.parentElement.querySelector('.content');
        apply.disabled = cancel.disabled = true;
        const setBusy = (msg) => {
          busy.style.display = 'flex';
          busy.replaceChildren(el('span', { class: 'spin' }), msg);
        };
        setBusy('Working…');
        const ok = await content._apply(setBusy);
        if (ok) close();
        else { apply.disabled = cancel.disabled = false; busy.style.display = 'none'; }
      });
      f.append(busy, cancel, apply);
    }
  });
}

function addResult(canvas, opts) {
  pushHistory();
  const sign = opts.direction === 'younger' ? '−' : '+';
  const layer = makeImageLayer(canvas, `Age ${sign}${opts.years}y`);
  layer.w = doc.w;
  layer.h = doc.h;
  addLayer(layer);
  emit('all');
  requestRender();
  toast(`Applied age ${sign}${opts.years} years as a new layer.`, 'ok');
}

/* ------------------------------------------------------------ AI settings */

export function openAISettings(onSaved = () => {}) {
  const cfg = getConfig();
  openModal({
    title: 'AI backend',
    build(content) {
      const provider = el('select', {});
      for (const [v, label] of [['none', 'Off — on-device only'], ['custom', 'Custom endpoint'], ['replicate', 'Replicate']]) {
        const o = el('option', { value: v }, label);
        if (cfg.provider === v) o.selected = true;
        provider.appendChild(o);
      }
      const endpoint = el('input', { type: 'text', value: cfg.endpoint, placeholder: 'https://your-worker.example.com/age' });
      const token = el('input', { type: 'password', value: cfg.token, placeholder: 'API key' });
      const model = el('input', { type: 'text', value: cfg.model, placeholder: 'model version hash' });
      const proxy = el('input', { type: 'text', value: cfg.proxy, placeholder: 'https://your-proxy.example.com (optional)' });

      const rEndpoint = row('Endpoint', endpoint);
      const rToken = row('API key', token);
      const rModel = row('Model', model);
      const rProxy = row('Proxy', proxy);

      const sync = () => {
        const p = provider.value;
        rEndpoint.style.display = p === 'custom' ? '' : 'none';
        rToken.style.display = p === 'none' ? 'none' : '';
        rModel.style.display = p === 'replicate' ? '' : 'none';
        rProxy.style.display = p === 'replicate' ? '' : 'none';
      };
      provider.addEventListener('change', sync);

      content.append(
        el('div', { class: 'note' },
          'The on-device engine simulates ageing and never leaves your machine. A generative model produces photoreal results but uploads the photo to whatever service you point at here. Keys are stored only in this browser.'),
        el('div', { style: { height: '12px' } }),
        row('Provider', provider),
        rEndpoint, rToken, rModel, rProxy,
        el('div', { class: 'hint' },
          'Custom endpoint contract — POST {image, years, direction} and reply {image}. Browsers block cross-origin calls without CORS headers, so Replicate needs a small proxy of your own; see the README.')
      );
      sync();
      content._save = () => {
        setConfig({
          provider: provider.value,
          endpoint: endpoint.value.trim(),
          token: token.value.trim(),
          model: model.value.trim(),
          proxy: proxy.value.trim()
        });
      };
    },
    footer(f, close) {
      const cancel = el('button', { class: 'btn' }, 'Cancel');
      const save = el('button', { class: 'btn primary' }, 'Save');
      cancel.addEventListener('click', () => close());
      save.addEventListener('click', () => {
        f.parentElement.querySelector('.content')._save();
        close();
        onSaved();
        toast('AI backend settings saved.', 'ok');
      });
      f.append(cancel, save);
    }
  });
}
