/**
 * Cloudflare Workers AI — the engine that needs no API key at all.
 *
 * Everything in gemini.js assumes a credential: a key the viewer typed, or a
 * pool the Worker holds. This route has neither. The Worker's AI binding
 * authenticates as the Cloudflare account itself, so the browser sends a photo
 * and a prompt to worker/'s /edit and gets an edited photo back, with nothing
 * to configure and nothing to leak.
 *
 * That is why it is the default engine. Google's image models are better at
 * holding a composition still, and they are not available on a free key at
 * all — see the free-tier note in gemini.js — so the honest default is the one
 * that works for someone who has just opened the app.
 *
 * There is no model fallback here because there is no model list: the Worker
 * names the model it runs. The credential chain still applies, in the reduced
 * form that makes sense — a custom Worker of your own before the shared one.
 *
 * The Worker runs Stable Diffusion inpainting, which is why this provider asks
 * for a mask and a short prompt where the Gemini one asks for neither. Both of
 * those come from aiage.js, which knows where the face is.
 */

import { credentials, quotaStore } from './proxy.js';
import { AGE_NEGATIVE_PROMPT } from './prompt.js';

export class WorkersAIError extends Error {
  constructor(message, status, credentialRetryable = false) {
    super(message);
    this.name = 'WorkersAIError';
    this.status = status;
    /** Never worth another model (there is one), sometimes worth another
     *  deployment. See fallback.js for why the two are separate answers. */
    this.retryable = false;
    this.credentialRetryable = credentialRetryable;
  }
}

/** Routes that can run /edit. The viewer's own Google key cannot: it buys
 *  access to Google, and this endpoint lives on a Worker. */
const routes = () => credentials().filter((c) => c.kind !== 'own');

function friendlyError(status, body, label) {
  const message = (() => {
    try {
      return JSON.parse(body)?.error?.message ?? '';
    } catch {
      return '';
    }
  })();

  if (status === 404)
    return (
      `${label} does not have the /edit route. It is running an older copy of ` +
      'worker/ — redeploy it, or turn the shared service back on.'
    );
  if (status === 429)
    return message || `${label} has hit its daily limit for your address. The on-device engine has none.`;
  if (status === 413) return 'That photo is too large. Age one face at a time rather than the whole photo.';
  if (status === 403)
    return (
      `${label} refused this site's origin. Its ALLOWED_ORIGIN needs to list ` +
      `${location.origin}.`
    );
  if (status === 502)
    return message
      ? `The image model refused: ${message}`
      : 'The image model failed. Usually transient — try again.';
  return message || `${label} returned HTTP ${status}.`;
}

/**
 * @param {object} input
 * @param {string} input.imageBase64  the region to edit
 * @param {string} input.maskBase64   white where the model may paint
 * @param {string} input.shortPrompt  CLIP-length; see prompt.js for why
 * @param {number} input.modelStrength how far it may travel from the original
 * @returns {Promise<string>} the edited image as a data: URL
 */
export async function editImage(
  { imageBase64, maskBase64, shortPrompt, prompt, modelStrength = 0.6 },
  { signal, onStatus, onCredential } = {}
) {
  const chain = routes();
  if (!chain.length)
    throw new WorkersAIError(
      'No service to render on. Turn the shared service back on in AI settings, or point it at a Worker of your own.'
    );

  let firstError;

  for (const cred of chain) {
    try {
      onStatus?.(`Rendering on ${cred.label}…`);

      const res = await fetch(`${cred.base}/edit`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(cred.token ? { 'X-App-Token': cred.token } : {})
        },
        body: JSON.stringify({
          prompt: shortPrompt || prompt,
          negative_prompt: AGE_NEGATIVE_PROMPT,
          image_b64: imageBase64,
          mask_b64: maskBase64,
          strength: modelStrength
        })
      }).catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new WorkersAIError(
          `Could not reach ${cred.label} at ${new URL(cred.base).host}. Either it is ` +
            'not deployed, its origin allowlist does not include this site, or you are offline.',
          undefined,
          true
        );
      });

      quotaStore.readFrom(res);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // A refusal by the model is about this photo and will repeat on any
        // deployment; a missing route or a dead host is about this deployment.
        throw new WorkersAIError(friendlyError(res.status, body, cred.label), res.status, res.status === 404);
      }

      const json = await res.json();
      if (!json?.image) throw new WorkersAIError('The service returned no image.', undefined, true);

      onCredential?.(cred);
      return `data:image/png;base64,${json.image}`;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (e?.credentialRetryable !== true) throw e;
      // Same reasoning as the Gemini chain: keep the first failure, since it
      // belongs to the route the viewer actually configured.
      if (firstError === undefined) firstError = e;
    }
  }

  throw firstError ?? new WorkersAIError('No service to render on.');
}

/** What aiage.js needs to know to drive this provider. */
export const provider = {
  id: 'cloudflare',
  label: 'Workers AI',
  /** SD 1.5 works at 512; anything larger is upscaled on the way in and
   *  downscaled on the way out, which costs detail for nothing. */
  sendMax: 512,
  /** Inpainting is the whole reason it preserves the photo. */
  needsMask: true,
  /** PNG both ways: the mask must be exact, and sending the image in a
   *  different format from its mask is a needless difference. */
  sendMime: 'image/png',
  edit: editImage
};
