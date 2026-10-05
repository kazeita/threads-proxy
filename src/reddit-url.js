// Parsing and normalising Reddit links.

const ID_RE = /^[a-z0-9]{1,12}$/i;
const SUB_RE = /^[A-Za-z0-9_]{1,21}$/;
const USER_RE = /^[A-Za-z0-9_-]{2,20}$/;
const SHARE_RE = /^[A-Za-z0-9]{4,20}$/;
const REDDIT_HOST_RE = /^((www|old|new|np|m|i|sh|amp)\.)?reddit\.com$/i;
const SHORT_HOST_RE = /^(www\.)?redd\.it$/i;

export const REDDIT_ORIGIN = 'https://www.reddit.com';

/**
 * Accepts anything a person might paste and returns a Reddit ref or null:
 *   { platform: 'reddit', id, subreddit, commentId }   a post, or a comment in it
 *   { platform: 'reddit', share, subreddit }           a /r/SUB/s/CODE share link (resolved when fetched)
 * Forms:
 *   https://www.reddit.com/r/sub/comments/1abcde/some_title/
 *   https://old.reddit.com/r/sub/comments/1abcde/some_title/kxyz123/?context=3
 *   https://www.reddit.com/r/sub/comments/1abcde/comment/kxyz123/
 *   https://www.reddit.com/user/name/comments/1abcde/title/
 *   https://www.reddit.com/r/sub/s/AbCdEf123
 *   https://redd.it/1abcde, reddit.com/gallery/1abcde
 *   r/sub/comments/1abcde
 */
export function parseRedditRef(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;

  if (!/^[a-z]+:\/\//i.test(s)) {
    if (/^([a-z]+\.)?(reddit\.com|redd\.it)\//i.test(s)) s = 'https://' + s;
    else if (/^\/?(r|u|user|comments)\//i.test(s)) s = REDDIT_ORIGIN + (s.startsWith('/') ? '' : '/') + s;
    else return null;
  }

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (SHORT_HOST_RE.test(host)) {
    const id = u.pathname.split('/').filter(Boolean)[0];
    return id && ID_RE.test(id) ? { platform: 'reddit', id: id.toLowerCase(), subreddit: null, commentId: null } : null;
  }
  if (!REDDIT_HOST_RE.test(host)) return null;
  return parseRedditPath(u.pathname);
}

/** Parses a Reddit-style path (also used for mirrored paths on this proxy). */
export function parseRedditPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.at(-1) === '.json') parts.pop();
  else if (parts.length) parts[parts.length - 1] = parts.at(-1).replace(/\.json$/i, '');

  let subreddit = null;
  let rest = parts;
  if ((parts[0] === 'r' || parts[0] === 'R') && SUB_RE.test(parts[1] || '')) {
    subreddit = parts[1];
    rest = parts.slice(2);
    // /r/SUB/s/CODE share links
    if (rest[0] === 's' && SHARE_RE.test(rest[1] || '') && rest.length === 2) {
      return { platform: 'reddit', share: rest[1], subreddit };
    }
  } else if ((parts[0] === 'user' || parts[0] === 'u') && USER_RE.test(parts[1] || '')) {
    subreddit = `u_${parts[1]}`;
    rest = parts.slice(2);
  }

  // /gallery/ID
  if (!subreddit && rest[0] === 'gallery' && ID_RE.test(rest[1] || '')) {
    return { platform: 'reddit', id: rest[1].toLowerCase(), subreddit: null, commentId: null };
  }
  // comments/ID[/slug[/CID]] or comments/ID/comment/CID
  if (rest[0] !== 'comments' || !ID_RE.test(rest[1] || '')) return null;
  // The comment ID follows the slug (comments/ID/slug/CID) or a "comment" segment (comments/ID[/slug]/comment/CID).
  const at = rest[2] === 'comment' ? 3 : rest[3] === 'comment' ? 4 : 3;
  const cid = rest[at] && ID_RE.test(rest[at]) ? rest[at].toLowerCase() : null;
  return { platform: 'reddit', id: rest[1].toLowerCase(), subreddit, commentId: cid };
}

/** Path on this proxy that mirrors the Reddit link. */
export function redditProxyPath(ref) {
  if (ref.share) return `/r/${ref.subreddit}/s/${ref.share}`;
  const base = ref.subreddit ? `/r/${ref.subreddit}/comments/${ref.id}` : `/comments/${ref.id}`;
  return ref.commentId ? `${base}/_/${ref.commentId}` : base;
}

export function redditCanonicalUrl(ref) {
  const p = redditProxyPath(ref);
  return REDDIT_ORIGIN + (ref.share ? p : p + '/');
}

export function isRedditHost(hostname) {
  const h = String(hostname).toLowerCase();
  return REDDIT_HOST_RE.test(h) || SHORT_HOST_RE.test(h);
}
