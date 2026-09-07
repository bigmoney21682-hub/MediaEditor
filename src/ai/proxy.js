/**
 * Where the credentials for a model request come from.
 *
 * Ported from the analyzer apps (ImageAnalysis, PCB, Schematic) so all four
 * share one story about keys, proxies and quota. Three sources, in this order:
 *
 *   1. The viewer's own key, typed into AI settings. Goes browser-to-Google
 *      directly — the photo touches no server we run, which for someone's face
 *      is the point rather than a detail.
 *   2. The shared proxy: a Cloudflare Worker holding a pool of the owner's
 *      keys, so a plain link works for someone with no key of their own. Every
 *      photo sent this way travels through whoever runs that Worker.
 *   3. A custom proxy the viewer points at themselves — their own deployment
 *      of worker/, for a team that wants the shared-link convenience without
 *      the shared operator.
 *
 * A viewer's own key overrides the shared pool and also adds to it: if their
 * key is exhausted the chain falls through rather than stopping. Turning the
 * shared service off removes it entirely, which is the setting to use when no
 * photo may leave the browser except to the model vendor.
 *
 * Only Google is fronted here. The analyzers also route Groq, which is a fine
 * second opinion on a *description* of an image; it has no image-output model,
 * so for an age transform there is nothing for it to fall over to.
 */

/**
 * The shared proxy, baked in so a link works with no setup. Deploy worker/ and
 * put its URL here — empty means every viewer brings their own key.
 *
 * SHARED_PROXY_TOKEN is a gate, not a secret: it ships in the bundle and
 * anyone who opens devtools can read it. Its only job is to stop drive-by
 * scripted abuse of the URL. The real limits are the Worker's origin allowlist
 * and its per-IP daily cap.
 */
const SHARED_PROXY_URL = 'https://mediaeditor-proxy.bigmoney21682.workers.dev';
const SHARED_PROXY_TOKEN = '';

const KEY_URL = 'me.proxy.url';
const KEY_TOKEN = 'me.proxy.token';
const KEY_SHARED_OFF = 'me.proxy.shared-off';
const KEY_API = 'me.apiKey.gemini';
const KEY_MODEL = 'me.model.gemini';

/** Trailing slashes produce "//models" once a path is appended, which Google
 *  404s in a way that reads like the model is missing. */
const clean = (v) => (v ?? '').trim().replace(/\/+$/, '');

const read = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k, v) => {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ }
};

/** The key lives only in this browser and is sent only to Google's own
 *  endpoint — never to the host serving the app. */
export const apiKeyStore = {
  get: () => read(KEY_API) ?? '',
  set: (v) => write(KEY_API, (v ?? '').replace(/[\s​-‍⁠﻿]/g, ''))
};

/** Empty means "use the provider's default". */
export const modelStore = {
  get: () => read(KEY_MODEL) ?? '',
  set: (v) => write(KEY_MODEL, (v ?? '').trim())
};

export const proxyStore = {
  get: () => ({ url: clean(read(KEY_URL)), token: (read(KEY_TOKEN) ?? '').trim() }),
  set: ({ url, token }) => {
    write(KEY_URL, clean(url));
    write(KEY_TOKEN, (token ?? '').trim());
  }
};

/** The shared pool is opt-out, so the default link works untouched. */
export const sharedProxyStore = {
  available: () => Boolean(SHARED_PROXY_URL),
  get: () => Boolean(SHARED_PROXY_URL) && read(KEY_SHARED_OFF) !== '1',
  set: (on) => write(KEY_SHARED_OFF, on ? '' : '1')
};

const GOOGLE_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The credentials to try, best first. Order is the whole design: the viewer's
 * own key first because it is theirs and it keeps the photo off our servers,
 * the shared pool last because it spends someone else's quota.
 *
 * @returns {{kind:'own'|'custom'|'shared', label:string, base:string, apiKey?:string, token?:string}[]}
 */
export function credentials(apiKey = apiKeyStore.get()) {
  const chain = [];
  const key = (apiKey ?? '').trim();
  const custom = proxyStore.get();

  if (key) chain.push({ kind: 'own', label: 'your API key', base: GOOGLE_ROOT, apiKey: key });
  if (custom.url) chain.push({ kind: 'custom', label: 'your proxy', base: custom.url, token: custom.token });
  if (sharedProxyStore.get()) chain.push({ kind: 'shared', label: 'the shared service', base: SHARED_PROXY_URL, token: SHARED_PROXY_TOKEN });

  return chain;
}

/** Whether a model can be reached at all right now. */
export const reachable = (apiKey) => credentials(apiKey).length > 0;

/**
 * URL and headers for one call on one credential. Google takes its key as a
 * query parameter; proxied calls never carry a viewer key at all — they send
 * the gate token and let the Worker attach one from its pool.
 */
export function route(cred, path, params = {}) {
  const query = new URLSearchParams(params);
  const headers = { 'Content-Type': 'application/json' };

  if (cred.kind === 'own') query.set('key', cred.apiKey ?? '');
  else if (cred.token) headers['X-App-Token'] = cred.token;

  const qs = query.toString();
  return { url: `${cred.base}${path}${qs ? `?${qs}` : ''}`, headers };
}

/**
 * The shared service's daily allowance for this browser's address.
 *
 * Two ways in, because neither alone is enough: /quota answers before anything
 * has been uploaded, which is what the dialog needs on open, and the response
 * headers on every real call keep it current without a second round trip.
 */
const listeners = new Set();
let current = null;

function publish(q) {
  current = q;
  for (const fn of listeners) fn(q);
}

export const quotaStore = {
  get: () => current,

  subscribe(fn) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },

  /** Picks the allowance off a proxied response. A no-op for direct calls,
   *  which carry no such headers and spend no shared quota. */
  readFrom(res) {
    const limit = res.headers.get('X-Quota-Limit');
    if (limit === null) return;
    publish({
      enabled: true,
      limit: Number(limit),
      used: Number(res.headers.get('X-Quota-Used') ?? 0),
      remaining: Number(res.headers.get('X-Quota-Remaining') ?? 0),
      reset: res.headers.get('X-Quota-Reset') ?? ''
    });
  },

  /** Asks the proxy outright, without spending any of it. */
  async refresh() {
    const proxied = credentials().find((c) => c.kind !== 'own');
    if (!proxied) {
      publish(null);
      return null;
    }
    try {
      const res = await fetch(`${proxied.base}/quota`, {
        headers: proxied.token ? { 'X-App-Token': proxied.token } : {}
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      publish({
        enabled: Boolean(json.enabled),
        limit: Number(json.limit ?? 0),
        used: Number(json.used ?? 0),
        remaining: Number(json.remaining ?? 0),
        reset: String(json.reset ?? '')
      });
      return current;
    } catch {
      // An unreachable proxy is not worth a banner of its own — the first real
      // request will say so far more usefully than a meter can.
      publish(null);
      return null;
    }
  }
};

/** True when something other than the viewer's own key can serve a request,
 *  so the app needn't insist on one before it will run. */
export const usingProxy = () => Boolean(proxyStore.get().url) || sharedProxyStore.get();
