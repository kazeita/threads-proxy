// Parsing and normalising Threads links.

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CODE_RE = /^[A-Za-z0-9_-]{6,20}$/;
const USER_RE = /^[A-Za-z0-9._]{1,40}$/;
const THREADS_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);

// Instagram/Threads IDs carry a millisecond timestamp in their top 41 bits.
const IG_EPOCH_MS = 1314220021721n;

export const THREADS_ORIGIN = 'https://www.threads.com';

/**
 * Accepts anything a person might paste and returns { code, username } or null.
 *   https://www.threads.com/@zuck/post/Ddt7cL5EfUG?xmt=...
 *   threads.net/@zuck/post/Ddt7cL5EfUG/media
 *   https://www.threads.com/t/Ddt7cL5EfUG
 *   @zuck/post/Ddt7cL5EfUG
 *   Ddt7cL5EfUG
 */
export function parseThreadsRef(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;

  // Bare shortcode
  if (CODE_RE.test(s) && !s.startsWith('@')) return { code: s, username: null };

  // Relative paths like "@user/post/CODE" or "/t/CODE"
  if (!/^[a-z]+:\/\//i.test(s)) {
    if (/^(www\.)?threads\.(com|net)\//i.test(s)) s = 'https://' + s;
    else s = THREADS_ORIGIN + (s.startsWith('/') ? '' : '/') + s;
  }

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!THREADS_HOSTS.has(u.hostname.toLowerCase())) return null;
  return parseThreadsPath(u.pathname);
}

/** Parses a Threads-style path (also used for mirrored paths on this proxy). */
export function parseThreadsPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.split('/').filter(Boolean);
  // /@user/post/CODE[/...]
  if (parts.length >= 3 && parts[0].startsWith('@') && parts[1] === 'post') {
    const username = parts[0].slice(1);
    const code = parts[2];
    if (CODE_RE.test(code) && USER_RE.test(username)) return { code, username };
    return null;
  }
  // /t/CODE[/...]
  if (parts.length >= 2 && parts[0] === 't' && CODE_RE.test(parts[1])) {
    return { code: parts[1], username: null };
  }
  return null;
}

export function canonicalUrl({ code, username }) {
  return username ? `${THREADS_ORIGIN}/@${username}/post/${code}` : `${THREADS_ORIGIN}/t/${code}`;
}

export function embedUrl({ code }) {
  // The username segment is ignored by Threads, so /t/CODE works for every post.
  return `${THREADS_ORIGIN}/t/${code}/embed`;
}

/** Shortcode -> numeric media ID (as a string; it doesn't fit in a JS number). */
export function mediaIdFromCode(code) {
  let id = 0n;
  for (const ch of code) {
    const v = SHORTCODE_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

/** Creation time encoded in the shortcode, as an ISO string (null if implausible). */
export function createdAtFromCode(code) {
  const id = mediaIdFromCode(code);
  if (!id) return null;
  const ms = Number((BigInt(id) >> 23n) + IG_EPOCH_MS);
  // Sanity window: Threads launched in 2023; allow a day of clock skew.
  if (ms < Date.UTC(2023, 0, 1) || ms > Date.now() + 86_400_000) return null;
  return new Date(ms).toISOString();
}

/** Turns l.facebook.com / l.threads.com redirect wrappers into the real link and drops tracking params. */
export function unwrapLink(href) {
  if (!href) return href;
  let u;
  try {
    u = new URL(href, THREADS_ORIGIN);
  } catch {
    return href;
  }
  if (/^l\.(facebook|threads|instagram)\.com$/i.test(u.hostname) && u.searchParams.get('u')) {
    return unwrapLink(u.searchParams.get('u'));
  }
  if (THREADS_HOSTS.has(u.hostname.toLowerCase())) {
    u.searchParams.delete('xmt');
    u.searchParams.delete('slof');
  }
  return u.toString();
}

export function isThreadsHost(hostname) {
  return THREADS_HOSTS.has(String(hostname).toLowerCase());
}
