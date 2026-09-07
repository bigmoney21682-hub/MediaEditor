/**
 * The instruction sent with the photo.
 *
 * An age transform is an *edit*, not a generation, and the difference is the
 * whole prompt: everything that is not ageing must survive untouched, or the
 * result cannot be composited back over the original and stops being a photo
 * of that person. So the prompt is mostly a list of things to hold still.
 *
 * The three toggles in the dialog are the same ones the on-device engine in
 * face/age.js honours, worded for a model rather than for a warp: they turn
 * into instructions here instead of into passes.
 */

const OLDER = {
  15: 'slightly older — the first fine lines, marginally less taut skin',
  30: 'clearly older — established expression lines, softer jawline, some greying at the temples',
  60: 'much older — deep-set wrinkles, hollowing and sagging of the soft tissue, substantially grey hair'
};

const YOUNGER = {
  15: 'slightly younger — smoother skin, a little more fullness',
  30: 'clearly younger — smooth skin, fuller cheeks, no grey',
  60: 'much younger — the same person in early adulthood: taut skin, full features, thick unfaded hair'
};

/** Buckets the delta so the wording stays concrete. A model does far better
 *  with "deep-set wrinkles" than with the number 37. */
function severity(years, direction) {
  const table = direction === 'younger' ? YOUNGER : OLDER;
  const band = years <= 8 ? 15 : years <= 20 ? 30 : 60;
  return table[band];
}

export function buildAgePrompt({ years, direction, geometry = true, skinTexture = true, hair = true, scope = 'face' }) {
  const older = direction !== 'younger';
  const verb = older ? 'older' : 'younger';

  const changes = [];
  if (skinTexture)
    changes.push(
      older
        ? 'Skin: age the texture — wrinkles and creases where this face actually creases, uneven tone, age spots, thinner and less elastic skin.'
        : 'Skin: smooth the texture — remove wrinkles, creases, spots and blemishes of age, restore an even youthful tone.'
    );
  if (geometry)
    changes.push(
      older
        ? 'Structure: age the underlying form — soften the jawline, hollow the temples and cheeks, let the soft tissue descend, thin the lips slightly, add lid laxity.'
        : 'Structure: restore youthful form — fuller cheeks and lips, a firmer jawline, tighter eyelids, less hollowing.'
    );
  if (hair)
    changes.push(
      older
        ? 'Hair: grey and thin it appropriately, including brows and any facial hair; recede the hairline only as much as the years warrant.'
        : 'Hair: restore its natural colour and density, including brows and facial hair.'
    );

  if (!changes.length) changes.push(`Apply a natural overall ${verb} appearance.`);

  const hold = [
    'the same person — identity, bone structure and every distinguishing feature must remain recognisable',
    'the exact pose, head angle, gaze direction and expression',
    'the framing, crop, scale and position of the head within the frame',
    'the lighting, its direction and colour, and the shadows it casts',
    'the background, clothing and any other people or objects',
    'the camera characteristics — focus, grain, depth of field and overall photographic quality'
  ];

  // The opening sentence earns its place. Editing models drift — a prompt that
  // leads with the change produces a new photograph of a similar person, with
  // a different expression and different clothes, while one that leads with
  // what must not move holds the frame far more often. Measured side by side
  // on the same input, this ordering was the difference between a portrait
  // that could be composited back and one that could not.
  return [
    'Keep this photograph exactly as it is: the same person — the same face, the same sex, the same ethnicity, the same hairstyle, the same distinguishing features — and the same crop and framing, head angle and pose, expression, clothing, background and lighting.',
    '',
    `Change one thing only — the apparent age of the ${scope === 'face' ? 'person shown' : 'people shown'}, by approximately ${years} years ${verb}: ${severity(years, direction)}.`,
    '',
    'Change only what ageing changes:',
    ...changes.map((c) => `- ${c}`),
    '',
    'Keep unchanged:',
    ...hold.map((h) => `- ${h}`),
    '',
    'Return the edited photograph at the same aspect ratio and framing as the input.',
    'It must read as an ordinary photograph of that person at a different age — photorealistic, not stylised, not illustrated, not retouched into a different face.'
  ].join('\n');
}

/**
 * The same request, compressed for a CLIP-conditioned model.
 *
 * Stable Diffusion reads roughly 77 tokens and then stops, so the careful
 * instruction list above reaches it as its first two lines and nothing else —
 * which is exactly the half that says "keep everything the same" and none of
 * the half that says what to change. Inpainting also makes most of that list
 * redundant: the mask already holds the pose, the framing and the background,
 * because those pixels are never touched.
 *
 * So this is a description of the wanted result rather than a set of
 * instructions, which is the register these models were trained on.
 */
export function buildShortAgePrompt({ years, direction, skinTexture = true, hair = true }) {
  const older = direction !== 'younger';
  const bits = [`portrait photograph of the same person, ${years} years ${older ? 'older' : 'younger'}`];

  if (skinTexture)
    bits.push(older ? 'aged wrinkled skin, deep creases, age spots' : 'smooth youthful skin, no wrinkles');
  if (hair) bits.push(older ? 'grey thinning hair' : 'full natural-coloured hair');
  if (older && years > 20) bits.push('sagging jawline, hollow cheeks');

  bits.push('same face, same pose, same expression, photorealistic, sharp focus');
  return bits.join(', ');
}

/** What Stable Diffusion must not draw. Cheap insurance against the two things
 *  it does unprompted to a face: smoothing it into a portrait painting, and
 *  turning a mild age change into a caricature. */
export const AGE_NEGATIVE_PROMPT =
  'cartoon, illustration, painting, 3d render, distorted face, extra faces, blurry, low quality, different person';
