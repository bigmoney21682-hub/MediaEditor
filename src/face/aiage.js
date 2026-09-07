/**
 * Driving a generative model with the face the detector already found.
 *
 * The naive integration sends the whole photo and puts what comes back on a
 * layer. It works, and it is wrong for a photo editor: the model redraws every
 * pixel, so the background shifts, the grain changes, and a portrait of two
 * people ages both of them because you asked about one. What comes back is a
 * *new photograph*, not an edit of yours.
 *
 * So the default here is to send a padded crop around each detected face and
 * composite the result back through a feathered mask. The model only sees, and
 * only touches, the region that is supposed to change; everything else is
 * still your original file. Whole-photo mode stays available for the times the
 * crop is the wrong unit — a full-length shot, or a face the detector missed.
 */

import { makeCanvas, copyCanvas, clamp, fitScale } from '../util.js';
import { apiKeyStore, modelStore } from '../ai/proxy.js';
import { buildAgePrompt, buildShortAgePrompt } from '../ai/prompt.js';

/** How much bigger the whole-photo send may be than a face crop. Each provider
 *  names its own base size — see the descriptors in ai/. */
const PHOTO_SCALE = 1.25;

/**
 * How far past the detector's box to crop.
 *
 * MediaPipe's box is the face proper — it stops at the hairline and the chin.
 * Ageing shows up in the hair, the jaw and the neck, so a box-tight crop asks
 * the model to grey hair it cannot see. Asymmetric because the head is: more
 * room above for hair, less below for the neck.
 */
const PAD = { top: 0.75, side: 0.45, bottom: 0.5 };

/** Where the mask stops being opaque, as a fraction of the crop. Wide enough
 *  that a seam is a gradient rather than an edge. */
const FEATHER = 0.12;

const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

/**
 * The mask an inpainting model paints inside: white where it may work, black
 * where the original must survive untouched.
 *
 * Drawn as a soft-edged ellipse rather than the whole crop, because the crop
 * is padded out to include hair and neck and those edges are where the result
 * has to meet the original photograph. The blur is what stops that meeting
 * being a visible seam — the model itself feathers nothing.
 */
function faceMask(w, h) {
  const m = makeCanvas(w, h);
  const c = m.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);

  const blur = Math.round(Math.min(w, h) * 0.06);
  if (typeof c.filter === 'string') c.filter = `blur(${blur}px)`;
  c.fillStyle = '#fff';
  c.beginPath();
  c.ellipse(w / 2, h * 0.48, w * 0.40, h * 0.44, 0, 0, Math.PI * 2);
  c.fill();
  c.filter = 'none';
  return m;
}

/** Everything may change. Used only for whole-photo sends, where there is no
 *  region to protect and the point is a new rendering of the frame. */
function fullMask(w, h) {
  const m = makeCanvas(w, h);
  const c = m.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, w, h);
  return m;
}

/**
 * How far the model may travel from the original, from the years asked for.
 *
 * Below about 0.4 an inpainting model returns the face it was given; above
 * about 0.8 the mask stops mattering, because what it paints inside is a new
 * person rather than an older one. The whole usable range is in between.
 */
const modelStrengthFor = (years) => clamp(0.42 + (years / 40) * 0.33, 0.42, 0.78);

/**
 * Crop rect for one face, in source pixels, clamped to the image.
 *
 * Squared off afterwards, because the models do not promise to return the
 * aspect ratio they were given — FLUX hands back a square whatever goes in.
 * Scaling a square answer into an oblong hole stretches the face, and a
 * stretched face is worse than no transform at all. A square crop makes the
 * question moot.
 */
function cropRect(box, w, h) {
  const x0 = clamp(box.x - box.w * PAD.side, 0, w);
  const y0 = clamp(box.y - box.h * PAD.top, 0, h);
  const x1 = clamp(box.x + box.w * (1 + PAD.side), 0, w);
  const y1 = clamp(box.y + box.h * (1 + PAD.bottom), 0, h);

  let rect = {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.max(16, Math.round(x1 - x0)),
    h: Math.max(16, Math.round(y1 - y0))
  };

  // Grow the short side around the centre, then slide back inside the image.
  // A photo narrower than the square it wants keeps its oblong crop — better a
  // little distortion than a crop that misses half the face.
  const side = Math.min(Math.max(rect.w, rect.h), w, h);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  rect = {
    x: Math.round(clamp(cx - side / 2, 0, w - side)),
    y: Math.round(clamp(cy - side / 2, 0, h - side)),
    w: Math.round(side),
    h: Math.round(side)
  };

  return rect;
}

/** A canvas holding `rect` of `src`, scaled to fit `max`. */
function cutout(src, rect, max) {
  const k = fitScale(rect.w, rect.h, max, max, 1);
  const c = makeCanvas(rect.w * k, rect.h * k);
  c.getContext('2d').drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  return c;
}

/**
 * Draws `patch` over `rect` of `out`, fading to nothing at the edges.
 *
 * The mask is a blurred rounded rectangle punched through the patch with
 * destination-in. `ctx.filter` is the cheap way to blur it; Safari before 17
 * has no canvas filter, so the fallback stacks translucent inset rectangles,
 * which is coarser but has the same shape.
 */
function compositeFeathered(out, patch, rect, alpha = 1) {
  const m = makeCanvas(rect.w, rect.h);
  const mx = m.getContext('2d');
  mx.drawImage(patch, 0, 0, rect.w, rect.h);
  mx.globalCompositeOperation = 'destination-in';

  const f = Math.max(3, Math.round(Math.min(rect.w, rect.h) * FEATHER));
  const r = Math.min(rect.w, rect.h) * 0.22;
  mx.fillStyle = '#fff';

  // roundRect is a few years newer than the rest of what this app needs;
  // square corners are a worse mask, not a broken one.
  const blob = (inset) => {
    mx.beginPath();
    const x = inset, y = inset, w = rect.w - inset * 2, h = rect.h - inset * 2;
    if (mx.roundRect) mx.roundRect(x, y, w, h, r);
    else mx.rect(x, y, w, h);
    mx.fill();
  };

  if (typeof mx.filter === 'string') {
    mx.filter = `blur(${f / 2}px)`;
    blob(f);
    mx.filter = 'none';
  } else {
    const steps = 8;
    mx.globalAlpha = 1 / steps;
    for (let i = 0; i < steps; i++) blob((f * i) / steps);
    mx.globalAlpha = 1;
  }

  const ox = out.getContext('2d');
  ox.save();
  ox.globalAlpha = alpha;
  ox.drawImage(m, rect.x, rect.y);
  ox.restore();
}

/** Decodes a data: URL the model returned. Kept separate from util.loadImage
 *  so the error names the model rather than the file picker. */
function decode(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('The model returned something that is not a decodable image.'));
    img.src = dataUrl;
  });
}

/**
 * @param {HTMLCanvasElement} source     the flattened document
 * @param {object} opts
 * @param {{box:{x,y,w,h}}[]} opts.faces faces in *source pixels*
 * @param {'face'|'photo'} opts.scope
 * @param {(input:object, opts:object) => Promise<string>} editImage
 *        the provider's edit call, injected by remote.js so this module does
 *        not have to know which service is configured — and so remote.js can
 *        import it without a cycle.
 * @returns {Promise<HTMLCanvasElement>} a canvas the size of `source`
 */
export async function aiAgeTransform(source, opts, provider) {
  const { faces = [], scope = 'face', strength = 1, signal, onStatus = () => {} } = opts;
  const editImage = provider.edit;
  const shared = {
    apiKey: apiKeyStore.get(),
    model: modelStore.get(),
    signal,
    onStatus
  };
  // Above 1 the on-device engine exaggerates its warp; a generated face has no
  // such dial, so strength becomes how much of it is mixed over the original.
  const alpha = clamp(strength, 0, 1);
  const modelStrength = modelStrengthFor(opts.years ?? 10);

  /** One provider takes prose and re-synthesises; the other takes a CLIP-length
   *  description and a mask. Both are built, and each takes what it reads. */
  const mime = provider.sendMime ?? 'image/png';
  const encode = (c) => b64(mime === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.94) : c.toDataURL('image/png'));

  const request = (canvas, scope, maskCanvas) => ({
    imageBase64: encode(canvas),
    mimeType: mime,
    prompt: buildAgePrompt({ ...opts, scope }),
    shortPrompt: buildShortAgePrompt(opts),
    // Always PNG: a JPEG mask arrives with soft grey edges where it had hard
    // black-and-white ones, which is the one place lossy compression changes
    // the meaning of the data rather than its quality.
    maskBase64: maskCanvas ? b64(maskCanvas.toDataURL('image/png')) : undefined,
    modelStrength
  });

  if (scope === 'photo' || !faces.length) {
    const max = Math.round(provider.sendMax * PHOTO_SCALE);
    const k = fitScale(source.width, source.height, max, max, 1);
    const send = makeCanvas(source.width * k, source.height * k);
    send.getContext('2d').drawImage(source, 0, 0, send.width, send.height);

    onStatus('Sending the photo…');
    const url = await editImage(
      request(send, 'photo', provider.needsMask ? fullMask(send.width, send.height) : null),
      shared
    );
    const img = await decode(url);

    // The model is free to return a different size; the layer has to line up
    // with the document, so it is scaled back rather than trusted.
    const out = copyCanvas(source);
    const ox = out.getContext('2d');
    ox.save();
    ox.globalAlpha = alpha;
    ox.drawImage(img, 0, 0, out.width, out.height);
    ox.restore();
    return out;
  }

  const out = copyCanvas(source);
  for (const [i, face] of faces.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const rect = cropRect(face.box, source.width, source.height);
    const send = cutout(source, rect, provider.sendMax);

    onStatus(faces.length > 1 ? `Face ${i + 1} of ${faces.length} — sending…` : 'Sending the face…');
    const url = await editImage(
      request(send, 'face', provider.needsMask ? faceMask(send.width, send.height) : null),
      { ...shared, onStatus: (s) => onStatus(faces.length > 1 ? `Face ${i + 1} of ${faces.length} — ${s}` : s) }
    );
    compositeFeathered(out, await decode(url), rect, alpha);
  }
  return out;
}
