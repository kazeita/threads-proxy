// Fetching and parsing public Threads posts.
//
// Sources, in order:
//  1. The post page (https://www.threads.com/@user/post/CODE). When requested with a
//     browser-style Accept header it embeds Relay JSON with the full post, the parent
//     chain, the author's follow-up posts and the first page of replies (what a
//     logged-out visitor sees before "Log in to see more replies"). No cookies needed.
//  2. The official embed page (/t/CODE/embed): server-rendered post + parents, no replies.
//  3. Open Graph tags on the post page: text and one image.

import * as cheerio from 'cheerio';
import { canonicalUrl, createdAtFromCode, embedUrl, isThreadsHost, unwrapLink, parseThreadsRef } from './url.js';

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  // This exact kind of Accept header is what makes Threads inline the post + replies JSON.
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

export class ThreadsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function fetchHtml(url, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const res = await fetchImpl(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text(), finalUrl: res.url || url };
}

/** Fetches and parses one post. `ref` is { code, username } from parseThreadsRef. */
export async function fetchThread(ref, opts = {}) {
  const base = {
    code: ref.code,
    url: canonicalUrl(ref),
    createdAt: createdAtFromCode(ref.code),
    fetchedAt: new Date().toISOString(),
  };
  const notes = [];

  // 1. Post page JSON
  let pageHtml = null;
  try {
    const { status, text, finalUrl } = await fetchHtml(base.url, opts);
    if (status === 200) {
      pageHtml = text;
      const parsed = parsePostPage(text, ref.code);
      if (parsed) return finish(base, 'page', parsed);
      notes.push(/\/login|accounts\/login/.test(finalUrl) ? 'Post page redirected to login' : 'Post page had no post data');
    } else {
      notes.push(`Post page returned HTTP ${status}`);
    }
  } catch (err) {
    notes.push(err.name === 'TimeoutError' ? 'Post page timed out' : `Post page failed: ${err.message}`);
  }

  // 2. Embed
  let notAvailable = false;
  try {
    const { status, text } = await fetchHtml(embedUrl(ref), opts);
    if (status === 200) {
      const parsed = parseEmbed(text);
      if (parsed.post) {
        return finish(base, 'embed', { ...parsed, selfThread: [], replies: [], hasMoreReplies: parsed.post.stats.replies > 0 }, notes);
      }
      if (parsed.error) notAvailable = /not available/i.test(parsed.error);
      notes.push(parsed.error || 'Embed had no post content');
    } else {
      notes.push(`Embed returned HTTP ${status}`);
    }
  } catch (err) {
    notes.push(err.name === 'TimeoutError' ? 'Embed timed out' : `Embed failed: ${err.message}`);
  }

  // 3. Open Graph
  if (pageHtml) {
    const og = parseOpenGraph(pageHtml);
    if (og?.post.text) return finish(base, 'opengraph', { post: og.post, context: [], selfThread: [], replies: [], hasMoreReplies: false }, notes);
  }

  if (notAvailable) {
    throw new ThreadsError('This thread is not available. It may be private, deleted, or from a restricted account.', 404);
  }
  throw new ThreadsError(`Could not load this thread from Threads (${notes.join('; ')}).`, 502);
}

function finish(base, source, parsed, notes = []) {
  const post = parsed.post;
  post.code = base.code;
  post.createdAt = post.createdAt || base.createdAt;
  if (post.author?.username) post.url = canonicalUrl({ code: base.code, username: post.author.username });
  else post.url = post.url || base.url;
  return {
    ...base,
    url: post.url,
    createdAt: post.createdAt,
    source,
    post,
    context: parsed.context || [],
    selfThread: parsed.selfThread || [],
    replies: parsed.replies || [],
    replyCount: post.stats?.replies ?? null, // direct replies, as counted by Threads
    directRepliesShown: (parsed.replies || []).length,
    nestedRepliesShown: (parsed.replies || []).reduce((n, t) => n + t.posts.length - 1, 0),
    hasMoreReplies: !!parsed.hasMoreReplies,
    ...(source !== 'page' && notes.length ? { note: notes.join('; ') } : {}),
  };
}

// ---------------------------------------------------------------------------
// Post page (Relay JSON)

/** Finds every `result.data` object inside the page's JSON script tags. */
function collectRelayData(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[type="application/json"]').each((_, s) => {
    const txt = $(s).text();
    if (!txt.includes('"result"')) return;
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      return;
    }
    const stack = [[json, 0]];
    while (stack.length) {
      const [o, depth] = stack.pop();
      if (!o || typeof o !== 'object' || depth > 40) continue;
      if (o.result && typeof o.result === 'object' && o.result.data && typeof o.result.data === 'object') {
        out.push(o.result.data);
        continue;
      }
      for (const k in o) stack.push([o[k], depth + 1]);
    }
  });
  return out;
}

export function parsePostPage(html, code) {
  const datas = collectRelayData(html);
  let main = null;
  let parents = [];
  let replies = [];
  let selfThread = [];
  let hasMoreReplies = false;

  for (const d of datas) {
    const m = d.media;
    if (!m || typeof m !== 'object') continue;
    if (!main && m.code === code && m.user?.username) main = m;
    const t = m.text_post_app_info || {};
    const ct = t.containing_thread?.posts?.edges;
    if (ct?.length) {
      const nodes = ct.map((e) => e?.node).filter((n) => n?.user);
      const idx = nodes.findIndex((n) => n.code === code);
      parents = (idx >= 0 ? nodes.slice(0, idx) : nodes.filter((n) => n.code !== code));
    }
    const dr = t.direct_replies;
    if (dr?.edges) {
      replies = dr.edges
        .map((e) => (e?.node?.posts?.edges || []).map((x) => x?.node).filter((n) => n?.user))
        .filter((thread) => thread.length);
      hasMoreReplies = !!dr.page_info?.has_next_page;
    }
    const st = t.self_thread?.posts?.edges;
    if (st?.length) selfThread = st.map((e) => e?.node).filter((n) => n?.user && n.code !== code);
  }
  if (!main) return null;

  return {
    post: normalizeNode(main),
    context: parents.map((n) => normalizeNode(n)),
    selfThread: selfThread.map((n) => normalizeNode(n)),
    replies: replies.map((thread) => ({ posts: thread.map((n) => normalizeNode(n)) })),
    hasMoreReplies,
  };
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function normalizeNode(n, depth = 0) {
  const t = n.text_post_app_info || {};
  const u = n.user || {};
  const frags = t.text_fragments?.fragments;
  let segments = frags?.length ? frags.map(fragmentToSegment).filter(Boolean) : [];
  if (!segments.length && n.caption?.text) segments = [{ type: 'text', text: n.caption.text }];
  mergeTextSegments(segments);

  const stats = {
    likes: n.like_count ?? 0,
    replies: t.direct_reply_count ?? 0,
    reposts: t.repost_count ?? 0,
    quotes: t.quote_count ?? 0,
    shares: t.reshare_count ?? 0,
  };
  const statsDisplay = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, compact.format(v)]));

  const share = t.share_info || {};
  const quoted = share.quoted_post || share.quoted_attachment_post;
  const reposted = share.reposted_post;
  const lp = t.link_preview_attachment;

  return {
    url: u.username && n.code ? canonicalUrl({ code: n.code, username: u.username }) : null,
    code: n.code || null,
    author: {
      username: u.username || null,
      fullName: u.full_name || null,
      profileUrl: u.username ? `https://www.threads.com/@${u.username}` : null,
      avatar: u.profile_pic_url || null,
      verified: !!u.is_verified,
    },
    replyingTo: t.reply_to_author?.username || null,
    text: segmentsToText(segments),
    segments,
    media: extractMedia(n),
    linkPreview: lp?.url
      ? { url: unwrapLink(lp.url), displayUrl: lp.display_url || null, title: lp.title || null, image: lp.image_url || null }
      : null,
    quote: quoted?.user && depth < 2 ? normalizeNode(quoted, depth + 1) : null,
    repostOf: reposted?.user && depth < 2 ? normalizeNode(reposted, depth + 1) : null,
    displayTime: null,
    createdAt: n.taken_at ? new Date(n.taken_at * 1000).toISOString() : n.code ? createdAtFromCode(n.code) : null,
    stats,
    statsDisplay,
  };
}

function fragmentToSegment(f) {
  if (!f) return null;
  const text = f.plaintext ?? '';
  switch (f.fragment_type) {
    case 'link': {
      const href = unwrapLink(f.link_fragment?.uri || text);
      return classifyLink(f.link_fragment?.display_text || text, /^https?:/i.test(href) ? href : `https://${href}`);
    }
    case 'mention': {
      const name = f.mention_fragment?.mentioned_user?.username || text.replace(/^@/, '');
      return { type: 'link', kind: 'mention', text: text || `@${name}`, href: `https://www.threads.com/@${name}` };
    }
    case 'inline_sticker':
      return null;
    default: {
      if (f.tag_fragment || f.fragment_type === 'tag') {
        const tag = text.replace(/^#/, '');
        return { type: 'link', kind: 'tag', text, href: `https://www.threads.com/search?q=${encodeURIComponent(tag)}&serp_type=tags` };
      }
      return text ? { type: 'text', text } : null;
    }
  }
}

function bestImage(item) {
  const c = item?.image_versions2?.candidates;
  if (!c?.length) return null;
  return c.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
}

function extractMedia(n) {
  const items = n.carousel_media?.length ? n.carousel_media : [n];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const img = bestImage(it);
    if (it.video_versions?.length) {
      out.push({
        type: 'video',
        url: it.video_versions[0].url,
        poster: img?.url || null,
        width: it.original_width || img?.width || null,
        height: it.original_height || img?.height || null,
      });
    } else if (img && it.media_type !== 19) {
      out.push({
        type: 'image',
        url: img.url,
        width: img.width || null,
        height: img.height || null,
        alt: it.accessibility_caption || '',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Embed parsing (fallback)

export function parseEmbed(html) {
  const $ = cheerio.load(html);
  const errorText = $('.EmbedError .ErrorText').text().trim() || ($('.EmbedError').length ? 'Thread not available' : '');

  const posts = $('.OuterContainer')
    .toArray()
    .map((el) => parseEmbedPost($, $(el)));

  if (!posts.length) return { post: null, context: [], error: errorText || null };

  let idx = posts.findIndex((p) => p._full);
  if (idx < 0) idx = posts.length - 1;
  const permalink = unwrapLink($('.LinkContainer a').attr('href') || '') || null;
  const post = posts[idx];
  if (permalink) post.url = permalink;
  const context = posts.slice(0, idx);
  for (const p of posts) delete p._full;
  return { post, context, error: null };
}

function parseEmbedPost($, el) {
  const username = el.find('.HeaderLink').first().text().trim() || el.find('.AvatarContainer img').attr('alt') || null;
  const avatar = el.find('.AvatarContainer img').attr('src') || null;

  const segments = [];
  el.find('.BodyTextContainer').each((i, b) => {
    if (i > 0) segments.push({ type: 'text', text: '\n\n' });
    collectSegments($, b, segments);
  });
  mergeTextSegments(segments);

  const repliedTo = el.find('.RepliedToText').text().trim();
  const replyingTo = (repliedTo.match(/@([A-Za-z0-9._]+)/) || [])[1] || null;

  const media = [];
  const seen = new Set();
  el.find('img, video').each((_, m) => {
    const $m = $(m);
    if ($m.closest('.AvatarContainer').length) return;
    if (m.name === 'video') {
      const src = $m.attr('src') || $m.find('source').attr('src');
      if (src && !seen.has(src)) {
        seen.add(src);
        media.push({ type: 'video', url: src, poster: $m.attr('poster') || null });
      }
    } else {
      const src = $m.attr('src');
      if (src && !seen.has(src) && !src.startsWith('data:')) {
        seen.add(src);
        media.push({ type: 'image', url: src, alt: $m.attr('alt') || '' });
      }
    }
  });

  const counts = el
    .find('.ActionBarContainer .ActionBarIcon')
    .toArray()
    .map((icon) => $(icon).find('.ActionBarCount').text().trim());
  const [likes, replies, reposts, shares] = counts;

  return {
    _full: el.hasClass('OuterContainerFull'),
    url: null,
    code: null,
    author: {
      username,
      fullName: null,
      profileUrl: username ? `https://www.threads.com/@${username}` : null,
      avatar,
      verified: el.find('.VerifiedBadge').length > 0,
    },
    replyingTo,
    text: segmentsToText(segments),
    segments,
    media,
    linkPreview: null,
    quote: null,
    repostOf: null,
    displayTime: el.find('.Timestamp').first().text().trim() || null,
    createdAt: null,
    stats: {
      likes: parseCount(likes),
      replies: parseCount(replies),
      reposts: parseCount(reposts),
      quotes: null,
      shares: parseCount(shares),
    },
    statsDisplay: { likes: likes || '0', replies: replies || '0', reposts: reposts || '0', quotes: null, shares: shares || '0' },
  };
}

function collectSegments($, node, out) {
  $(node)
    .contents()
    .each((_, c) => {
      if (c.type === 'text') {
        out.push({ type: 'text', text: c.data });
      } else if (c.type === 'tag') {
        if (c.name === 'a') {
          out.push(classifyLink($(c).text(), unwrapLink($(c).attr('href') || '')));
        } else if (c.name === 'br') {
          out.push({ type: 'text', text: '\n' });
        } else if (c.name !== 'script' && c.name !== 'style') {
          collectSegments($, c, out);
        }
      }
    });
}

function classifyLink(text, href) {
  let kind = 'url';
  let threadsRef = null;
  try {
    const u = new URL(href);
    if (isThreadsHost(u.hostname)) {
      threadsRef = parseThreadsRef(href);
      if (threadsRef) kind = 'post';
      else if (/^\/@[^/]+\/?$/.test(u.pathname)) kind = 'mention';
      else if (u.pathname.startsWith('/search') || u.pathname.startsWith('/tag')) kind = 'tag';
    }
  } catch {
    /* keep url */
  }
  return { type: 'link', kind, text, href, ...(threadsRef ? { code: threadsRef.code } : {}) };
}

function mergeTextSegments(segments) {
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i].type === 'text' && segments[i - 1].type === 'text') {
      segments[i - 1].text += segments[i].text;
      segments.splice(i, 1);
    }
  }
}

/** Plain text with truncated URLs ("meta.com/thefu…") replaced by the full link. */
export function segmentsToText(segments) {
  return segments
    .map((s) => (s.type === 'link' && s.kind === 'url' ? s.href : s.text))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function parseCount(s) {
  if (!s) return 0;
  const m = String(s).replace(/,/g, '').trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// ---------------------------------------------------------------------------
// Open Graph fallback

export function parseOpenGraph(html) {
  const $ = cheerio.load(html);
  const meta = (p) => $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content') || '';
  const title = meta('og:title');
  const description = meta('og:description') || meta('description');
  if (!title && !description) return null;
  const m = title.match(/^(.*?)\s*\(@([A-Za-z0-9._]+)\)/);
  const username = m ? m[2] : null;
  const image = meta('og:image');
  return {
    post: {
      url: meta('og:url') || null,
      code: null,
      author: {
        username,
        fullName: m ? m[1] : null,
        profileUrl: username ? `https://www.threads.com/@${username}` : null,
        avatar: null,
        verified: false,
      },
      replyingTo: null,
      text: description,
      segments: [{ type: 'text', text: description }],
      media: image ? [{ type: 'image', url: image, alt: '' }] : [],
      linkPreview: null,
      quote: null,
      repostOf: null,
      displayTime: null,
      createdAt: null,
      stats: null,
      statsDisplay: null,
    },
  };
}
