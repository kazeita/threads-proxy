// Fetching and parsing public Reddit posts and comments.
//
// Sources, in order:
//  1. OAuth API (oauth.reddit.com), when REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are set.
//     App-only tokens need no user login and aren't hit by Reddit's datacenter-IP blocks.
//  2. The public .json endpoints on www.reddit.com, then old.reddit.com.
//     Both return the post plus its comment tree; no cookies needed.
//  3. The post's HTML page: the <shreddit-post> element, any server-rendered
//     <shreddit-comment>s, and Open Graph tags as a last resort.

import * as cheerio from 'cheerio';
import { UpstreamError } from './errors.js';
import { mergeTextSegments } from './threads.js';
import { parseRedditRef, redditProxyPath, redditCanonicalUrl, isRedditHost, REDDIT_ORIGIN } from './reddit-url.js';

const env = (k) => (typeof process !== 'undefined' ? process.env[k] : undefined);
// Reddit asks API clients for a unique, descriptive User-Agent.
const USER_AGENT = () => env('REDDIT_USER_AGENT') || 'web:threads-proxy:1.0 (public post reader)';
const COMMENT_LIMIT = () => Number(env('REDDIT_COMMENT_LIMIT')) || 200;

const HTML_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);

// ---------------------------------------------------------------------------
// Fetching

let token = null; // { value, expires }

async function oauthToken({ fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const id = env('REDDIT_CLIENT_ID');
  const secret = env('REDDIT_CLIENT_SECRET');
  if (!id || !secret) return null;
  if (token && token.expires > Date.now()) return token.value;
  const res = await fetchImpl('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${id}:${secret}`),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT(),
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) throw new Error(`token request returned HTTP ${res.status}`);
  token = { value: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return token.value;
}

/** Turns a /r/SUB/s/CODE share link into a normal ref by reading its redirect. */
async function resolveShare(ref, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const url = `${REDDIT_ORIGIN}/r/${ref.subreddit}/s/${ref.share}`;
  const res = await fetchImpl(url, { headers: HTML_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const loc = res.headers.get('location');
  await res.body?.cancel();
  const resolved = loc ? parseRedditRef(new URL(loc, REDDIT_ORIGIN).href) : null;
  if (!resolved?.id) {
    if (res.status === 404) throw new UpstreamError('This share link does not exist.', 404);
    throw new UpstreamError(
      `Reddit didn't reveal where this share link points (HTTP ${res.status}). Open it in a browser and paste the full link (…/r/SUB/comments/ID/…) instead.`,
      502,
    );
  }
  return resolved;
}

function apiPath(ref) {
  const q = new URLSearchParams({ raw_json: '1', limit: String(COMMENT_LIMIT()), sr_detail: '1' });
  if (ref.commentId) {
    q.set('comment', ref.commentId);
    q.set('context', '8'); // the most parent comments Reddit returns
  }
  return { path: `/comments/${ref.id}`, query: q.toString() };
}

/** Fetches and parses one post (or one comment with its parents and replies). */
export async function fetchReddit(ref, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = 12_000 } = opts;
  if (ref.share) ref = await resolveShare(ref, opts);
  const notes = [];
  const { path, query } = apiPath(ref);
  const sources = [];

  try {
    const t = await oauthToken(opts);
    if (t) sources.push({ name: 'OAuth API', url: `https://oauth.reddit.com${path}?${query}`, headers: { authorization: `bearer ${t}` } });
  } catch (err) {
    notes.push(`OAuth token failed: ${err.message}`);
  }
  sources.push({ name: 'reddit.com JSON', url: `${REDDIT_ORIGIN}${path}.json?${query}` });
  sources.push({ name: 'old.reddit.com JSON', url: `https://old.reddit.com${path}.json?${query}` });

  // 1–2. JSON
  for (const s of sources) {
    try {
      const res = await fetchImpl(s.url, {
        headers: { 'user-agent': USER_AGENT(), accept: 'application/json', ...s.headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* blocked pages are HTML */
      }
      if (res.ok && Array.isArray(json)) {
        const parsed = parseListing(json, ref);
        if (parsed) return finish(ref, 'api', parsed, notes);
        if (ref.commentId && json[0]?.data?.children?.length) throw new UpstreamError('This comment does not exist or was deleted.', 404);
        notes.push(`${s.name} had no post data`);
        continue;
      }
      if (json && (json.reason || res.status === 404)) throw redditApiError(res.status, json);
      if (res.status === 401 && s.name === 'OAuth API') token = null;
      notes.push(`${s.name} returned HTTP ${res.status}${json ? '' : ' (blocked)'}`);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      notes.push(err.name === 'TimeoutError' ? `${s.name} timed out` : `${s.name} failed: ${err.message}`);
    }
  }

  // 3. HTML page. It only has the post (and some top comments), so a comment link shows its post.
  try {
    const postRef = { ...ref, commentId: null };
    const url = `${REDDIT_ORIGIN}${redditProxyPath(postRef)}/`;
    const res = await fetchImpl(url, { headers: HTML_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) throw new UpstreamError('This Reddit post does not exist or was deleted.', 404);
    if (res.status === 200) {
      const parsed = parseRedditHtml(await res.text(), postRef);
      if (ref.commentId) notes.push('Showing the whole post: the linked comment needs Reddit\'s API');
      if (parsed) return finish(postRef, parsed.source, parsed, notes);
      notes.push('Post page had no post data');
    } else {
      notes.push(`Post page returned HTTP ${res.status}`);
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    notes.push(err.name === 'TimeoutError' ? 'Post page timed out' : `Post page failed: ${err.message}`);
  }

  throw new UpstreamError(`Could not load this post from Reddit (${notes.join('; ')}).`, 502);
}

function redditApiError(status, json) {
  const reason = json?.reason;
  if (reason === 'private') return new UpstreamError('This post is in a private subreddit.', 403);
  if (reason === 'quarantined') return new UpstreamError('This post is in a quarantined subreddit, which requires login.', 403);
  if (reason === 'banned') return new UpstreamError('This subreddit has been banned.', 404);
  if (reason === 'gold_only') return new UpstreamError('This subreddit is restricted to premium members.', 403);
  if (status === 404) return new UpstreamError('This Reddit post does not exist or was deleted.', 404);
  return new UpstreamError(`Reddit refused this request (${reason || `HTTP ${status}`}).`, status >= 400 && status < 500 ? status : 502);
}

function finish(ref, source, parsed, notes = []) {
  const { post, submission } = parsed;
  const sub = submission?.subreddit || ref.subreddit || null;
  const pathRef = { id: ref.id, subreddit: sub, commentId: ref.commentId };
  const replies = parsed.replies || [];
  const flat = replies.reduce((n, t) => n + t.posts.length, 0);
  return {
    platform: 'reddit',
    code: ref.commentId || ref.id,
    postId: ref.id,
    commentId: ref.commentId || null,
    url: post.url || redditCanonicalUrl(pathRef),
    proxyPath: redditProxyPath(pathRef),
    createdAt: post.createdAt,
    fetchedAt: new Date().toISOString(),
    source,
    post,
    context: parsed.context || [],
    selfThread: [],
    replies,
    // A post's count is every comment in it; a comment's count is its direct replies.
    replyCount: post.kind === 'comment' ? post.stats?.replies ?? null : post.stats?.comments ?? null,
    directRepliesShown: replies.length,
    nestedRepliesShown: flat - replies.length,
    hasMoreReplies: !!parsed.hasMoreReplies,
    ...(source !== 'api' && notes.length ? { note: notes.join('; ') } : {}),
  };
}

// ---------------------------------------------------------------------------
// JSON listing

/** `json` is the two-listing array Reddit returns for /comments/ID: [post, comments]. */
export function parseListing(json, ref) {
  const t3 = json?.[0]?.data?.children?.find((c) => c?.kind === 't3')?.data;
  if (!t3) return null;
  const submission = normalizeSubmission(t3);
  const top = json?.[1]?.data?.children || [];
  const ctx = { sub: t3.subreddit, postId: t3.id, op: t3.author };

  if (!ref?.commentId) {
    const { threads, more } = flattenComments(top, ctx, 0, submission.author.username);
    return { submission, post: submission, context: [], replies: threads, hasMoreReplies: more };
  }

  // Comment permalink: walk down to the target, collecting its parents.
  const chain = [];
  let level = top;
  let target = null;
  while (level?.length) {
    const next = level.find((c) => c?.kind === 't1');
    if (!next) break;
    const hit = level.find((c) => c?.kind === 't1' && c.data?.id === ref.commentId);
    if (hit) {
      target = hit.data;
      break;
    }
    chain.push(next.data);
    level = next.data.replies?.data?.children;
  }
  if (!target) return null;

  const context = [submission];
  let parentAuthor = submission.author.username;
  for (const c of chain) {
    const p = normalizeComment(c, ctx, 0);
    p.replyingTo = parentAuthor;
    // Only the branch leading to the target is loaded, so the reply count is unknown.
    p.stats.replies = null;
    p.statsDisplay.replies = null;
    parentAuthor = c.author;
    context.push(p);
  }
  const post = normalizeComment(target, ctx, 0);
  post.replyingTo = parentAuthor;
  const kids = target.replies?.data?.children || [];
  const { threads, more, hidden } = flattenComments(kids, ctx, 0, target.author);
  post.stats.replies = threads.length + hidden;
  post.statsDisplay.replies = compact.format(post.stats.replies);
  return { submission, post, context, replies: threads, hasMoreReplies: more };
}

/** Each top-level comment becomes { posts: [comment, ...its descendants in reading order] } with a `depth` on each. */
function flattenComments(children, ctx, depth, parentAuthor) {
  const threads = [];
  let more = false;
  let hidden = 0;
  for (const c of children) {
    if (c?.kind === 'more') {
      hidden += c.data?.count || 0;
      more ||= (c.data?.count || 0) > 0 || c.data?.id === '_';
      continue;
    }
    if (c?.kind !== 't1') continue;
    const posts = [];
    if (walkComment(c.data, ctx, depth, parentAuthor, posts)) more = true;
    threads.push({ posts });
  }
  return { threads, more, hidden };
}

/** Pushes the comment and its loaded replies into `out`. Returns true if some replies weren't loaded. */
function walkComment(c, ctx, depth, parentAuthor, out) {
  const p = normalizeComment(c, ctx, depth);
  p.replyingTo = depth > 0 ? parentAuthor : null;
  out.push(p);
  let missing = false;
  let shown = 0;
  let hidden = 0;
  for (const k of c.replies?.data?.children || []) {
    if (k?.kind === 't1') {
      shown++;
      if (walkComment(k.data, ctx, depth + 1, c.author, out)) missing = true;
    } else if (k?.kind === 'more') {
      hidden += k.data?.count || 0;
      // "Continue this thread": Reddit stops nesting and links to the comment instead.
      if (!k.data?.count && k.data?.id === '_') p.continueThread = true;
    }
  }
  if (hidden) p.moreReplies = hidden;
  p.stats.replies = shown + hidden;
  p.statsDisplay.replies = compact.format(p.stats.replies);
  return missing || hidden > 0 || !!p.continueThread;
}

function author(name, flair) {
  const gone = !name || name === '[deleted]';
  return {
    username: gone ? '[deleted]' : name,
    fullName: null,
    profileUrl: gone ? null : `${REDDIT_ORIGIN}/user/${name}`,
    avatar: null,
    verified: false,
    ...(flair ? { flair } : {}),
  };
}

export function normalizeSubmission(d, depth = 0) {
  const prefixed = d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : null);
  const icon = d.sr_detail?.community_icon || d.sr_detail?.icon_img || null;
  const segments = htmlToSegments(d.selftext_html, d.selftext);
  const crosspost = d.crosspost_parent_list?.[0];
  const stats = {
    score: d.score ?? 0,
    upvoteRatio: d.upvote_ratio ?? null,
    comments: d.num_comments ?? 0,
    crossposts: d.num_crossposts ?? 0,
  };
  return {
    platform: 'reddit',
    kind: 'post',
    url: d.permalink ? REDDIT_ORIGIN + d.permalink : null,
    code: d.id || null,
    proxyPath: d.id ? redditProxyPath({ id: d.id, subreddit: d.subreddit }) : null,
    subreddit: d.subreddit || null,
    community: prefixed ? { name: prefixed, url: `${REDDIT_ORIGIN}/${prefixed}`, icon } : null,
    author: author(d.author, d.author_flair_text),
    replyingTo: null,
    title: d.title || null,
    flair: d.link_flair_text || null,
    text: d.selftext || '',
    segments,
    media: submissionMedia(d),
    linkPreview: linkPreview(d),
    poll: poll(d.poll_data),
    quote: null,
    repostOf: crosspost && depth < 1 ? normalizeSubmission(crosspost, depth + 1) : null,
    displayTime: null,
    createdAt: iso(d.created_utc),
    editedAt: typeof d.edited === 'number' ? iso(d.edited) : null,
    flags: {
      nsfw: !!d.over_18,
      spoiler: !!d.spoiler,
      locked: !!d.locked,
      pinned: !!(d.stickied || d.pinned),
      archived: !!d.archived,
      removed: d.removed_by_category || (d.selftext === '[removed]' ? 'removed' : null),
    },
    stats,
    statsDisplay: {
      score: compact.format(stats.score),
      upvoteRatio: stats.upvoteRatio != null ? `${Math.round(stats.upvoteRatio * 100)}%` : null,
      comments: compact.format(stats.comments),
      crossposts: compact.format(stats.crossposts),
    },
  };
}

function normalizeComment(c, ctx, depth) {
  const stats = { score: c.score_hidden ? null : c.score ?? 0, replies: 0 };
  return {
    platform: 'reddit',
    kind: 'comment',
    url: c.permalink ? REDDIT_ORIGIN + c.permalink : null,
    code: c.id || null,
    proxyPath: c.id ? redditProxyPath({ id: ctx.postId, subreddit: ctx.sub, commentId: c.id }) : null,
    author: author(c.author, c.author_flair_text),
    isOp: !!c.is_submitter || (!!ctx.op && c.author === ctx.op && c.author !== '[deleted]'),
    distinguished: c.distinguished || null,
    pinned: !!c.stickied,
    replyingTo: null,
    title: null,
    text: c.body || '',
    segments: htmlToSegments(c.body_html, c.body),
    media: metadataMedia(c.media_metadata),
    linkPreview: null,
    quote: null,
    repostOf: null,
    displayTime: null,
    createdAt: iso(c.created_utc),
    editedAt: typeof c.edited === 'number' ? iso(c.edited) : null,
    depth,
    stats,
    statsDisplay: { score: stats.score == null ? null : compact.format(stats.score), replies: '0' },
  };
}

// ---------------------------------------------------------------------------
// Media

const REDDIT_MEDIA_RE = /(^|\.)(redd\.it|redditmedia\.com|redditstatic\.com)$/i;
const isRedditMedia = (u) => {
  try {
    const h = new URL(u).hostname;
    return REDDIT_MEDIA_RE.test(h) && h !== 'redd.it';
  } catch {
    return false;
  }
};

function previewSource(d) {
  const img = d.preview?.images?.[0];
  return img?.source?.url ? img : null;
}

function redditVideo(v, poster) {
  if (!v?.fallback_url) return null;
  return {
    type: 'video',
    url: v.fallback_url, // MP4 without sound; the HLS stream carries audio
    hlsUrl: v.hls_url || null,
    dashUrl: v.dash_url || null,
    hasAudio: v.has_audio ?? null,
    gif: !!v.is_gif,
    duration: v.duration ?? null,
    poster: poster || null,
    width: v.width || null,
    height: v.height || null,
  };
}

function metadataItem(meta, caption) {
  if (!meta || meta.status !== 'valid' || !meta.s) return null;
  if (meta.e === 'AnimatedImage') {
    if (meta.s.mp4) return { type: 'video', url: meta.s.mp4, gif: true, poster: null, width: meta.s.x || null, height: meta.s.y || null, ...(caption ? { alt: caption } : {}) };
    if (meta.s.gif) return { type: 'image', url: meta.s.gif, width: meta.s.x || null, height: meta.s.y || null, alt: caption || '' };
    return null;
  }
  if (meta.e === 'Image' && meta.s.u) return { type: 'image', url: meta.s.u, width: meta.s.x || null, height: meta.s.y || null, alt: caption || '' };
  if (meta.e === 'RedditVideo' && meta.hlsUrl) return { type: 'video', url: meta.hlsUrl, hlsUrl: meta.hlsUrl, poster: null, width: meta.x || null, height: meta.y || null };
  return null;
}

/** Images/GIFs embedded in a comment or self post (media_metadata), in insertion order. */
function metadataMedia(mm) {
  if (!mm || typeof mm !== 'object') return [];
  return Object.values(mm).map((m) => metadataItem(m)).filter(Boolean);
}

export function submissionMedia(d) {
  if (d.crosspost_parent_list?.length) return []; // shown on the crossposted post
  const img = previewSource(d);
  const poster = img?.source.url || null;

  if (d.is_gallery && d.gallery_data?.items?.length) {
    return d.gallery_data.items.map((it) => metadataItem(d.media_metadata?.[it.media_id], it.caption)).filter(Boolean);
  }
  const rv = redditVideo(d.secure_media?.reddit_video || d.media?.reddit_video, poster);
  if (rv) return [rv];
  // GIFs and gifv links hosted elsewhere come with a Reddit-transcoded MP4.
  const pv = redditVideo(d.preview?.reddit_video_preview, poster);
  if (pv) return [pv];
  const mp4 = img?.variants?.mp4?.source;
  if (mp4?.url) return [{ type: 'video', url: mp4.url, gif: true, poster, width: mp4.width || null, height: mp4.height || null }];

  if (d.post_hint === 'image' || /\.(jpe?g|png|gif|webp)$/i.test(d.url || '')) {
    const url = isRedditMedia(d.url) ? d.url : img?.source.url;
    if (url) return [{ type: 'image', url, width: img?.source.width || null, height: img?.source.height || null, alt: '' }];
  }
  if (d.is_self) return metadataMedia(d.media_metadata);
  return [];
}

function linkPreview(d) {
  if (d.is_self || d.is_gallery || d.crosspost_parent_list?.length) return null;
  const url = d.url_overridden_by_dest || d.url;
  if (!url || /^\/r\//.test(url) || d.is_video) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (isRedditMedia(url) || (d.post_hint === 'image' && previewSource(d))) return null;
  const embed = d.secure_media?.oembed || d.media?.oembed;
  const img = previewSource(d)?.source.url || (embed?.thumbnail_url && isRedditMedia(embed.thumbnail_url) ? embed.thumbnail_url : null);
  return { url, displayUrl: d.domain || host.replace(/^www\./, ''), title: embed?.title || null, image: img || null };
}

function poll(p) {
  if (!p?.options?.length) return null;
  return {
    totalVotes: p.total_vote_count ?? null,
    endsAt: p.voting_end_timestamp ? new Date(p.voting_end_timestamp).toISOString() : null,
    options: p.options.map((o) => ({ text: o.text, votes: o.vote_count ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Rendered Markdown (body_html / selftext_html) -> segments

const BLOCK2 = new Set(['p', 'div', 'blockquote', 'ul', 'ol', 'pre', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK1 = new Set(['li', 'tr']);

/** Reddit's rendered HTML as text/link segments, keeping paragraphs, lists and quotes readable as plain text. */
export function htmlToSegments(html, fallback) {
  if (!html) return fallback ? [{ type: 'text', text: fallback }] : [];
  const $ = cheerio.load(html, null, false);
  const ctx = { out: [], brk: 0, quote: 0, pre: false, lineStart: true };
  walkHtml($, $.root()[0], ctx);
  mergeTextSegments(ctx.out);
  const last = ctx.out.at(-1);
  if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '');
  return ctx.out.filter((s) => s.type !== 'text' || s.text);
}

function emit(ctx, seg, bullet = false) {
  if (ctx.out.length && ctx.brk) {
    ctx.out.push({ type: 'text', text: '\n'.repeat(ctx.brk) });
    ctx.lineStart = true;
  }
  ctx.brk = 0;
  if (ctx.lineStart && ctx.quote) ctx.out.push({ type: 'text', text: '> '.repeat(ctx.quote) });
  ctx.lineStart = false;
  ctx.bullet = bullet;
  ctx.out.push(seg);
}

function walkHtml($, node, ctx, list) {
  for (const c of node.children || []) {
    if (c.type === 'text') {
      let t = c.data;
      if (!ctx.pre) {
        t = t.replace(/\s*\n\s*/g, ' ');
        if (!t.trim() && (ctx.lineStart || ctx.brk || !ctx.out.length)) continue;
        if (ctx.lineStart || ctx.brk) t = t.replace(/^\s+/, '');
      }
      if (t) emit(ctx, { type: 'text', text: t });
      continue;
    }
    if (c.type !== 'tag') continue;
    const name = c.name;
    if (name === 'br') {
      ctx.out.push({ type: 'text', text: '\n' });
      ctx.lineStart = true;
      continue;
    }
    if (name === 'a') {
      const href = absolutize($(c).attr('href') || '');
      const text = $(c).text() || href;
      if (href) emit(ctx, classifyRedditLink(text, href));
      else if (text) emit(ctx, { type: 'text', text });
      continue;
    }
    if (name === 'img' || name === 'script' || name === 'style') continue;
    if (name === 'hr') {
      ctx.brk = Math.max(ctx.brk, 2);
      emit(ctx, { type: 'text', text: '———' });
      ctx.brk = 2;
      continue;
    }
    let block = BLOCK2.has(name) ? 2 : BLOCK1.has(name) ? 1 : 0;
    if (block && list && name !== 'blockquote' && name !== 'pre') block = 1; // keep lists tight
    // A paragraph right after a list bullet stays on the bullet's line.
    if (block && !ctx.bullet) ctx.brk = Math.max(ctx.brk, block);
    if (name === 'blockquote') ctx.quote++;
    if (name === 'li') {
      const n = list ? ++list.n : 1;
      emit(ctx, { type: 'text', text: '  '.repeat(Math.max(0, (list?.depth || 1) - 1)) + (list?.ordered ? `${n}. ` : '• ') }, true);
    }
    if ((name === 'td' || name === 'th') && $(c).prevAll('td,th').length) emit(ctx, { type: 'text', text: ' | ' });
    const wasPre = ctx.pre;
    if (name === 'pre') ctx.pre = true;
    const sub = name === 'ul' || name === 'ol' ? { ordered: name === 'ol', n: 0, depth: (list?.depth || 0) + 1 } : list;
    walkHtml($, c, ctx, sub);
    ctx.pre = wasPre;
    if (name === 'blockquote') ctx.quote--;
    if (block) ctx.brk = Math.max(ctx.brk, block);
  }
}

/** Plain text with links written as Markdown, matching the API's `selftext` / `body`. */
function segmentsToMarkdown(segments) {
  return segments
    .map((s) => (s.type === 'link' && s.text !== s.href && s.kind === 'url' ? `[${s.text}](${s.href})` : s.text))
    .join('')
    .trim();
}

function absolutize(href) {
  if (!href) return '';
  if (/^\/(r|u|user)\//i.test(href) || href.startsWith('/')) return REDDIT_ORIGIN + href;
  return href;
}

export function classifyRedditLink(text, href) {
  let kind = 'url';
  let extra = {};
  try {
    const u = new URL(href);
    if (isRedditHost(u.hostname)) {
      const ref = parseRedditRef(href);
      if (ref) {
        kind = 'post';
        extra = { proxyPath: redditProxyPath(ref) };
      } else if (/^\/(u|user)\/[^/]+\/?$/i.test(u.pathname)) kind = 'mention';
      else if (/^\/r\/[^/]+\/?$/i.test(u.pathname)) kind = 'community';
    }
  } catch {
    /* keep url */
  }
  return { type: 'link', kind, text, href, ...extra };
}

// ---------------------------------------------------------------------------
// HTML page fallback (new Reddit's <shreddit-post> / <shreddit-comment> elements, then Open Graph)

export function parseRedditHtml(html, ref) {
  const $ = cheerio.load(html);
  const el = $('shreddit-post').first();
  if (el.length) {
    const a = (k) => el.attr(k) ?? null;
    const sub = (a('subreddit-prefixed-name') || '').replace(/^r\//, '') || ref.subreddit;
    const bodyHtml = el.find('[slot="text-body"]').first().html();
    const segments = htmlToSegments(bodyHtml);
    const media = [];
    const seen = new Set();
    el.find('[slot="post-media-container"] img, gallery-carousel img, shreddit-player, shreddit-player-2').each((_, m) => {
      const $m = $(m);
      const src = $m.attr('src') || $m.attr('data-lazy-src');
      if (!src || seen.has(src) || !/^https:/.test(src)) return;
      seen.add(src);
      if (/^shreddit-player/.test(m.name)) media.push({ type: 'video', url: src, hlsUrl: /\.m3u8/.test(src) ? src : null, poster: $m.attr('poster') || null });
      else media.push({ type: 'image', url: src, alt: $m.attr('alt') || '' });
    });
    const score = Number(a('score')) || 0;
    const comments = Number(a('comment-count')) || 0;
    const permalink = a('permalink');
    const post = {
      platform: 'reddit',
      kind: 'post',
      url: permalink ? REDDIT_ORIGIN + permalink : null,
      code: (a('id') || '').replace(/^t3_/, '') || ref.id,
      proxyPath: redditProxyPath({ id: ref.id, subreddit: sub }),
      subreddit: sub,
      community: sub ? { name: `r/${sub}`, url: `${REDDIT_ORIGIN}/r/${sub}`, icon: null } : null,
      author: author(a('author')),
      replyingTo: null,
      title: a('post-title'),
      flair: null,
      text: segmentsToMarkdown(segments),
      segments,
      media,
      linkPreview: a('post-type') === 'link' && a('content-href') ? { url: a('content-href'), displayUrl: a('domain'), title: null, image: null } : null,
      poll: null,
      quote: null,
      repostOf: null,
      displayTime: null,
      createdAt: a('created-timestamp') ? new Date(a('created-timestamp')).toISOString() : null,
      editedAt: null,
      flags: { nsfw: el.is('[nsfw]'), spoiler: el.is('[spoiler]'), locked: false, pinned: false, archived: false, removed: null },
      stats: { score, upvoteRatio: null, comments, crossposts: 0 },
      statsDisplay: { score: compact.format(score), upvoteRatio: null, comments: compact.format(comments), crossposts: null },
    };
    const ctx = { sub, postId: ref.id, op: post.author.username };
    const replies = htmlComments($, ctx);
    return {
      source: 'html',
      submission: post,
      post,
      context: [],
      replies,
      hasMoreReplies: replies.reduce((n, t) => n + t.posts.length, 0) < comments,
    };
  }

  // Open Graph
  const meta = (p) => $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content') || '';
  const title = meta('og:title');
  if (!title) return null;
  const description = meta('og:description');
  const image = meta('og:image');
  const sub = ref.subreddit || (meta('og:url').match(/\/r\/([^/]+)/) || [])[1] || null;
  return {
    source: 'opengraph',
    submission: { subreddit: sub },
    post: {
      platform: 'reddit',
      kind: 'post',
      url: meta('og:url') || null,
      code: ref.id,
      proxyPath: redditProxyPath({ id: ref.id, subreddit: sub }),
      subreddit: sub,
      community: sub ? { name: `r/${sub}`, url: `${REDDIT_ORIGIN}/r/${sub}`, icon: null } : null,
      author: author(null),
      replyingTo: null,
      title: title.replace(/\s*:\s*r\/\w+$/, ''),
      flair: null,
      text: description,
      segments: description ? [{ type: 'text', text: description }] : [],
      media: image && isRedditMedia(image) ? [{ type: 'image', url: image, alt: '' }] : [],
      linkPreview: null,
      poll: null,
      quote: null,
      repostOf: null,
      displayTime: null,
      createdAt: null,
      editedAt: null,
      flags: null,
      stats: null,
      statsDisplay: null,
    },
    context: [],
    replies: [],
    hasMoreReplies: false,
  };
}

function htmlComments($, ctx) {
  const threads = [];
  $('shreddit-comment').each((_, c) => {
    const $c = $(c);
    const depth = Number($c.attr('depth')) || 0;
    const id = ($c.attr('thingid') || '').replace(/^t1_/, '');
    const name = $c.attr('author');
    const segments = htmlToSegments($c.children('[slot="comment"]').first().html());
    const score = $c.attr('score') != null ? Number($c.attr('score')) : null;
    const p = {
      platform: 'reddit',
      kind: 'comment',
      url: $c.attr('permalink') ? REDDIT_ORIGIN + $c.attr('permalink') : null,
      code: id || null,
      proxyPath: id ? redditProxyPath({ id: ctx.postId, subreddit: ctx.sub, commentId: id }) : null,
      author: author(name),
      isOp: !!name && name === ctx.op,
      distinguished: null,
      pinned: false,
      replyingTo: null,
      title: null,
      text: segmentsToMarkdown(segments),
      segments,
      media: [],
      linkPreview: null,
      quote: null,
      repostOf: null,
      displayTime: null,
      createdAt: $c.find('faceplate-timeago').first().attr('ts') ? new Date($c.find('faceplate-timeago').first().attr('ts')).toISOString() : null,
      editedAt: null,
      depth,
      stats: { score, replies: 0 },
      statsDisplay: { score: score == null ? null : compact.format(score), replies: '0' },
    };
    if (depth === 0 || !threads.length) threads.push({ posts: [p] });
    else threads.at(-1).posts.push(p);
  });
  return threads;
}
