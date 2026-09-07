/**
 * Gemini image editing — the generative half of the age transform.
 *
 * Google AI Studio supports CORS, so a viewer with their own key is called
 * browser-to-Google directly and the photo touches no server we run. Where the
 * credentials come from, and in what order, is proxy.js's job; this file takes
 * the credential it is handed. What survives a failure is fallback.js's job.
 *
 * The call is the same `generateContent` the analyzer apps make, with one
 * difference that changes everything downstream: the response carries an image
 * part rather than JSON. `responseModalities` is what asks for that, and it is
 * also the one field the image models disagree about — see runEdit.
 */

import { credentials, quotaStore, route } from './proxy.js';
import { withFallbackChain } from './fallback.js';
import { rankModels } from './rank.js';

/** "Nano banana". A starting point rather than a dependency — if it is retired
 *  or invisible to this key, the chain finds whatever has replaced it. */
export const DEFAULT_MODEL = 'gemini-2.5-flash-image';

/**
 * A photo of a face trips the default safety thresholds more often than you
 * would expect — a swimsuit, a bare torso, a candid of a child. BLOCK_ONLY_HIGH
 * keeps genuinely harmful content blocked while letting ordinary family photos
 * through.
 */
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

export class GeminiError extends Error {
  /**
   * @param retryable            would a different *model* plausibly do better?
   * @param credentialRetryable  would a different *key* plausibly do better?
   *
   * Usually the same answer, and it defaults accordingly: a 404 or a 429 is
   * both per-model and per-key, since each key reaches its own set of models
   * and carries its own quota. Two cases separate them, in both directions:
   *
   *   - A model that answers a picture request with prose. Another model may
   *     well comply, so the model chain walks on — but the refusal is a
   *     judgement about the request, and running the whole list again on
   *     someone else's key spends the shared pool to be told the same thing.
   *   - A host that cannot be reached at all. No model on that host will do
   *     any better, but the next credential is a different host entirely.
   */
  constructor(message, status, retryable = false, credentialRetryable = retryable) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
    this.credentialRetryable = credentialRetryable;
  }
}

/** Pulls Google's own error text out of the response body. */
function googleMessage(body) {
  try {
    return JSON.parse(body)?.error?.message ?? '';
  } catch {
    return '';
  }
}

function friendlyError(status, body, model = DEFAULT_MODEL) {
  const detail = googleMessage(body);
  const suffix = detail ? `\n\nGoogle said: ${detail}` : '';

  if (/no longer available|not found|is not supported/i.test(detail))
    return `Model "${model}" is retired or invisible to your key. Open AI settings, press Test, and pick from the list — that list comes from your key, so anything in it will work.${suffix}`;

  if (status === 400 && /API key not valid/i.test(body))
    return (
      'Google does not recognise this key at all. This specific error means the key ' +
      'string itself is not valid — a disabled API or a restricted key gives a ' +
      'different error. Check the whole key was copied, and that it is an AI Studio ' +
      'key from aistudio.google.com/apikey.' + suffix
    );
  if (status === 403 && /SERVICE_DISABLED|has not been used in project/i.test(body))
    return (
      'The key is valid but the Generative Language API is not enabled on its Google ' +
      'Cloud project. Enable it, or make a fresh key at aistudio.google.com/apikey ' +
      'which comes with it enabled.' + suffix
    );
  if (status === 403 && /blocked|referer|referrer/i.test(body))
    return (
      'The key is valid but restricted. An HTTP referrer restriction must list this ' +
      "site's URL; an API restriction must include the Generative Language API." + suffix
    );
  if (status === 403) return `Access denied.${suffix}`;
  if (status === 413)
    return 'The photo is too large for the API. Age one face at a time rather than the whole photo, or scale the image down first.' + suffix;
  if (status === 429)
    return 'Rate limited — image generation has a tight free-tier cap. Wait a moment and try again.' + suffix;
  if (status === 404)
    return `Model "${model}" is not available to your key. Open AI settings, press Test, and pick from the list.${suffix}`;
  if (status >= 500) return 'Google returned a server error. Usually transient — try again.' + suffix;
  return `Request failed (HTTP ${status}).${suffix}`;
}

/**
 * Whether a different model could plausibly succeed where this one failed.
 *
 * The line to hold: faults that belong to the model are worth routing around,
 * faults that belong to the key or the request are not. A 401, a disabled API,
 * a restricted key or an oversized photo fails identically on every model.
 */
function retryableStatus(status, body) {
  const detail = googleMessage(body);
  if (status === 404) return true;
  if (/no longer available|not found|is not supported|does not support/i.test(detail)) return true;
  // Free-tier quota is metered per model, so the next one down has its own.
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * One fetch, with a transport failure turned into something readable.
 *
 * A dead host fails as a bare TypeError — "Failed to fetch" — which tells the
 * user nothing about which of three possible routes died. It is also the one
 * failure where trying another model is pointless and trying another
 * credential is exactly right, since the next credential is a different host.
 */
async function request(url, init, cred) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new GeminiError(
      `Could not reach ${cred.label} at ${new URL(url).host}. ` +
        (cred.kind === 'own'
          ? 'Check your connection.'
          : 'Either it is not deployed, its origin allowlist does not include this site, or you are offline.'),
      undefined,
      false,
      true
    );
  }
}

/** Lists what this credential can reach, image models first. Doubles as the
 *  key test: it separates "is this key usable" from "is this model available",
 *  which a failed edit alone cannot distinguish. */
async function listModelsOn(cred, signal) {
  const { url, headers } = route(cred, '/models', { pageSize: '200' });
  const res = await request(url, { headers, signal }, cred);
  quotaStore.readFrom(res);
  if (!res.ok) throw new GeminiError(friendlyError(res.status, await res.text().catch(() => '')));
  const json = await res.json();
  return (json?.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
}

/**
 * Key test / model discovery for the settings dialog.
 * @returns {Promise<{all: string[], image: string[]}>}
 */
export async function listGeminiModels(apiKey, signal) {
  const [first] = credentials(apiKey);
  if (!first)
    throw new GeminiError('Nothing to test — add a key, or turn the shared service back on.');
  const all = await listModelsOn(first, signal);
  return { all, image: rankModels(all) };
}

/** Turns a safety block into something that says what to do about it. */
function blockMessage(reason) {
  if (/SAFETY/i.test(reason))
    return (
      "Google's safety filter blocked this photo. Photos of children, and anything " +
      'the filter reads as revealing, are refused for generative editing even with ' +
      'the thresholds set as low as the API allows. The on-device engine has no such ' +
      'filter and will still run.'
    );
  if (/PROHIBITED_CONTENT|BLOCKLIST/i.test(reason))
    return 'Google refused this request outright. Nothing to tune here — try a different photo, or use the on-device engine.';
  return `Request blocked by Google (${reason}).`;
}

/**
 * One edit attempt against one model.
 *
 * `responseModalities` is where the image models disagree. The 2.0 preview
 * generator rejects a request that does not name TEXT alongside IMAGE; some
 * builds of the 2.5 image models reject TEXT. Rather than keep a table of
 * which is which — the table would be wrong within a quarter, which is the
 * failure this whole stack exists to route around — we ask for both and, if
 * the model complains specifically about modalities, ask again for IMAGE
 * alone. Two shapes, tried in the order that works more often.
 */
async function runEdit({ imageBase64, mimeType, prompt }, cred, model, signal) {
  const { url, headers } = route(cred, `/models/${model}:generateContent`);

  const send = async (responseModalities) => {
    const res = await request(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }]
          }
        ],
        safetySettings: SAFETY_SETTINGS,
        generationConfig: {
          // Low, but not zero: a face needs a little variation to look like
          // skin rather than a filter, and zero tends to produce a waxy blend.
          temperature: 0.35,
          responseModalities
        }
      })
    }, cred);

    // Proxied responses carry the shared allowance; direct ones carry nothing
    // and this is a no-op. Read before the status check so a 429 still updates
    // the meter that explains it.
    quotaStore.readFrom(res);
    return res;
  };

  let res = await send(['TEXT', 'IMAGE']);
  if (!res.ok && res.status === 400) {
    const body = await res.text().catch(() => '');
    if (/modalit/i.test(body)) res = await send(['IMAGE']);
    else
      throw new GeminiError(friendlyError(400, body, model), 400, retryableStatus(400, body));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GeminiError(friendlyError(res.status, body, model), res.status, retryableStatus(res.status, body));
  }

  const json = await res.json();

  // A safety block is a judgement about the photo, not a fault in the model,
  // so it stops the chain rather than sending the same photo round again.
  const blocked = json?.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(blockMessage(blocked));

  const candidate = json?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData?.data || p.inline_data?.data);

  if (image) {
    const inline = image.inlineData ?? image.inline_data;
    const mime = inline.mimeType ?? inline.mime_type ?? 'image/png';
    return `data:${mime};base64,${inline.data}`;
  }

  const reason = candidate?.finishReason;
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') throw new GeminiError(blockMessage(reason));
  if (reason === 'IMAGE_SAFETY')
    throw new GeminiError(
      "Google's filter blocked the image it had drawn, rather than the one sent. " +
        'A different photo, or a smaller age change, usually gets through. The ' +
        'on-device engine has no such filter.'
    );

  // Text where an image was asked for. Usually a polite refusal to edit a
  // photo of a person, occasionally a model that cannot draw at all — both are
  // worth handing to the next model down, which may well be the one that can.
  const text = parts.map((p) => p.text).filter(Boolean).join(' ').trim();
  throw new GeminiError(
    text
      ? `The model answered with words instead of a picture: "${text.slice(0, 200)}"`
      : 'The model returned no image.',
    undefined,
    true,
    false
  );
}

/** The chain to run, or a clear error if there is nothing in it. */
function requireCredentials(apiKey) {
  const chain = credentials(apiKey);
  if (!chain.length)
    throw new GeminiError(
      'No way to reach a model. Add your own API key in AI settings, or turn the shared service back on.'
    );
  return chain;
}

/**
 * Edit one image. The whole fallback stack sits under this call.
 *
 * @param {{imageBase64:string, mimeType:string, prompt:string}} input
 * @returns {Promise<string>} the edited image as a data: URL
 */
export function editImage(input, { apiKey, model, signal, onStatus, onModel, onCredential } = {}) {
  return withFallbackChain({
    credentials: requireCredentials(apiKey),
    first: model || DEFAULT_MODEL,
    listModels: (cred) => listModelsOn(cred, signal),
    onModel,
    onCredential,
    onFallback: ({ from, to, reason }) => {
      console.info(`[gemini] ${from} refused this edit, retrying on ${to}. ${reason}`);
      onStatus?.(`${from} refused — trying ${to}…`);
    },
    attempt: (cred, chosen) => {
      onStatus?.(`Rendering with ${chosen} via ${cred.label}…`);
      return runEdit(input, cred, chosen, signal);
    }
  });
}
