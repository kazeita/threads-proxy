// Platform-neutral request handler: (Request) => Promise<Response>.
// Used by the Vercel function (api/index.js) and the local Node server (src/node-server.js).

import { fetchThread } from './threads.js';
import { fetchReddit } from './reddit.js';
import { UpstreamError } from './errors.js';
import { parseThreadsRef, parseThreadsPath, canonicalUrl } from './url.js';
import { parseRedditRef, parseRedditPath, redditProxyPath, redditCanonicalUrl } from './reddit-url.js';
import { renderHome, renderThread, renderError, renderMarkdown, renderText, renderLlmsTxt, mediaProxy } from './render.js';

const env = (k) => (typeof process !== 'undefined' ? process.env[k] : undefined);
const PUBLIC_URL = (env('PUBLIC_URL') || '').replace(/\/+$/, '');
const CACHE_TTL = Number(env('CACHE_TTL_SECONDS')) || 300;
const RATE_LIMIT = env('RATE_LIMIT_PER_MIN') != null ? Number(env('RATE_LIMIT_PER_MIN')) : 60;
const TRUST_PROXY = env('TRUST_PROXY') === '1' || !!env('VERCEL');

// Meta's CDN (Threads) and Reddit's media hosts (i.redd.it, v.redd.it, preview.redd.it, *.redditmedia.com, …).
const MEDIA_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net|redditmedia\.com|redditstatic\.com)$|\.redd\.it$/i;
const MEDIA_TYPES_RE = /^(image|video|audio)\/|^(application|binary)\/octet-stream|mpegurl/i;
const HLS_TYPE_RE = /mpegurl/i;

const CORS = { 'access-control-allow-origin': '*' };
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const HTML = 'text/html; charset=utf-8';
const JSON_T = 'application/json; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';

// ---------------------------------------------------------------------------
// Per-instance cache (serverless instances are reused while warm). The CDN cache
// (s-maxage) does the heavy lifting on Vercel.

const cache = new Map();
function getThread(ref) {
  const key = refKey(ref);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = isReddit(ref) ? fetchReddit(ref) : fetchThread(ref);
  cache.set(key, { promise, expires: Date.now() + CACHE_TTL * 1000 });
  promise.catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return promise;
}

// ---------------------------------------------------------------------------
// Refs: Threads { code, username } or Reddit { platform: 'reddit', id, subreddit, commentId } / { share }

const isReddit = (ref) => ref?.platform === 'reddit';
const parseRef = (s) => parseThreadsRef(s) || parseRedditRef(s);
const parsePath = (p) => parseThreadsPath(p) || parseRedditPath(p);
const refKey = (ref) => (isReddit(ref) ? `reddit:${ref.share ? `s/${ref.share}` : `${ref.id}/${ref.commentId || ''}`}` : ref.code);
const refUrl = (ref) => (isReddit(ref) ? redditCanonicalUrl(ref) : canonicalUrl(ref));
const refPath = (ref) => (isReddit(ref) ? redditProxyPath(ref) : `/t/${ref.code}`);

// Best-effort per-instance rate limit.
const hits = new Map();
function rateLimited(ip) {
  if (!RATE_LIMIT) return false;
  const now = Date.now();
  const w = hits.get(ip);
  if (!w || now - w.start > 60_000) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  return ++w.n > RATE_LIMIT;
}

// ---------------------------------------------------------------------------

function respond(body, status, type, extra = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...BASE_HEADERS, ...extra } });
}

function clientIp(req, info) {
  if (TRUST_PROXY) {
    const xf = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip');
    if (xf) return xf.split(',')[0].trim();
  }
  return info?.ip || 'unknown';
}

function originOf(req, url) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (TRUST_PROXY) {
    const host = req.headers.get('x-forwarded-host');
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0];
    if (host) return `${proto || 'https'}://${host}`;
  }
  return url.origin;
}

function decorate(result, origin) {
  const abs = (u) => (u ? origin + mediaProxy(u) : null);
  const fix = (p) =>
    p && {
      ...p,
      author: p.author ? { ...p.author, avatarProxyUrl: abs(p.author.avatar) } : p.author,
      media: (p.media || []).map((m) => ({
        ...m,
        proxyUrl: abs(m.url),
        ...(m.poster ? { posterProxyUrl: abs(m.poster) } : {}),
        ...(m.hlsUrl ? { hlsProxyUrl: abs(m.hlsUrl) } : {}),
      })),
      ...(p.community?.icon ? { community: { ...p.community, iconProxyUrl: abs(p.community.icon) } } : {}),
      ...(p.linkPreview?.image ? { linkPreview: { ...p.linkPreview, imageProxyUrl: abs(p.linkPreview.image) } } : {}),
      quote: fix(p.quote),
      repostOf: fix(p.repostOf),
    };
  return {
    ok: true,
    ...result,
    post: fix(result.post),
    context: (result.context || []).map(fix),
    selfThread: (result.selfThread || []).map(fix),
    replies: (result.replies || []).map((t) => ({ posts: t.posts.map(fix) })),
  };
}

const EXT_FORMAT = { json: 'json', md: 'md', markdown: 'md', txt: 'text', text: 'text' };

function pickFormat(req, url) {
  const f = (url.searchParams.get('format') || '').toLowerCase();
  if (f === 'markdown' || f === 'md') return 'md';
  if (f === 'txt' || f === 'text') return 'text';
  if (f === 'json' || f === 'html') return f;
  const accept = req.headers.get('accept') || '';
  if (/text\/html/.test(accept)) return 'html';
  if (/application\/json/.test(accept)) return 'json';
  if (/text\/markdown/.test(accept)) return 'md';
  return 'html';
}

function errorResponse(format, status, message, query, extra = {}) {
  if (format === 'json') return respond(JSON.stringify({ ok: false, status, error: message }), status, JSON_T, { ...CORS, ...extra });
  if (format === 'html') return respond(renderError({ status, message, query }), status, HTML, extra);
  return respond(`Error ${status}: ${message}\n`, status, TEXT, { ...CORS, ...extra });
}

async function threadResponse(req, url, info, ref, format, query) {
  const origin = originOf(req, url);
  if (rateLimited(clientIp(req, info))) {
    return errorResponse(format, 429, 'Too many requests — try again in a minute.', query, { 'retry-after': '60', 'cache-control': 'no-store' });
  }
  try {
    const result = await getThread(ref);
    // Vary: Accept because extension-less post paths negotiate the format from the Accept header.
    const cacheHdr = { 'cache-control': `public, max-age=60, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_TTL * 2}`, vary: 'Accept' };
    switch (format) {
      case 'json':
        return respond(JSON.stringify(decorate(result, origin), null, 2), 200, JSON_T, { ...CORS, ...cacheHdr });
      case 'md':
        return respond(renderMarkdown(result, { origin }), 200, 'text/markdown; charset=utf-8', { ...CORS, ...cacheHdr });
      case 'text':
        return respond(renderText(result), 200, TEXT, { ...CORS, ...cacheHdr });
      default:
        return respond(renderThread(result, { origin, query }), 200, HTML, cacheHdr);
    }
  } catch (err) {
    const known = err instanceof UpstreamError;
    if (!known) console.error(err);
    const status = known ? err.status : 500;
    const message = known ? err.message : 'Unexpected error while loading this post.';
    if (format === 'json') {
      return respond(JSON.stringify({ ok: false, status, error: message, url: refUrl(ref) }), status, JSON_T, { ...CORS, 'cache-control': 'no-store' });
    }
    return errorResponse(format, status, message, query, { 'cache-control': 'no-store' });
  }
}

function badInput(format, query) {
  const message = query
    ? 'Paste the link of a single Threads or Reddit post, e.g. https://www.threads.com/@user/post/ABC123xyz or https://www.reddit.com/r/sub/comments/abc123/title/'
    : 'Missing "url" parameter.';
  return errorResponse(format, 400, message, query);
}

async function proxyMedia(req, url) {
  let target;
  try {
    target = new URL(url.searchParams.get('u'));
  } catch {
    return respond('Bad media URL\n', 400, TEXT);
  }
  if (target.protocol !== 'https:' || !MEDIA_HOST_RE.test(target.hostname)) {
    return respond('Only Threads/Instagram and Reddit media can be proxied\n', 403, TEXT);
  }
  const headers = { 'user-agent': 'Mozilla/5.0 threads-proxy', accept: '*/*' };
  for (const h of ['range', 'if-none-match', 'if-modified-since']) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  let up;
  try {
    up = await fetch(target, { headers, redirect: 'follow', signal: req.signal });
  } catch {
    return respond('Could not fetch media\n', 502, TEXT);
  }
  // Redirects must stay on the allowed hosts too.
  if (up.url && !MEDIA_HOST_RE.test(new URL(up.url).hostname)) {
    await up.body?.cancel();
    return respond('Media redirected off the allowed hosts\n', 403, TEXT);
  }
  const type = up.headers.get('content-type') || 'application/octet-stream';
  if (up.status !== 304 && up.ok && !MEDIA_TYPES_RE.test(type)) {
    await up.body?.cancel();
    return respond('Unsupported media type\n', 415, TEXT);
  }
  // HLS playlists (Reddit video with sound): route every playlist/segment URL inside through /media too.
  if (up.ok && (HLS_TYPE_RE.test(type) || /\.m3u8$/i.test(target.pathname))) {
    const body = rewritePlaylist(await up.text(), up.url || target.href);
    return respond(req.method === 'HEAD' ? null : body, 200, type, {
      'cache-control': 'public, max-age=300, s-maxage=300',
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
    });
  }
  const out = new Headers({
    'content-type': type,
    'cache-control': up.ok ? 'public, max-age=86400, s-maxage=86400' : 'no-store',
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
  });
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(req.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}

function rewritePlaylist(text, base) {
  const prox = (u) => mediaProxy(new URL(u, base).href);
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${prox(u)}"`);
      return prox(t);
    })
    .join('\n');
}

/**
 * @param {Request} req
 * @param {{ ip?: string }} [info]
 */
export async function handle(req, info = {}) {
  const url = new URL(req.url);
  // Vercel rewrite passes the original path as ?__p=…
  let path = url.pathname;
  if (url.searchParams.has('__p')) {
    path = '/' + (url.searchParams.get('__p') || '');
    url.searchParams.delete('__p');
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': '*' } });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond('Method not allowed\n', 405, TEXT, { allow: 'GET, HEAD, OPTIONS' });

  try {
    if (path === '/' && !url.searchParams.has('url')) {
      return respond(renderHome({ origin: originOf(req, url) }), 200, HTML, { 'cache-control': 'public, s-maxage=3600' });
    }
    if (path === '/' || path === '/view') {
      const q = url.searchParams.get('url') || '';
      const format = pickFormat(req, url);
      const ref = parseRef(q);
      return ref ? threadResponse(req, url, info, ref, format, q) : badInput(format, q);
    }
    // /fetch is the public API; /api/thread is kept as an alias for older links.
    // The link can be a query param (/fetch.md?url=…) or part of the path (/fetch.md/<link or code>).
    // Path forms matter: some agent fetch tools drop query strings from URLs they build themselves.
    const api = path.match(/^\/(?:fetch|api\/thread)(?:\.(json|md|txt))?(?:\/(.*))?$/);
    if (api) {
      let q = url.searchParams.get('url') || url.searchParams.get('code') || '';
      if (!q && api[2]) {
        q = api[2];
        try {
          q = decodeURIComponent(q);
        } catch {
          /* as-is */
        }
        q = q.replace(/^(https?:)\/(?!\/)/i, '$1//'); // proxies collapse "https://" to "https:/"
      }
      const f = (url.searchParams.get('format') || '').toLowerCase();
      const format = EXT_FORMAT[api[1]] || EXT_FORMAT[f] || 'json';
      const ref = parseRef(q);
      return ref ? threadResponse(req, url, info, ref, format, q) : badInput(format, q);
    }
    if (path === '/media') return proxyMedia(req, url);
    if (path === '/llms.txt') return respond(renderLlmsTxt({ origin: originOf(req, url) }), 200, TEXT, { ...CORS, 'cache-control': 'public, s-maxage=3600' });
    // Allow everything: AI agents' fetch tools (Claude, ChatGPT, …) obey robots.txt, and reading posts is the point.
    if (path === '/robots.txt') return respond('User-agent: *\nAllow: /\n', 200, TEXT, { 'cache-control': 'public, max-age=300' });
    if (path === '/healthz') return respond('ok\n', 200, TEXT, { 'cache-control': 'no-store' });
    if (path === '/favicon.ico') return new Response(null, { status: 204 });

    // Mirrored paths with an optional .md/.json/.txt extension:
    //   Threads: /@user/post/CODE, /t/CODE
    //   Reddit:  /r/SUB/comments/ID[/slug[/COMMENT]], /comments/ID, /user/NAME/comments/ID, /r/SUB/s/SHARE
    const ext = (path.match(/\.(json|md|txt)$/) || [])[1];
    const ref = parsePath(ext ? path.slice(0, -(ext.length + 1)) : path);
    if (ref) return threadResponse(req, url, info, ref, EXT_FORMAT[ext] || pickFormat(req, url), refUrl(ref));

    // A whole URL pasted after the slash: /https://www.threads.com/@x/post/Y, /https://www.reddit.com/r/…
    let tail = path.slice(1) + url.search;
    try {
      tail = decodeURIComponent(tail);
    } catch {
      /* as-is */
    }
    const pasted = parseRef(tail.replace(/^(https?:)\/(?!\/)/i, '$1//'));
    if (pasted) return new Response(null, { status: 302, headers: { location: refPath(pasted) } });

    return respond(renderError({ status: 404, message: 'Nothing here. Paste a Threads or Reddit link above.' }), 404, HTML);
  } catch (err) {
    console.error(err);
    return respond('Internal error\n', 500, TEXT);
  }
}
