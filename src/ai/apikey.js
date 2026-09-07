/**
 * Key hygiene, shared in spirit with the Image/PCB/Schematic analyzers.
 *
 * Pasting a key on a phone is a good way to acquire a trailing newline, a
 * stray space, or a zero-width character from a docs page. Google rejects
 * those with "API key not valid", which reads like the key is wrong when it is
 * only dirty — so we clean it and say what we found.
 */

/** All Unicode whitespace, plus the zero-width family and BOM. */
export function sanitizeKey(raw) {
  return String(raw ?? '').replace(/[\s​-‍⁠﻿]/g, '');
}

/**
 * The Google key formats we know about: the long-standing "AIza" + 35
 * URL-safe base64 chars, and the newer 53-character "AQ." form AI Studio now
 * issues. Both work against the same endpoint.
 *
 * The lesson of the second one arriving is that this list will go stale again,
 * so an unrecognised shape is a *warning*, never an error. The Test button is
 * the only thing that actually knows.
 */
const GEMINI_FORMATS = [
  (k) => /^AIza[A-Za-z0-9_-]{35}$/.test(k),
  (k) => /^AQ\.[A-Za-z0-9._-]{20,}$/.test(k)
];

/** @returns {{level:'ok'|'warn'|'error', message:string}|null} */
export function diagnoseKey(raw) {
  if (!raw) return null;

  const clean = sanitizeKey(raw);
  const stripped = raw.length - clean.length;
  if (stripped > 0) {
    return {
      level: 'warn',
      message: `Removed ${stripped} whitespace or invisible character${stripped === 1 ? '' : 's'} from the pasted key. That alone causes "API key not valid" — try again now.`
    };
  }

  if (GEMINI_FORMATS.some((f) => f(clean))) return { level: 'ok', message: `${clean.length} characters, well-formed.` };

  // A truncated AIza key is the one case worth calling wrong outright: it is
  // the common paste mistake, and the shape is unambiguous.
  if (clean.startsWith('AIza') && clean.length !== 39) {
    return {
      level: 'error',
      message: `This key starts "AIza" but is ${clean.length} characters rather than 39. It looks ${clean.length < 39 ? 'truncated — check you selected the whole string' : 'to have extra characters on the end'}.`
    };
  }

  return {
    level: 'warn',
    message: `This does not match a Google key format we recognise (${clean.length} characters, starting "${clean.slice(0, 4)}"). That may just mean Google has issued a new format — press Test, which asks Google rather than guessing.`
  };
}
