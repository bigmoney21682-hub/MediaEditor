import { doc, pushHistory, addLayer, makeImageLayer, emit } from '../state.js';
import { renderDoc, requestRender } from '../render.js';
import { makeCanvas, toast, fitScale } from '../util.js';
import { detectFaces } from '../face/landmarks.js';
import { ageTransform } from '../face/age.js';
import { getConfig, setConfig, isConfigured, consent, describeBackend, runAI } from '../face/remote.js';
import { apiKeyStore, modelStore, proxyStore, sharedProxyStore, quotaStore, usingProxy } from '../ai/proxy.js';
import { diagnoseKey, sanitizeKey } from '../ai/apikey.js';
import { listGeminiModels, DEFAULT_MODEL } from '../ai/gemini.js';
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
    // The AI engine is never the default, however well configured it is: it
    // uploads a photograph of someone's face, and that is a choice to make on
    // purpose rather than to discover afterwards.
    backend: 'local',
    // Which pixels the model is allowed to touch. See face/aiage.js.
    scope: 'face'
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
      const hint = (text) => el('div', { class: 'hint', style: { marginTop: '6px' } }, text);

      /** The shared service's daily allowance, when one is in the path. */
      const quotaLine = () => {
        const q = quotaStore.get();
        if (!q?.enabled) return null;
        return hint(`Shared service: ${q.remaining} of ${q.limit} renders left today for this address.`);
      };

      const renderEngine = () => {
        const ai = opts.backend === 'ai';
        const nodes = [
          segmented(
            [['local', 'On-device'], ['ai', isConfigured() ? 'AI model' : 'AI (setup)']],
            opts.backend,
            (v) => {
              if (v === 'ai' && !isConfigured()) { openAISettings(renderEngine); opts.backend = 'local'; renderEngine(); return; }
              opts.backend = v;
              renderEngine();
              schedule();
            }
          )
        ];

        if (ai && !consent.get()) {
          // Asked once, before the first upload, and remembered afterwards.
          const allow = el('button', { class: 'btn tiny', style: { marginTop: '6px' } }, 'I understand — allow uploads');
          allow.addEventListener('click', () => { consent.set(true); renderEngine(); });
          nodes.push(
            el('div', { class: 'note warn', style: { marginTop: '6px' } },
              `This sends the photo to ${describeBackend()}. It is a photograph of someone's face leaving your machine, which is worth deciding on purpose.`),
            allow
          );
        } else if (ai) {
          nodes.push(
            field('Model sees', segmented(
              [['face', 'Face region'], ['photo', 'Whole photo']],
              opts.scope,
              (v) => { opts.scope = v; renderEngine(); }
            )),
            hint(opts.scope === 'face'
              ? 'Sends a padded crop around each detected face and blends the result back through a soft mask — everything outside it stays your original pixels.'
              : 'Sends the whole photo. The model redraws every pixel, background and grain included.'),
            hint(`Runs against ${describeBackend()} when you press Apply. The preview beside it stays on-device.`),
            quotaLine()
          );
        } else {
          nodes.push(hint('Runs entirely in this browser. A physical simulation of ageing, not a prediction of a specific face.'));
        }

        nodes.push(el('button', {
          class: 'btn tiny', style: { marginTop: '6px' },
          onclick: () => openAISettings(renderEngine)
        }, isConfigured() ? 'AI settings…' : 'Set up AI backend…'));

        engineWrap.replaceChildren(field('Engine', ...nodes.filter(Boolean)));
      };
      renderEngine();
      right.append(engineWrap);

      // Knowing the allowance before a render is started beats discovering it
      // when one is refused. One cheap request, and only when a proxy is in
      // the path at all.
      if (usingProxy()) quotaStore.refresh().then(() => renderEngine());

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
        // Whole-photo AI mode is the one path that needs no face box: the model
        // is being handed the picture, not a region of it. Everything else
        // works from a region and has nothing to do without one.
        const needsFace = !(opts.backend === 'ai' && opts.scope === 'photo');
        if (!list.length && needsFace) {
          toast('Mark a face first — drag a box on the Original, or send the whole photo.', 'err');
          return false;
        }

        if (opts.backend === 'ai') {
          // Set before the first await so the footer can turn Cancel into Stop
          // the moment the request is actually in flight.
          const ctrl = new AbortController();
          content._abort = () => ctrl.abort();
          setBusy('Preparing the photo…');
          try {
            const out = await runAI(source, {
              ...opts,
              faces: project(list, source.width, source.height),
              signal: ctrl.signal,
              onStatus: (s) => setBusy(s)
            });
            addResult(out, opts);
            return true;
          } catch (e) {
            if (e?.name === 'AbortError') toast('Stopped.');
            else toast('AI backend failed: ' + e.message, 'err');
            return false;
          } finally {
            content._abort = null;
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
      const contentOf = () => f.parentElement.querySelector('.content');

      // A generative render takes tens of seconds, which is far too long to be
      // trapped in — so while one is in flight Cancel becomes Stop and aborts
      // it. The on-device render has nothing to abort, so it stays disabled
      // for the moment it takes.
      cancel.addEventListener('click', () => {
        const abort = contentOf()._abort;
        if (abort) abort();
        else close();
      });

      apply.addEventListener('click', async () => {
        const content = contentOf();
        apply.disabled = true;
        const setBusy = (msg) => {
          busy.style.display = 'flex';
          busy.replaceChildren(el('span', { class: 'spin' }), msg);
        };
        setBusy('Working…');

        const running = content._apply(setBusy);
        cancel.disabled = !content._abort;
        cancel.textContent = content._abort ? 'Stop' : 'Cancel';

        const ok = await running;
        if (ok) close();
        else {
          apply.disabled = cancel.disabled = false;
          cancel.textContent = 'Cancel';
          busy.style.display = 'none';
        }
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

/** Models worth offering before a key has been tested. The list from Test is
 *  always better, because it comes from the key itself. */
const KNOWN_IMAGE_MODELS = [DEFAULT_MODEL, 'gemini-2.5-flash-image-preview', 'gemini-2.0-flash-preview-image-generation'];

export function openAISettings(onSaved = () => {}) {
  const cfg = getConfig();

  openModal({
    title: 'AI backend',
    build(content) {
      const provider = el('select', {});
      for (const [v, label] of [
        ['cloudflare', 'Cloudflare Workers AI — free, no key'],
        ['gemini', 'Google Gemini — needs a key with billing'],
        ['custom', 'Custom endpoint'],
        ['replicate', 'Replicate'],
        ['none', 'Off — on-device only']
      ]) {
        const o = el('option', { value: v }, label);
        if (cfg.provider === v) o.selected = true;
        provider.appendChild(o);
      }

      /* ---------------- Gemini: key, model, proxy ---------------- */

      const shared = el('input', { type: 'checkbox' });
      shared.checked = sharedProxyStore.get();
      shared.disabled = !sharedProxyStore.available();

      const proxyUrl = el('input', { type: 'text', value: proxyStore.get().url, placeholder: 'https://your-worker.workers.dev' });
      const proxyToken = el('input', { type: 'password', value: proxyStore.get().token, placeholder: 'passphrase, if the worker sets one' });

      const key = el('input', { type: 'password', value: apiKeyStore.get(), placeholder: 'AIza… or AQ.…' });
      const keyNote = el('div', { class: 'hint' });
      const model = el('select', {});
      const testNote = el('div', { class: 'hint' });
      const test = el('button', { class: 'btn tiny' }, 'Test key & list models');

      const setModels = (ids) => {
        const chosen = modelStore.get();
        const all = [...new Set([...ids, ...(chosen ? [chosen] : [])])];
        model.replaceChildren(
          el('option', { value: '' }, `Automatic — best available (${DEFAULT_MODEL} first)`),
          ...all.map((id) => {
            const o = el('option', { value: id }, id);
            if (id === chosen) o.selected = true;
            return o;
          })
        );
      };
      setModels(KNOWN_IMAGE_MODELS);

      const showDiagnosis = () => {
        const d = diagnoseKey(key.value);
        keyNote.textContent = d ? d.message : 'Optional. Without one, requests go through the proxy below.';
        keyNote.style.color = d?.level === 'error' ? 'var(--danger)' : d?.level === 'warn' ? 'var(--gold)' : '';
      };
      key.addEventListener('input', showDiagnosis);
      showDiagnosis();

      test.addEventListener('click', async () => {
        test.disabled = true;
        testNote.textContent = 'Asking Google what this key can reach…';
        try {
          // Saved first: a test that used a key the app is not going to keep
          // would answer a question nobody asked.
          apiKeyStore.set(key.value);
          proxyStore.set({ url: proxyUrl.value, token: proxyToken.value });
          sharedProxyStore.set(shared.checked);

          const { all, image } = await listGeminiModels(sanitizeKey(key.value));
          setModels(image);
          testNote.textContent = image.length
            ? `Works. ${all.length} models reachable, ${image.length} of them can generate images.`
            : `Works, but none of the ${all.length} models reachable this way can generate an image — only the on-device engine will run.`;
          testNote.style.color = image.length ? 'var(--ok)' : 'var(--gold)';
        } catch (e) {
          testNote.textContent = e.message;
          testNote.style.color = 'var(--danger)';
        } finally {
          test.disabled = false;
        }
      });

      const cloudflare = el('div', {},
        el('div', { class: 'note' },
          'Runs FLUX.2 [klein] on Cloudflare Workers AI. There is no API key: the Worker authenticates as the Cloudflare account that deployed it, and the account\'s free daily allowance covers roughly eighty edits. Nothing to sign up for.'),
        el('div', { class: 'hint', style: { marginTop: '6px' } },
          'It re-synthesises the region it is given, and can drift — a different expression, different clothes. Keeping *Model sees* on Face region is what stops that reaching the rest of the photo.')
      );

      const gemini = el('div', {},
        el('div', { class: 'note' },
          'Same stack as the Image, PCB and Schematic analyzers: your own key first — browser straight to Google, so the photo touches no server of ours — then your proxy, then the shared service. If a model is retired or rate limited, the next one down is tried automatically.'),
        el('div', { class: 'note warn', style: { marginTop: '8px' } },
          'Google\'s free tier does not include the image models — a free key answers every age transform with a quota error, however new it is. This backend needs a key from a project with billing enabled. Workers AI above is the free one.'),
        el('div', { style: { height: '10px' } }),
        row('API key', key),
        keyNote,
        row('Model', model),
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '6px 0' } }, test, testNote),
        el('div', { class: 'hint' }, 'A key is free from aistudio.google.com/apikey, but only a billed project can generate images.')
      );

      // Which Worker the two hosted backends talk to. Shared by both, so it
      // sits outside either.
      const service = el('div', {},
        el('div', { style: { height: '10px' } }),
        row('Shared service', shared,
          el('span', { class: 'hint' },
            sharedProxyStore.available()
              ? 'The Worker this app ships with. Off means nothing is sent to it at all.'
              : 'No shared service is configured in this build.')),
        row('Your Worker', proxyUrl),
        row('Passphrase', proxyToken),
        el('div', { class: 'hint' },
          'The Worker is worker/ in this repo — deploy your own if you would rather the photos went through your Cloudflare account than someone else\'s.')
      );

      /* ---------------- the two older transports ---------------- */

      const endpoint = el('input', { type: 'text', value: cfg.endpoint, placeholder: 'https://your-worker.example.com/age' });
      const custom = el('div', {},
        row('Endpoint', endpoint),
        el('div', { class: 'hint' },
          'POST {image, years, direction} → {image}. Browsers block cross-origin calls without CORS headers, so this has to be an endpoint of yours; see the README.')
      );

      const repToken = el('input', { type: 'password', value: cfg.token, placeholder: 'r8_…' });
      const repModel = el('input', { type: 'text', value: cfg.model, placeholder: 'model version hash' });
      const repProxy = el('input', { type: 'text', value: cfg.proxy, placeholder: 'https://your-relay.example.com (optional)' });
      const replicate = el('div', {},
        row('API token', repToken),
        row('Model', repModel),
        row('Relay', repProxy),
        el('div', { class: 'hint' },
          'Replicate sends no CORS headers, so a browser cannot call it directly — point Relay at a small proxy of your own and keep the token on it rather than here.')
      );

      const off = el('div', { class: 'note' },
        'Only the on-device engine will run. Nothing is uploaded, and the AI option in the dialog stays greyed out.');

      const quota = el('div', { class: 'hint', style: { marginTop: '10px' } });
      const showQuota = () => {
        const q = quotaStore.get();
        quota.textContent = q?.enabled
          ? `Shared service allowance: ${q.remaining} of ${q.limit} left today for this address.`
          : '';
      };
      showQuota();

      const sync = () => {
        const p = provider.value;
        cloudflare.style.display = p === 'cloudflare' ? '' : 'none';
        service.style.display = p === 'cloudflare' || p === 'gemini' ? '' : 'none';
        gemini.style.display = p === 'gemini' ? '' : 'none';
        custom.style.display = p === 'custom' ? '' : 'none';
        replicate.style.display = p === 'replicate' ? '' : 'none';
        off.style.display = p === 'none' ? '' : 'none';
      };
      provider.addEventListener('change', sync);

      content.append(
        el('div', { class: 'note' },
          'The on-device engine simulates ageing and never leaves your machine. A generative model produces photoreal results but uploads the photo to whichever service you pick here. Keys are stored only in this browser.'),
        el('div', { style: { height: '12px' } }),
        row('Provider', provider),
        el('div', { style: { height: '6px' } }),
        cloudflare, gemini, service, custom, replicate, off, quota
      );
      sync();

      content._save = () => {
        apiKeyStore.set(key.value);
        modelStore.set(model.value);
        proxyStore.set({ url: proxyUrl.value, token: proxyToken.value });
        sharedProxyStore.set(shared.checked);
        setConfig({
          provider: provider.value,
          endpoint: endpoint.value.trim(),
          token: repToken.value.trim(),
          model: repModel.value.trim(),
          proxy: repProxy.value.trim()
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
