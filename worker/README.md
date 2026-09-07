# Shared model proxy

A Cloudflare Worker that holds a **pool** of Google API keys server-side, so
MediaEditor's age transform can be shared as a plain link instead of asking
every visitor for a key of their own. When one key runs out of free quota the
Worker rotates to the next, so the link does not go down at the first daily cap.

It is the same Worker the Image, PCB and Schematic analyzers deploy, trimmed to
one vendor. Those apps also route Groq as a fallback, which makes sense for a
*description* of an image and none at all here: Groq has no image-output model,
so an age transform has nothing to fall over to. A vendor route nobody calls is
an open relay waiting for the URL to leak, so it is not carried over.

## Read this before deploying it

The app calls Google directly from the browser whenever the viewer has supplied
their own key. No photo touches any server you run in that case, which for a
photograph of someone's face is a deliberate property, not an accident of the
architecture.

This Worker gives that up for everyone who has no key of their own. Every photo
edited through it passes through your Cloudflare account. Cloudflare does not
retain request bodies by default, and `index.js` never logs one — keep it that
way. If you add debugging, do not log `request.body`.

**It also spends your quota on strangers**, and image generation is an order of
magnitude more expensive per request than the analyzers' text answers. A URL in
a published app is a URL that will be found. Four things stand between the pool
and abuse, and you should set all of them:

| Control | Where | Default |
| --- | --- | --- |
| Origin allowlist | `ALLOWED_ORIGIN` in `wrangler.toml` | set to the Pages origin |
| Path allowlist | `UPSTREAMS.google.paths` in `index.js` | the two endpoints the app calls |
| Per-IP daily cap | `RATE_LIMIT` KV + `DAILY_CAP` | **off until you bind the KV namespace** |
| Passphrase | `APP_TOKEN` secret | **off until you set it** |

The passphrase is optional because a public app cannot really keep one secret —
it ships in the JavaScript bundle. Set it anyway if the proxy is for a team
rather than the public. For a genuinely public deployment the origin allowlist
and the daily cap are doing the work.

## Deploy

From this directory. `wrangler` needs a browser login the first time.

```sh
npx wrangler login
```

Set the key pool — a comma- or newline-separated list. Free keys are free, so
several from different accounts is the cheapest way to multiply the quota
behind a shared link:

```sh
npx wrangler secret put GEMINI_KEYS   # AIzaOne,AIzaTwo,AIzaThree
```

Bind a KV namespace so the per-IP cap actually applies:

```sh
npx wrangler kv namespace create RATE_LIMIT
```

Paste the id it prints into the commented `[[kv_namespaces]]` block in
`wrangler.toml` and uncomment it. Adjust `DAILY_CAP` to taste — 15 renders per
address per day is the shipped figure, which is roughly half a dozen transforms
once group photos are counted a face at a time.

Optionally set a passphrase:

```sh
npx wrangler secret put APP_TOKEN     # openssl rand -base64 24
```

Check that `ALLOWED_ORIGIN` matches where the app is served from — origin only,
no path, no trailing slash. For the GitHub Pages deployment that is
`https://<user>.github.io`.

```sh
npx wrangler deploy
```

Wrangler prints the Worker URL. Put it in `SHARED_PROXY_URL` at the top of
`src/ai/proxy.js` (and `SHARED_PROXY_TOKEN` if you set a passphrase) and
rebuild — that is what makes the shared service the app's built-in default. A
viewer can still point at a different deployment under **Age Transform → AI
settings → Your proxy**, or turn the shared service off entirely.

## The allowance endpoint

`GET /quota` reports the caller's remaining daily allowance **without spending
any of it**, which is what lets the dialog show what is left before anyone has
uploaded anything:

```json
{ "enabled": true, "limit": 15, "used": 4, "remaining": 11, "reset": "2026-09-08T24:00:00Z" }
```

`enabled: false` means no KV namespace is bound, so there is no cap and the app
shows no meter rather than an invented one. Every proxied response also carries
the same figures as `X-Quota-Limit` / `-Used` / `-Remaining` / `-Reset` headers,
listed in `Access-Control-Expose-Headers` so the browser may actually read them.

## How a request picks its key

Two nested chains, outermost first. They exist separately because they fail for
unrelated reasons, and neither can fix the other's problem:

1. **Credential** (`src/ai/proxy.js`) — the viewer's own key, then a custom
   proxy, then this shared Worker.
2. **Model** (`src/ai/fallback.js`) — the chosen image model, then the next
   best one that credential can reach.

The analyzers have a third level above these — a second vendor — which this app
does not, for the reason at the top. The total is capped at 6 upstream calls per
transform, so a bad day surfaces as an error rather than a half-minute of silent
retrying.

Server side, this Worker then walks its own pool. The starting key is chosen at
random per request so one key does not absorb everything and hit its cap alone.
Only key-shaped faults advance the pool — a 429, a disabled project, a revoked
key. A malformed request or a safety block returns immediately, because it would
fail identically on every key.

## Why it refuses things

- **401** — passphrase missing or wrong, and `APP_TOKEN` is set. Compared as a
  SHA-256 digest so the comparison takes the same time regardless of where it
  first differs.
- **403** — the calling origin is not in `ALLOWED_ORIGIN`.
- **404 "does not forward"** — the path is not one the app uses. Video and
  Imagen endpoints are deliberately off the list, so a leaked URL cannot turn
  this into an open relay to everything the keys can reach.
- **413** — the request body is over 12 MB. The app sends about a megapixel.
- **500 "no GEMINI_KEYS secret"** — the pool is unset.
- **429 "daily limit for your address"** — the per-IP cap. The app tells the
  viewer to add their own key or fall back to the on-device engine, which costs
  them nothing and costs you nothing.

## Cost

Workers' free tier is 100k requests/day and 1k KV writes/day, and one transform
is one request plus one KV write per face. The Gemini keys behind it are the
thing with a real quota, and an image model spends it faster than a text one —
watch it before publishing the URL widely. Rotate the pool with
`wrangler secret put GEMINI_KEYS` at any time; clients need no change, since
they never see a key.
