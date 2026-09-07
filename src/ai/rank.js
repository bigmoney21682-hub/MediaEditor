/**
 * Ranking image-*output* models.
 *
 * The analyzer apps rank models that describe a picture; this one ranks models
 * that draw one, so the filter is very nearly the mirror image of theirs. Where
 * ImageAnalysis scores `-image` variants at -100 because they read as vision
 * models by name but cannot write a report, here they are the only candidates
 * that can do the job at all: a text-only model handed a face and asked to age
 * it will happily return prose about what it would have drawn.
 */

/** Names that mean "this model returns pixels". Google's model listing does
 *  not flag output modality, so the ID is what we have to go on. */
const IMAGE_OUT = /-image($|-)|image-generation|image-preview|nano-banana/;

/** Generators we cannot drive with this request shape. Imagen takes a
 *  :predict call with its own body, not generateContent with an input photo,
 *  so it is not an alternate for an *edit* however good it is at synthesis. */
const NOT_EDITABLE = /^imagen|veo|embedding|tts|aqa|rerank/;

export function scoreModel(id) {
  const s = id.toLowerCase();
  if (NOT_EDITABLE.test(s)) return -100;
  if (!IMAGE_OUT.test(s)) return -100;

  let score = 0;

  // Flash image ("nano banana") is the editing model: it takes a photo in and
  // returns the same photo changed, which is exactly an age transform.
  if (s.includes('flash')) score += 30;

  // Pro image models render better and cost more. Second tier deliberately,
  // rather than by accident of scoring nothing at all — a handful of them are
  // in the listing now (gemini-3-pro-image and its preview), and when flash is
  // out of quota they are the next thing worth asking.
  else if (s.includes('pro')) score += 20;

  // Stable over preview, but only just — for a while the preview alias was the
  // only image model in the list, and ranking it below nothing is no help.
  if (/preview|exp/.test(s)) score -= 6;
  if (s.includes('latest')) score += 10;
  if (s.includes('lite')) score -= 15;

  // Newer generation numbers win, mildly. Takes the first plausible version
  // token: a bare int or decimal under 20, so parameter counts and date stamps
  // are not mistaken for versions.
  const version = s.match(/(?:^|[-/a-z])(\d{1,2})(?:\.(\d+))?(?![\d.a-z])/);
  if (version) score += Number(version[1]) * 2 + Number(version[2] ?? 0) / 10;

  return score;
}

/** Usable models, best first. Drops the outright unusable only — a model that
 *  merely scores badly stays in, because when the good one is rate-limited a
 *  mediocre render beats no render. */
export function rankModels(models) {
  return models
    .map((id) => ({ id, score: scoreModel(id) }))
    .filter((m) => m.score > -100)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

/** Best available model from a key's own list, or '' if none can draw. */
export const pickDefaultModel = (models) => rankModels(models)[0] ?? '';
