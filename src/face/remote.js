/**
 * Optional AI backend for photoreal age transforms.
 *
 * The offline engine in `age.js` simulates ageing; a generative model actually
 * re-synthesises the face. Nothing here runs unless the user configures it, and
 * the settings (including the key) live only in this browser's localStorage.
 *
 * Two shapes are supported:
 *   custom     — your own endpoint. POST {image, years, direction} -> {image}
 *   replicate  — api.replicate.com directly, or through your own proxy origin
 *
 * Note on CORS: browsers can only call an endpoint that returns permissive CORS
 * headers. Replicate does not, so `proxy` should point at a small relay you run.
 * There is a 20-line example in the README.
 */

const KEY = 'mediaeditor.ai';

export function getConfig() {
  try {
    return { provider: 'none', endpoint: '', token: '', model: '', proxy: '', ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { provider: 'none', endpoint: '', token: '', model: '', proxy: '' };
  }
}

export function setConfig(cfg) {
  localStorage.setItem(KEY, JSON.stringify({ ...getConfig(), ...cfg }));
}

export const isConfigured = () => {
  const c = getConfig();
  return (c.provider === 'custom' && !!c.endpoint) || (c.provider === 'replicate' && !!c.token && !!c.model);
};

/**
 * @param {string} dataUrl  source image as a data: URL
 * @param {{years:number, direction:string}} opts
 * @returns {Promise<string>} resulting image as a data: or https: URL
 */
export async function remoteAge(dataUrl, { years, direction, signal, onStatus = () => {} }) {
  const cfg = getConfig();
  if (cfg.provider === 'custom') return viaCustom(cfg, dataUrl, years, direction, signal, onStatus);
  if (cfg.provider === 'replicate') return viaReplicate(cfg, dataUrl, years, direction, signal, onStatus);
  throw new Error('No AI backend is configured.');
}

async function viaCustom(cfg, image, years, direction, signal, onStatus) {
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

async function viaReplicate(cfg, image, years, direction, signal, onStatus) {
  const base = (cfg.proxy || 'https://api.replicate.com').replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.token}`
  };
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
