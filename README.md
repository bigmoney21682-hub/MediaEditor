# MediaEditor

A layered photo editor that runs entirely in the browser, installable as a PWA and usable offline.

Open a photo, edit it with crop / brush / shapes / text / stacked images, run an **age transform**
on any faces in the shot, and export to PNG, JPEG, WebP, PDF, SVG, MP4 or a re-openable project file.

Nothing is uploaded. Face detection, the age transform and every export run on your device.

---

## Quick start

```bash
npm install        # also pulls the MediaPipe wasm runtime
npm run dev        # http://127.0.0.1:5290
npm run build      # production bundle in dist/
npm run preview    # serve the built bundle on http://127.0.0.1:5291
```

## Editing

| Tool | Key | What it does |
|---|---|---|
| Move | `V` | Select, drag, scale from any handle, rotate from the top dot |
| Crop | `C` | Free or fixed-aspect crop with rule-of-thirds guides |
| Brush | `B` | Soft-edged painting; always lands on its own layer above the photo |
| Eraser | `E` | Erases within the selected layer only |
| Rect / Ellipse / Line | `R` `O` `L` | Fill, stroke, corner radius, dashes, arrowheads |
| Text | `T` | Edited in place on the canvas; font, size, weight, alignment, outline |
| Image | `I` | Adds another photo as a layer — or drag files in, or paste with `⌘V` |

Layers reorder by dragging, and carry opacity, all 16 canvas blend modes, lock and visibility.
`⌘Z` / `⇧⌘Z` undo and redo, `[` and `]` restack, arrow keys nudge, `⌘0` fits to screen.

Undo is snapshot-based with copy-on-write raster layers, so a history step costs an object clone
rather than a full bitmap copy.

## Age transform

Detects every face with [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe)
(478 landmarks, running locally through WebAssembly), then ages or de-ages them by 5, 10, 25 or any
number of years up to 40. The result arrives as a new layer, so the original is never overwritten.

Two engines:

**On-device (default).** A physical simulation, not a generative model. It reshapes the face with a
Delaunay-triangulated piecewise-affine mesh warp — jowls and cheeks fall, brows and lids droop, lips
thin, the nose lengthens — and layers texture on top: procedural creases placed from the landmarks
(forehead bands, glabellar lines, crow's feet, nasolabial folds, marionette lines, perioral lines),
high-pass detail amplification, pigmentation, and luminance-keyed hair desaturation. Going younger
inverts the geometry and swaps the texture pass for edge-aware smoothing with detail restored on top.

Everything is authored in face-local units along the face's own up/right axes, so it is
resolution- and rotation-independent, and each pass is masked to the skin — eyes, brows and lips are
excluded so they stay sharp.

It is convincing, and it is a simulation: it will not predict how a *specific* person actually ages.

**AI backend (optional, bring your own key).** For photoreal output, point the app at a generative
model. Configure it under *Age Transform → AI settings*. Keys are stored only in your browser's
localStorage, and nothing is sent anywhere until you pick this engine and press Apply.

If no face is found, drag a box around one on the Original and the skin and colour passes still run
(face-shape changes need landmarks).

### Wiring up an AI backend

Pick **Custom endpoint** and implement this contract:

```
POST <your endpoint>
{ "image": "data:image/jpeg;base64,…", "years": 25, "direction": "older" }

200 { "image": "data:image/png;base64,…" }   // or an https URL
```

Browsers can only call an endpoint that returns permissive CORS headers, which is why hosted
inference APIs need a small relay of your own. A Cloudflare Worker is enough:

```js
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const { image, years, direction } = await req.json();
    const r = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.REPLICATE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: env.MODEL_VERSION,
        input: { image, target_age: String(direction === 'younger' ? 30 - years : 30 + years) }
      })
    });
    return cors(new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } }));
  }
};

const cors = (r) => {
  r.headers.set('access-control-allow-origin', '*');
  r.headers.set('access-control-allow-headers', 'content-type, authorization');
  return r;
};
```

Keep the token on the worker, not in the browser. The **Replicate** provider option talks to
`api.replicate.com` directly and accepts a `proxy` origin if you would rather relay it verbatim.

## Exporting

| Format | Notes |
|---|---|
| PNG | Transparency preserved, 25–400% scale |
| JPEG / WebP | Quality slider, flattened onto a background colour you choose |
| PDF | Page matched to the artwork, or A4 / Letter / A3 / A5 with the image centred |
| SVG | Shapes and text stay **real vectors**; photo and brush layers embed as PNG |
| MP4 / WebM | Ken Burns, pan, layer build-up, or a before/after dissolve of your edit |
| Project | `.mediaeditor.json` — the whole layer stack, re-openable here |

Video is recorded live through `MediaRecorder`, preferring H.264 MP4 and falling back to WebM on
browsers without it. The animation is driven by elapsed wall-clock time rather than a frame counter,
so the clip comes out the length you asked for even if a frame runs long — keep the tab visible while
it records.

## Offline / PWA

The app shell and the 3.6 MB landmark model are precached, so the editor and face detection work
offline from the moment the service worker installs. The 11 MB MediaPipe WebAssembly runtime is
cached on first use instead of up front, which keeps the install light — run the age transform once
while online and it is available offline from then on.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`. Enable it
once under **Settings → Pages → Source → GitHub Actions**. The workflow bakes the repository name in
as the base path, which is what a project site needs.

To host elsewhere, build with the right prefix and upload `dist/`:

```bash
BASE_PATH=/ npm run build
```

## How it fits together

```
src/
  state.js              document + layer model, snapshot undo with copy-on-write rasters
  render.js             compositor, viewport transform, hit testing
  tools.js              pointer gestures: select/transform, paint, shapes, in-place text, crop
  util.js               canvas, file and download helpers
  face/
    landmarks.js        MediaPipe wrapper + canonical landmark groups
    delaunay.js         Bowyer–Watson triangulation
    warp.js             piecewise-affine mesh warp, hulls, feathered outlines
    age.js              the age pipeline: geometry, creases, texture, colour, hair
    remote.js           optional generative backend (custom endpoint / Replicate)
  export/exporters.js   PNG, JPEG, WebP, PDF, SVG, video, project files
  ui/                   modal primitives, panels, the age and export dialogs
scripts/
  sync-wasm.mjs         copies the MediaPipe runtime out of node_modules into public/
  make-icons.mjs        renders the PWA icons from code — no binary assets to maintain
```

`sync-wasm` runs automatically before `dev` and `build`. The 11 MB WebAssembly runtime is not
committed; it is reproduced from the pinned npm dependency, which keeps it in lockstep with the
version in `package-lock.json`.

## Licence

MIT
