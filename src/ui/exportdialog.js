import { doc } from '../state.js';
import { toast, clamp, stamp } from '../util.js';
import {
  RASTER, supportedRaster, exportRaster, encodeRaster, canShareImages, shareImage, exportPDF, exportSVG,
  exportVideo, bestVideoFormat, VIDEO_MODES, saveProject, flatten
} from '../export/exporters.js';
import { openModal, el, row, slider, segmented, field } from './modal.js';

const PAGE_SIZES = [['fit', 'Match artwork'], ['a4', 'A4'], ['letter', 'US Letter'], ['a3', 'A3'], ['a5', 'A5']];

export function openExportDialog() {
  if (!doc.loaded) return toast('Open a photo first.', 'err');

  const state = {
    kind: 'image',
    format: 'png',
    scale: 1,
    quality: 0.92,
    bg: '#ffffff',
    name: 'mediaeditor-' + stamp(),
    pageSize: 'fit',
    videoMode: 'kenburns',
    seconds: 5,
    fps: 30,
    videoWidth: 1280
  };

  const rasters = supportedRaster();
  const video = bestVideoFormat();

  openModal({
    title: 'Export',
    build(content, close) {
      const nameInput = el('input', { type: 'text', value: state.name });
      nameInput.addEventListener('input', () => (state.name = nameInput.value.trim() || 'mediaeditor'));

      const body = el('div');
      const summary = el('div', { class: 'hint', style: { marginTop: '10px' } });

      const kinds = [
        ['image', 'Image'],
        ['pdf', 'PDF'],
        ['svg', 'SVG'],
        ...(video ? [['video', 'Video']] : []),
        ['project', 'Project']
      ];

      const rebuild = () => {
        body.replaceChildren();
        if (state.kind === 'image') buildImage();
        else if (state.kind === 'pdf') buildPDF();
        else if (state.kind === 'svg') buildSVGPane();
        else if (state.kind === 'video') buildVideo();
        else buildProject();
        updateSummary();
      };

      const dims = () => ({
        w: Math.round(doc.w * state.scale),
        h: Math.round(doc.h * state.scale)
      });

      function updateSummary() {
        const d = dims();
        if (state.kind === 'image') {
          summary.textContent = `${d.w} × ${d.h} px · ${RASTER[state.format].label}` +
            (RASTER[state.format].alpha ? ' · transparency kept' : ' · flattened onto the background colour');
        } else if (state.kind === 'pdf') {
          summary.textContent = `Rendered at ${d.w} × ${d.h} px and embedded as JPEG.`;
        } else if (state.kind === 'svg') {
          summary.textContent = `${doc.w} × ${doc.h} · shapes and text stay as vectors; photos and brush layers embed as PNG.`;
        } else if (state.kind === 'video') {
          const k = Math.min(1, state.videoWidth / doc.w);
          summary.textContent = `${Math.round(doc.w * k / 2) * 2} × ${Math.round(doc.h * k / 2) * 2} · ${state.seconds}s at ${state.fps}fps · ${video.label}`;
        } else {
          summary.textContent = 'A .mediaeditor.json file with every layer intact, re-openable here.';
        }
      }

      function buildImage() {
        body.append(field('Format', segmented(
          rasters.map((k) => [k, RASTER[k].label]), state.format,
          (v) => { state.format = v; rebuild(); }
        )));
        body.append(slider('Scale', {
          min: 25, max: 400, step: 25, value: state.scale * 100, format: (v) => v + '%',
          onInput: (v) => { state.scale = v / 100; updateSummary(); }
        }));
        if (state.format !== 'png') {
          body.append(slider('Quality', {
            min: 30, max: 100, value: Math.round(state.quality * 100), format: (v) => v + '%',
            onInput: (v) => (state.quality = v / 100)
          }));
        }
        if (!RASTER[state.format].alpha) {
          const bg = el('input', { type: 'color', value: state.bg });
          bg.addEventListener('input', () => (state.bg = bg.value));
          body.append(row('Background', bg, el('span', { class: 'hint' }, 'behind transparent areas')));
        }
      }

      function buildPDF() {
        body.append(field('Page', segmented(PAGE_SIZES, state.pageSize, (v) => { state.pageSize = v; updateSummary(); })));
        body.append(slider('Render scale', {
          min: 100, max: 400, step: 25, value: state.scale * 100, format: (v) => v + '%',
          onInput: (v) => { state.scale = v / 100; updateSummary(); }
        }));
        body.append(slider('Quality', {
          min: 40, max: 100, value: 94, format: (v) => v + '%', onInput: (v) => (state.quality = v / 100)
        }));
        const bg = el('input', { type: 'color', value: state.bg });
        bg.addEventListener('input', () => (state.bg = bg.value));
        body.append(row('Background', bg));
      }

      function buildSVGPane() {
        body.append(el('div', { class: 'note' },
          'SVG keeps shapes and text editable in Illustrator, Figma or Inkscape. Photo and brush layers are embedded as PNG data, so the file can get large.'));
      }

      function buildVideo() {
        body.append(field('Motion', segmented(
          Object.entries(VIDEO_MODES).map(([k, v]) => [k, v.split(' (')[0]]),
          state.videoMode, (v) => (state.videoMode = v)
        )));
        body.append(slider('Duration', {
          min: 2, max: 20, value: state.seconds, format: (v) => v + 's',
          onInput: (v) => { state.seconds = v; updateSummary(); }
        }));
        body.append(slider('Frame rate', {
          min: 12, max: 60, step: 6, value: state.fps, format: (v) => v + 'fps',
          onInput: (v) => { state.fps = v; updateSummary(); }
        }));
        body.append(slider('Width', {
          min: 480, max: 3840, step: 160, value: state.videoWidth, format: (v) => v + 'px',
          onInput: (v) => { state.videoWidth = v; updateSummary(); }
        }));
        body.append(el('div', { class: 'note' },
          state.videoMode === 'compare'
            ? `Dissolves the original photo into your finished edit. Recorded live as ${video.label} — keep this tab visible while it records.`
            : `Recorded live with MediaRecorder — this browser encodes ${video.label}. Keep this tab visible while it records.`));
      }

      function buildProject() {
        body.append(el('div', { class: 'note' },
          'Saves the full layer stack — images, drawings, shapes, text, transforms and blend modes — so you can pick the edit back up later.'));
      }

      content.append(
        field('File name', nameInput),
        field('Type', segmented(kinds, state.kind, (v) => { state.kind = v; rebuild(); })),
        body, summary
      );
      rebuild();
      content._state = state;
    },

    footer(f, close) {
      const progress = el('span', { class: 'busy', style: { marginRight: 'auto', display: 'none' } });
      const cancel = el('button', { class: 'btn' }, 'Cancel');
      const photos = el('button', { class: 'btn accent', title: 'Save the image to your Photos / camera roll' }, '📷 Save to Photos');
      photos.addEventListener('click', () => saveToPhotos());
      const go = el('button', { class: 'btn primary' }, 'Export');
      cancel.addEventListener('click', () => close());
      go.addEventListener('click', async () => {
        go.disabled = cancel.disabled = true;
        const setBusy = (msg) => {
          progress.style.display = 'flex';
          progress.replaceChildren(el('span', { class: 'spin' }), msg);
        };
        try {
          const s = f.parentElement.querySelector('.content')._state;
          if (s.kind === 'image') {
            setBusy('Encoding…');
            await exportRaster(s);
          } else if (s.kind === 'pdf') {
            setBusy('Building PDF…');
            await exportPDF(s);
          } else if (s.kind === 'svg') {
            exportSVG(s);
          } else if (s.kind === 'video') {
            setBusy('Recording…');
            await exportVideo({
              mode: s.videoMode, seconds: s.seconds, fps: s.fps,
              maxWidth: s.videoWidth, name: s.name,
              onProgress: (p) => setBusy(`Recording… ${Math.round(p * 100)}%`)
            });
          } else {
            saveProject(s.name);
          }
          toast('Exported ' + s.name, 'ok');
          close();
        } catch (e) {
          toast('Export failed: ' + e.message, 'err');
          go.disabled = cancel.disabled = false;
          progress.style.display = 'none';
        }
      });
      f.append(progress, cancel, photos, go);

      // Photos wants an image, whatever export type is picked — use the Image
      // tab's format and size. Encoding up front keeps share() inside the tap
      // that asked for it; iOS refuses the share sheet if we make it wait.
      const shareable = canShareImages();
      const imageOpts = () => {
        const s = f.parentElement.querySelector('.content')._state;
        return { format: s.format, scale: s.scale, quality: s.quality, bg: s.bg, name: s.name };
      };
      let prepared = null;   // { key, promise }
      const prepare = () => {
        const opts = imageOpts();
        const key = JSON.stringify(opts);
        if (prepared?.key !== key) prepared = { key, promise: encodeRaster(opts) };
        prepared.promise.catch(() => { prepared = null; });
        return prepared.promise;
      };
      if (shareable) setTimeout(() => { if (f.isConnected) prepare().catch(() => {}); }, 150);

      async function saveToPhotos() {
        if (!shareable) {
          setBusy('Encoding…');
          try {
            await exportRaster(imageOpts());
            toast('This browser can\'t open the Photos share sheet, so the image was downloaded instead.');
          } catch (e) { toast('Save failed: ' + e.message, 'err'); }
          progress.style.display = 'none';
          return;
        }
        photos.disabled = true;
        setBusy('Preparing…');
        try {
          const file = await prepare();
          progress.style.display = 'none';
          await shareImage(file);
          toast('Choose "Save Image" in the share sheet to add it to Photos.', 'ok');
        } catch (e) {
          progress.style.display = 'none';
          if (e.name === 'AbortError') { /* closed the sheet */ }
          else if (e.name === 'NotAllowedError') {
            photos.textContent = '📷 Tap again to save';
            toast('Image ready — tap Save to Photos again.');
          } else toast('Save failed: ' + e.message, 'err');
        } finally {
          photos.disabled = false;
        }
      }
      function setBusy(msg) {
        progress.style.display = 'flex';
        progress.replaceChildren(el('span', { class: 'spin' }), msg);
      }
    }
  });
}
