/**
 * Model- and credential-level fallback, ported from the analyzer apps.
 *
 * One hardcoded model is the most common way an app like this breaks for
 * someone who did nothing wrong. Google retires an ID, the free tier's
 * per-minute cap trips, or a key simply cannot reach the model we asked for —
 * and all three surface as a dead end the user can only clear by opening
 * settings and guessing at a replacement.
 *
 * So a refusal is not the end of the attempt. We walk down the ranked list of
 * image models the key can actually reach and try the next one. Only faults
 * another model could plausibly fix get retried: a bad key, a disabled API or
 * a safety refusal fails identically everywhere, and spending four more
 * requests to prove it just makes the error slower to arrive.
 */

import { rankModels } from './rank.js';

/** Total attempts including the first. Past five the user is waiting longer
 *  than a clear error is worth — and image generation is not a fast call. */
export const MAX_ATTEMPTS = 4;

/** Two credentials' worth of chain, capped so a bad day cannot turn into half
 *  a minute of silent retrying. */
export const MAX_REQUESTS = 6;

/** Providers set `retryable` on errors where a different model is worth a shot. */
export const isRetryable = (err) => err?.retryable === true;

/** …and `credentialRetryable` on the ones a different *credential* could fix.
 *  The two are usually the same answer, and GeminiError defaults them that
 *  way; the cases that separate them are documented there. */
export const isCredentialRetryable = (err) => err?.credentialRetryable === true;

const aborted = (e) => e instanceof DOMException && e.name === 'AbortError';

export async function withModelFallback({
  first,
  listModels,
  attempt,
  onFallback,
  onModel,
  budget = { left: MAX_ATTEMPTS }
}) {
  const tried = new Set();
  let alternates = null;
  let current = first;
  let lastError;

  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    if (budget.left <= 0) break;
    budget.left--;
    tried.add(current);
    try {
      const result = await attempt(current);
      onModel?.(current);
      return result;
    } catch (e) {
      // Cancelling is the user's decision, not a fault to route around.
      if (aborted(e)) throw e;
      if (!isRetryable(e)) throw e;
      lastError = e;

      if (alternates === null) {
        try {
          alternates = rankModels(await listModels());
        } catch {
          // If we cannot even list the alternatives, the original error is the
          // honest one to show — not a complaint about the model list.
          throw e;
        }
      }

      const next = alternates.find((m) => !tried.has(m));
      if (!next) throw e;

      onFallback?.({ from: current, to: next, reason: e instanceof Error ? e.message : String(e) });
      current = next;
    }
  }

  throw lastError ?? new Error(`Gave up after ${MAX_ATTEMPTS} models.`);
}

/**
 * The credential chain, wrapped around the model chain.
 *
 * Two things can be exhausted independently: a model (retired, rate-limited)
 * and a key (daily cap spent, project disabled). Walking models under one key
 * cannot fix a spent key, and swapping keys cannot fix a retired model — so
 * the chains nest. Every model is tried on the viewer's own key before the
 * shared pool is touched, which keeps the owner's quota the last resort rather
 * than the first.
 */
export async function withFallbackChain({
  credentials,
  first,
  listModels,
  attempt,
  onFallback,
  onModel,
  onCredential
}) {
  const budget = { left: MAX_REQUESTS };
  // The first credential's failure is the one to keep. It is the viewer's own
  // key — the only route in the chain they can actually do anything about —
  // and "your key is rate limited" is a far more useful last word than "the
  // shared service we fell through to is also down".
  let firstError;

  for (const cred of credentials) {
    if (budget.left <= 0) break;
    try {
      const result = await withModelFallback({
        first,
        budget,
        listModels: () => listModels(cred),
        attempt: (model) => attempt(cred, model),
        onFallback,
        onModel
      });
      onCredential?.(cred);
      return result;
    } catch (e) {
      if (aborted(e)) throw e;
      // Not `isRetryable`: the model chain has already exhausted itself under
      // this credential, so the only question left is whether another key
      // would answer differently.
      if (!isCredentialRetryable(e)) throw e;
      if (firstError === undefined) firstError = e;
    }
  }

  throw firstError ?? new Error('No credentials are configured. Add an API key in AI settings.');
}
