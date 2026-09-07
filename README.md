# MediaEditor

**[Open the app →](https://bigmoney21682-hub.github.io/MediaEditor/)**

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

**AI model (optional).** For photoreal output there are two hosted backends, and one of them is free.

*Cloudflare Workers AI (the default).* The Worker in `worker/` runs Stable Diffusion inpainting on
Cloudflare's own AI binding, which authenticates as the account that deployed it — **there is no API
key anywhere in this path**, and the account's free daily allowance covers ordinary use. It takes the
face crop and a mask of what may change, so the pixels outside the mask are mathematically
untouched: same pose, same clothing, same background, every time. It is a 512px model and softer
than a current one; that is the price of the only free image editing on offer.

*Google Gemini.* The same stack the Image Analysis, PCB Analyzer and Schematic Analyzer apps use —
the same credential chain, the same model fallback, the same Worker. Better at holding a composition
still, and **it needs a key from a project with billing enabled**: Google's free tier does not carry
the image models at all, so a free key answers every transform with a quota error however new it is.

Either way it is never the default engine and never runs unattended: the first time you select the
AI engine the dialog says where the photo would go and asks once, deliberately, before anything is
uploaded. The preview pane always stays on-device; the model is only called when you press Apply,
and Cancel becomes Stop while it is in flight.

**Where a Gemini request goes**, in order — each step only reached when the one before it cannot
serve:

| Credential | Route | Cost |
| --- | --- | --- |
| Your own Google key | browser → Google directly | nothing touches a server of ours |
| Your Worker | your own deployment of `worker/` | your Cloudflare account |
| The shared service | the Worker this repo ships | someone else's key pool and daily cap |

Under that sits model fallback: if the chosen image model is retired, invisible to that key, or rate
limited, the next best one the key can actually reach is tried instead. Six upstream calls is the
ceiling, so a bad day surfaces as an error rather than half a minute of silent retrying.

**What the model is allowed to touch.** The obvious integration sends the whole photo and puts what
comes back on a layer, which is wrong for an editor: the model redraws every pixel, so the
background shifts, the grain changes, and a portrait of two people ages both when you asked about
one. So *Model sees → Face region* (the default) sends a padded square crop around each detected face
and composites the result back through a feathered mask — everything outside it is still your
original file. *Whole photo* is there for the times the crop is the wrong unit, like a full-length
shot.

The **Strength** slider mixes the returned face over the original, so a result that overshoots is
dialled back rather than re-rendered.

If no face is found, drag a box around one on the Original. The on-device skin and colour passes
still run (face-shape changes need landmarks), and the AI engine uses the box as its crop.

### A note on FLUX

Cloudflare lists `flux-2-klein-4b` as unifying "generation and editing", it accepts an input image in
its multipart body without complaint, and its output is far better looking than the inpainting
model's. It also ignores the image entirely. Asked to add a green dot to a photograph of a face, it
returned a green dot on a wall it had invented; every "edit" it produced was text-to-image, and
looked convincing only because the prompt described the input in words. Cloudflare's own catalogue
calls its task Text-to-Image. If that changes, `worker/index.js` is the one file to edit.

### Running the shared proxy yourself

`worker/` does two jobs: it runs the free Workers AI route on `/edit`, and it holds a pool of Google
keys server-side so a plain link works for someone who has no key of their own. Deploy notes, the
limits to set before publishing the URL, and what each refusal means are in
[`worker/README.md`](worker/README.md). Put the URL it prints into `SHARED_PROXY_URL` at the top of
`src/ai/proxy.js`.

### The other two backends

**Custom endpoint** — implement this contract and point the app at it:

```
POST <your endpoint>
{ "image": "data:image/jpeg;base64,…", "years": 25, "direction": "older" }

200 { "image": "data:image/png;base64,…" }   // or an https URL
```

**Replicate** — talks to `api.replicate.com`, which sends no CORS headers, so it needs a relay of
your own; the *Relay* field takes its origin. Keep the token on the relay rather than in the browser.

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
  ai/                   the analyzer apps' model stack, ported
    proxy.js            credential chain: your key, your proxy, the shared service
    gemini.js           image editing through generateContent, with friendly errors
    workersai.js        the keyless route: worker//edit, Stable Diffusion inpainting
    fallback.js         model- and credential-level retry
    rank.js             which of a key's models can actually draw
    apikey.js           key hygiene and diagnosis
    prompt.js           the age-transform instruction
  face/
    landmarks.js        MediaPipe wrapper + canonical landmark groups
    delaunay.js         Bowyer–Watson triangulation
    warp.js             piecewise-affine mesh warp, hulls, feathered outlines
    age.js              the age pipeline: geometry, creases, texture, colour, hair
    remote.js           which AI backend a request goes to, and the two older transports
    aiage.js            crops each face, calls the model, composites the result back
  export/exporters.js   PNG, JPEG, WebP, PDF, SVG, video, project files
  ui/                   modal primitives, panels, the age and export dialogs
worker/                 Cloudflare Worker: the shared key pool behind the AI engine
scripts/
  sync-wasm.mjs         copies the MediaPipe runtime out of node_modules into public/
  make-icons.mjs        renders the PWA icons from code — no binary assets to maintain
```

`sync-wasm` runs automatically before `dev` and `build`. The 11 MB WebAssembly runtime is not
committed; it is reproduced from the pinned npm dependency, which keeps it in lockstep with the
version in `package-lock.json`.

## Licence

MIT
