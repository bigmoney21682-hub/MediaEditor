/**
 * The AI backends for the age transform, and which one a request goes to.
 *
 * The offline engine in `age.js` simulates ageing; a generative model
 * re-synthesises the face. Nothing here runs unless the user picks the AI
 * engine and consents to the upload, and every setting — keys included — lives
 * only in this browser.
 *
 * Three backends:
 *   gemini     — the stack the analyzer apps use: the viewer's own Google key
 *                first, then their proxy, then the shared Worker, with model
 *                and credential fallback under all of it. See ai/.
 *   custom     — your own endpoint. POST {image, years, direction} -> {image}
 *   replicate  — api.replicate.com, directly or through a relay of your own
 *
 * Note on CORS: a browser can only call an endpoint that returns permissive
 * CORS headers. Google does; Replicate does not, which is why `proxy` exists
 * on that option and why the shared Worker exists at all.
 */

import { copyCanvas, clamp, loadImage } from '../util.js';
import { aiAgeTransform } from './aiage.js';
import { reachable, apiKeyStore, proxyStore, sharedProxyStore, usingProxy } from '../ai/proxy.js';

const KEY = 'mediaeditor.ai';
const KEY_CONSENT = 'me.ai.consent';

const DEFAULTS = { provider: 'gemini', endpoint: '', token: '', model: '', proxy: '' };

export function getConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setConfig(cfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...getConfig(), ...cfg }));
  } catch { /* private mode: the session keeps working, the settings do not persist */ }
}

/**
 * Uploading a photograph of someone's face to a third party is a decision with
 * real consequences, so it gets made once, deliberately, rather than buried in
 * a hint nobody reads. The on-device engine needs no consent because nothing
 * leaves the machine.
 */
export const consent = {
  get: () => {
    try { return localStorage.getItem(KEY_CONSENT) === '1'; } catch { return false; }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(KEY_CONSENT, '1');
      else localStorage.removeItem(KEY_CONSENT);
    } catch { /* ignore */ }
  }
};

/** Whether the selected backend has everything it needs to run. */
export function isConfigured() {
  const c = getConfig();
  if (c.provider === 'gemini') return reachable(apiKeyStore.get());
  if (c.provider === 'custom') return !!c.endpoint;
  if (c.provider === 'replicate') return !!c.token && !!c.model;
  return false;
}

/** One line for the dialog: what a request would actually use. */
export function describeBackend() {
  const c = getConfig();
  if (c.provider === 'gemini') {
    if (apiKeyStore.get()) return 'Google, with your own key' + (usingProxy() ? ', falling back to the proxy' : '');
    if (proxyStore.get().url) return 'your proxy';
    if (sharedProxyStore.get()) return 'the shared service';
    return 'nothing yet — add a key or turn the shared service on';
  }
  if (c.provider === 'custom') return c.endpoint || 'your endpoint (not set)';
  if (c.provider === 'replicate') return 'Replicate' + (c.proxy ? ', through your relay' : '');
  return 'the on-device engine only';
}

/**
 * Runs the configured backend and returns a canvas the size of `source`.
 *
 * Everything downstream of this — the layer, the history entry, the export —
 * wants a canvas matching the document, so the three backends converge here
 * rather than each in the dialog.
 */
export async function runAI(source, opts) {
  const cfg = getConfig();

  if (cfg.provider === 'gemini') return aiAgeTransform(source, opts);

  const image = source.toDataURL('image/jpeg', 0.94);
  const url =
    cfg.provider === 'custom'
      ? await viaCustom(cfg, image, opts)
      : cfg.provider === 'replicate'
        ? await viaReplicate(cfg, image, opts)
        : null;
  if (!url) throw new Error('No AI backend is configured.');

  const img = await loadImage(url);
  const out = copyCanvas(source);
  const ox = out.getContext('2d');
  ox.save();
  ox.globalAlpha = clamp(opts.strength ?? 1, 0, 1);
  ox.drawImage(img, 0, 0, out.width, out.height);
  ox.restore();
  return out;
}

async function viaCustom(cfg, image, { years, direction, signal, onStatus = () => {} }) {
  onStatus('Contacting your endpoint…');
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify({ image, years, direction, target_age_delta: direction === 'younger' ? -years : years })
  });
  if (!res.ok) throw new Error(`Endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const out = json.image || json.output || json.url;
  if (!out) throw new Error('Endpoint response had no `image` field.');
  return Array.isArray(out) ? out[0] : out;
}

async function viaReplicate(cfg, image, { years, direction, signal, onStatus = () => {} }) {
  const base = (cfg.proxy || 'https://api.replicate.com').replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` };

  onStatus('Queuing prediction…');
  const create = await fetch(`${base}/v1/predictions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      version: cfg.model,
      input: {
        image,
        // SAM-style models take a target age; others take a delta. Send both.
        target_age: direction === 'younger' ? String(Math.max(1, 30 - years)) : String(30 + years),
        years: direction === 'younger' ? -years : years
      }
    })
  });
  if (!create.ok) throw new Error(`Replicate: ${create.status} ${(await create.text()).slice(0, 200)}`);
  let pred = await create.json();

  const started = Date.now();
  while (pred.status === 'starting' || pred.status === 'processing') {
    if (Date.now() - started > 180000) throw new Error('Prediction timed out after 3 minutes.');
    onStatus(`Model ${pred.status}…`);
    await new Promise((r) => setTimeout(r, 1500));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const poll = await fetch(`${base}/v1/predictions/${pred.id}`, { headers, signal });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') throw new Error(`Prediction ${pred.status}: ${pred.error || 'unknown error'}`);
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out) throw new Error('Prediction returned no output image.');
  return out;
}
