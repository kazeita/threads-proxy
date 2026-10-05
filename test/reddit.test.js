import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseListing, submissionMedia, normalizeSubmission, htmlToSegments, parseRedditHtml, fetchReddit } from '../src/reddit.js';
import { parseRedditRef, parseRedditPath, redditProxyPath } from '../src/reddit-url.js';
import { renderMarkdown, renderThread, renderText } from '../src/render.js';

const raw = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(raw(name));
const MEDIA = json('reddit-media.json');
MEDIA.crosspost.crosspost_parent_list = [MEDIA.video];
const listing = (t3, comments = []) => [{ kind: 'Listing', data: { children: [{ kind: 't3', data: t3 }] } }, { kind: 'Listing', data: { children: comments } }];

test('parses Reddit link shapes', () => {
  const post = { platform: 'reddit', id: '1fxk2ab', subreddit: 'webdev', commentId: null };
  assert.deepEqual(parseRedditRef('https://www.reddit.com/r/webdev/comments/1fxk2ab/whats_one_tool/'), post);
  assert.deepEqual(parseRedditRef('https://old.reddit.com/r/webdev/comments/1fxk2ab/whats_one_tool/?utm_source=share'), post);
  assert.deepEqual(parseRedditRef('reddit.com/r/webdev/comments/1fxk2ab'), post);
  assert.deepEqual(parseRedditRef('r/webdev/comments/1fxk2ab'), post);
  assert.deepEqual(parseRedditRef('https://www.reddit.com/r/webdev/comments/1fxk2ab/whats_one_tool/.json'), post);
  assert.deepEqual(parseRedditRef('https://www.reddit.com/r/webdev/comments/1fxk2ab/whats_one_tool/lqm0002/?context=3'), { ...post, commentId: 'lqm0002' });
  assert.deepEqual(parseRedditRef('https://www.reddit.com/r/webdev/comments/1fxk2ab/comment/lqm0002/'), { ...post, commentId: 'lqm0002' });
  assert.deepEqual(parseRedditRef('https://redd.it/1fxk2ab'), { ...post, subreddit: null });
  assert.deepEqual(parseRedditRef('https://www.reddit.com/gallery/1fxk2ab'), { ...post, subreddit: null });
  assert.deepEqual(parseRedditRef('https://www.reddit.com/user/spez/comments/1fxk2ab/hi/'), { ...post, subreddit: 'u_spez' });
  assert.deepEqual(parseRedditRef('https://www.reddit.com/r/webdev/s/AbCd3fGh12'), { platform: 'reddit', share: 'AbCd3fGh12', subreddit: 'webdev' });
  assert.equal(parseRedditRef('https://www.reddit.com/r/webdev/'), null);
  assert.equal(parseRedditRef('https://evilreddit.com/r/webdev/comments/1fxk2ab'), null);
  assert.equal(parseRedditRef('Ddt7cL5EfUG'), null, 'bare codes are Threads');
  assert.equal(parseRedditPath('/comments/1fxk2ab/_/lqm0002').commentId, 'lqm0002');
  assert.equal(redditProxyPath({ id: 'x1', subreddit: 'a_b', commentId: 'c2' }), '/r/a_b/comments/x1/_/c2');
});

test('rendered Markdown becomes readable segments', () => {
  const segs = htmlToSegments(json('reddit-post.json')[0].data.children[0].data.selftext_html);
  const text = segs.map((s) => s.text).join('');
  assert.equal(text, "I'll start: ripgrep.\n\nReasons:\n\n• fast\n• sane defaults\n\n> quoted line\n\nMore at https://github.com/BurntSushi/ripgrep or r/commandline, thanks u/burntsushi");
  const links = segs.filter((s) => s.type === 'link');
  assert.deepEqual(links.map((l) => l.kind), ['url', 'community', 'mention']);
  assert.equal(links[1].href, 'https://www.reddit.com/r/commandline');
  const post = htmlToSegments('<div class="md"><p>see <a href="https://www.reddit.com/r/x/comments/abc12/t/">this</a></p><ol><li><p>one</p></li><li>two</li></ol></div>');
  assert.equal(post.find((s) => s.kind === 'post').proxyPath, '/r/x/comments/abc12');
  assert.equal(post.map((s) => s.text).join(''), 'see this\n\n1. one\n2. two');
});

test('post listing: stats, flags, comment tree with depth, OP, mods, more-stubs', () => {
  const r = parseListing(json('reddit-post.json'), { id: '1fxk2ab' });
  const p = r.post;
  assert.equal(p.platform, 'reddit');
  assert.equal(p.kind, 'post');
  assert.equal(p.title, "What's one tool you can't live without? & why");
  assert.equal(p.community.name, 'r/webdev');
  assert.match(p.community.icon, /^https:\/\/styles\.redditmedia\.com\//);
  assert.equal(p.author.username, 'pixel_wrangler');
  assert.equal(p.author.flair, 'full-stack');
  assert.equal(p.flair, 'Discussion');
  assert.deepEqual(p.stats, { score: 1234, upvoteRatio: 0.97, comments: 412, crossposts: 2 });
  assert.equal(p.statsDisplay.upvoteRatio, '97%');
  assert.equal(p.createdAt, '2024-10-04T00:00:00.000Z');
  assert.equal(p.editedAt, '2024-10-04T01:00:00.000Z');
  assert.match(p.text, /^I'll start: \*\*ripgrep\*\*/, 'text keeps the Markdown source');
  assert.equal(p.media.length, 0);
  assert.equal(p.linkPreview, null);

  assert.equal(r.replies.length, 3);
  const [mod, tree, gif] = r.replies;
  assert.equal(mod.posts[0].distinguished, 'moderator');
  assert.equal(mod.posts[0].pinned, true);
  assert.deepEqual(tree.posts.map((c) => [c.code, c.depth]), [['lqm0002', 0], ['lqm0003', 1], ['lqm0004', 2]]);
  assert.equal(tree.posts[0].moreReplies, 7);
  assert.equal(tree.posts[0].stats.replies, 8, 'one loaded reply + 7 more');
  assert.equal(tree.posts[1].isOp, true);
  assert.equal(tree.posts[1].replyingTo, 'vim_enjoyer');
  assert.equal(tree.posts[2].author.username, '[deleted]');
  assert.equal(tree.posts[2].author.profileUrl, null);
  assert.equal(tree.posts[2].stats.score, null, 'score hidden');
  assert.equal(tree.posts[2].continueThread, true);
  assert.equal(tree.posts[0].proxyPath, '/r/webdev/comments/1fxk2ab/_/lqm0002');
  assert.deepEqual(gif.posts[0].media.map((m) => [m.type, m.gif]), [['video', true]]);
  assert.equal(r.hasMoreReplies, true);
  assert.deepEqual(r.context, []);
});

test('comment permalink: parents become context, target replies below', () => {
  const r = parseListing(json('reddit-comment.json'), { id: '1fxk2ab', commentId: 'lqm0003' });
  assert.deepEqual(r.context.map((p) => [p.kind, p.code]), [['post', '1fxk2ab'], ['comment', 'lqm0002']]);
  assert.equal(r.context[1].replyingTo, 'pixel_wrangler');
  assert.equal(r.context[1].stats.replies, null, 'unknown for parents');
  assert.equal(r.post.code, 'lqm0003');
  assert.equal(r.post.replyingTo, 'vim_enjoyer');
  assert.equal(r.post.isOp, true);
  assert.equal(r.post.stats.replies, 3);
  assert.deepEqual(r.replies.map((t) => t.posts.map((p) => p.code)), [['lqm0006']]);
  assert.equal(r.hasMoreReplies, true);
  assert.equal(parseListing(json('reddit-comment.json'), { id: '1fxk2ab', commentId: 'zzz' }), null);
});

test('fetchReddit: a missing comment is a 404, not its parent post', async () => {
  const f = fakeFetch({ 'https://www.reddit.com/comments/1fxk2ab.json?': { body: raw('reddit-comment.json') } });
  await assert.rejects(fetchReddit({ platform: 'reddit', id: '1fxk2ab', subreddit: 'webdev', commentId: 'zzz' }, { fetchImpl: f }), (e) => e.status === 404 && /comment/.test(e.message));
});

test('media: gallery order and captions, video with HLS, image, link preview, crosspost', () => {
  const g = submissionMedia(MEDIA.gallery);
  assert.deepEqual(g.map((m) => [m.type, m.width, m.alt]), [['image', 4000, 'Sunset'], ['image', 1920, '']]);
  const [v] = submissionMedia(MEDIA.video);
  assert.equal(v.type, 'video');
  assert.match(v.url, /DASH_720\.mp4/);
  assert.match(v.hlsUrl, /HLSPlaylist\.m3u8/);
  assert.equal(v.hasAudio, true);
  assert.match(v.poster, /external-preview/);
  const img = normalizeSubmission(MEDIA.image);
  assert.deepEqual(img.media.map((m) => [m.url, m.width]), [['https://i.redd.it/photo.jpeg', 3024]]);
  assert.equal(img.linkPreview, null);
  assert.equal(img.flags.nsfw, true);
  assert.equal(img.flags.spoiler, true);
  const link = normalizeSubmission(MEDIA.link);
  assert.deepEqual(link.linkPreview, { url: 'https://example.com/story?id=1', displayUrl: 'example.com', title: null, image: 'https://external-preview.redd.it/thumb.jpg?s=2' });
  const x = normalizeSubmission(MEDIA.crosspost);
  assert.equal(x.media.length, 0);
  assert.equal(x.linkPreview, null);
  assert.equal(x.repostOf.community.name, 'r/aww');
  assert.equal(x.repostOf.media[0].type, 'video');
});

function fakeFetch(routes, seen = []) {
  return async (url, opts = {}) => {
    seen.push({ url: String(url), opts });
    for (const [prefix, r] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) return typeof r === 'function' ? r(url, opts) : new Response(r.body, { status: r.status ?? 200, headers: r.headers });
    }
    return new Response('<html>blocked</html>', { status: 403 });
  };
}

test('fetchReddit: JSON endpoint with raw_json and a descriptive user agent', async () => {
  const seen = [];
  const f = fakeFetch({ 'https://www.reddit.com/comments/1fxk2ab.json?': { body: raw('reddit-post.json') } }, seen);
  const r = await fetchReddit({ platform: 'reddit', id: '1fxk2ab', subreddit: null, commentId: null }, { fetchImpl: f });
  assert.equal(r.platform, 'reddit');
  assert.equal(r.source, 'api');
  assert.equal(r.url, 'https://www.reddit.com/r/webdev/comments/1fxk2ab/whats_one_tool_you_cant_live_without/');
  assert.equal(r.proxyPath, '/r/webdev/comments/1fxk2ab');
  assert.equal(r.replyCount, 412);
  assert.equal(r.directRepliesShown, 3);
  assert.equal(r.nestedRepliesShown, 2);
  assert.equal(r.note, undefined);
  const q = new URL(seen[0].url).searchParams;
  assert.equal(q.get('raw_json'), '1');
  assert.match(seen[0].opts.headers['user-agent'], /threads-proxy/);
});

test('fetchReddit: blocked www falls back to old.reddit, then the HTML page', async () => {
  const f1 = fakeFetch({ 'https://old.reddit.com/comments/1fxk2ab.json?': { body: raw('reddit-comment.json') } });
  const r1 = await fetchReddit({ platform: 'reddit', id: '1fxk2ab', subreddit: 'webdev', commentId: 'lqm0003' }, { fetchImpl: f1 });
  assert.equal(r1.source, 'api');
  assert.equal(r1.code, 'lqm0003');
  assert.equal(r1.proxyPath, '/r/webdev/comments/1fxk2ab/_/lqm0003');
  assert.equal(r1.replyCount, 3);

  const f2 = fakeFetch({ 'https://www.reddit.com/r/EarthPorn/comments/1g00htm/': { body: raw('reddit-page.html') } });
  const r2 = await fetchReddit({ platform: 'reddit', id: '1g00htm', subreddit: 'EarthPorn', commentId: null }, { fetchImpl: f2 });
  assert.equal(r2.source, 'html');
  assert.equal(r2.post.title, 'Two views [OC]');
  assert.equal(r2.post.text, 'Hello [example](https://example.com/)');
  assert.equal(r2.post.stats.comments, 10);
  assert.deepEqual(r2.replies.map((t) => t.posts.map((p) => [p.author.username, p.depth])), [[['first', 0], ['hiker', 1]]]);
  assert.match(r2.note, /reddit\.com JSON returned HTTP 403 \(blocked\)/);
});

test('fetchReddit: OAuth when credentials are set; API errors map to statuses', async () => {
  process.env.REDDIT_CLIENT_ID = 'id';
  process.env.REDDIT_CLIENT_SECRET = 'secret';
  try {
    const seen = [];
    const f = fakeFetch(
      {
        'https://www.reddit.com/api/v1/access_token': { body: JSON.stringify({ access_token: 'tok', expires_in: 3600 }) },
        'https://oauth.reddit.com/comments/1fxk2ab?': { body: raw('reddit-post.json') },
      },
      seen,
    );
    const r = await fetchReddit({ platform: 'reddit', id: '1fxk2ab', subreddit: null, commentId: null }, { fetchImpl: f });
    assert.equal(r.source, 'api');
    assert.equal(seen[0].opts.headers.authorization, 'Basic ' + btoa('id:secret'));
    assert.equal(seen[1].opts.headers.authorization, 'bearer tok');
  } finally {
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
  }
  const priv = fakeFetch({ 'https://www.reddit.com/comments/': { status: 403, body: JSON.stringify({ reason: 'private', message: 'Forbidden', error: 403 }) } });
  await assert.rejects(fetchReddit({ platform: 'reddit', id: 'abc12', subreddit: null, commentId: null }, { fetchImpl: priv }), (e) => e.status === 403 && /private/.test(e.message));
  const gone = fakeFetch({ 'https://www.reddit.com/comments/': { status: 404, body: JSON.stringify({ message: 'Not Found', error: 404 }) } });
  await assert.rejects(fetchReddit({ platform: 'reddit', id: 'abc12', subreddit: null, commentId: null }, { fetchImpl: gone }), (e) => e.status === 404);
});

test('fetchReddit: share links are resolved through their redirect', async () => {
  const f = fakeFetch({
    'https://www.reddit.com/r/webdev/s/AbCd3fGh12': { status: 301, body: '', headers: { location: 'https://www.reddit.com/r/webdev/comments/1fxk2ab/whats_one_tool/?share_id=x' } },
    'https://www.reddit.com/comments/1fxk2ab.json?': { body: raw('reddit-post.json') },
  });
  const r = await fetchReddit({ platform: 'reddit', share: 'AbCd3fGh12', subreddit: 'webdev' }, { fetchImpl: f });
  assert.equal(r.code, '1fxk2ab');
  const blocked = fakeFetch({});
  await assert.rejects(fetchReddit({ platform: 'reddit', share: 'AbCd3fGh12', subreddit: 'webdev' }, { fetchImpl: blocked }), (e) => e.status === 502 && /paste the full link/.test(e.message));
});

test('open graph fallback when the page has no post element', () => {
  const html = '<meta property="og:title" content="A title : r/pics"><meta property="og:url" content="https://www.reddit.com/r/pics/comments/abc12/a_title/"><meta property="og:image" content="https://i.redd.it/x.jpg">';
  const r = parseRedditHtml(html, { id: 'abc12', subreddit: null });
  assert.equal(r.source, 'opengraph');
  assert.equal(r.post.title, 'A title');
  assert.equal(r.post.subreddit, 'pics');
  assert.equal(r.post.media.length, 1);
});

test('renderers: Reddit markdown, html and text', async () => {
  const f = fakeFetch({ 'https://www.reddit.com/comments/1fxk2ab.json?': { body: raw('reddit-post.json') } });
  const r = await fetchReddit({ platform: 'reddit', id: '1fxk2ab', subreddit: 'webdev', commentId: null }, { fetchImpl: f });
  const md = renderMarkdown(r, { origin: 'http://x' });
  assert.match(md, /^# Reddit post in r\/webdev by u\/pixel_wrangler\n/);
  assert.match(md, /Proxy: http:\/\/x\/r\/webdev\/comments\/1fxk2ab\n/);
  assert.match(md, /^## What's one tool you can't live without\? & why$/m);
  assert.match(md, /- Score: 1,234 · Upvoted: 97% · Comments: 412 · Crossposts: 2/);
  assert.match(md, /## Comments \(5 of 412 shown\)/);
  assert.match(md, /^- \*\*u\/vim_enjoyer\*\* \(2024-10-04 00:05 UTC · 456 points · 8 replies\) \[link\]\(http:\/\/x\/r\/webdev\/comments\/1fxk2ab\/_\/lqm0002\.md\)$/m);
  assert.match(md, /^  - \*\*u\/pixel_wrangler\*\* \(OP\)/m);
  assert.match(md, /^    - \*\*\[deleted\]\*\* \(2024-10-04 00:15 UTC · score hidden\)/m);
  assert.match(md, /_\+7 more replies: http:\/\/x\/r\/webdev\/comments\/1fxk2ab\/_\/lqm0002\.md_/);
  assert.match(md, /\(mod\)/);

  const html = renderThread(r, { origin: 'http://x' });
  assert.match(html, /<h1 class="title">What&#39;s one tool you can&#39;t live without\? &amp; why<\/h1>/);
  assert.match(html, /Open on Reddit ↗/);
  assert.match(html, /href="\/r\/webdev\/comments\/1fxk2ab\.json"/);
  assert.match(html, /Comments <span>showing 5 of 412<\/span>/);
  assert.match(html, /<span class="badge">OP<\/span>/);
  assert.match(html, /\+7 more replies →/);
  assert.match(html, /Continue this thread →/);
  assert.match(html, /<b>97%<\/b> upvoted/);
  assert.match(html, /class="cpost nested" style="--d:2"/);
  assert.match(html, /<title>What&#39;s one tool you can&#39;t live without\? &amp; why : r\/webdev<\/title>/);
  assert.match(html, /autoplay loop muted playsinline/, 'gifs loop silently');

  const txt = renderText(r);
  assert.match(txt, /^What's one tool/);
  assert.match(txt, /=== Comments ===/);
  assert.match(txt, /\n    \[deleted\]: \[deleted\]\n/);
});

test('renderers: Reddit video gets an HLS source, crossposts show their origin', () => {
  const r = {
    platform: 'reddit',
    code: '1g00xp0',
    url: 'https://www.reddit.com/r/funny/comments/1g00xp0/cat_xpost/',
    proxyPath: '/r/funny/comments/1g00xp0',
    source: 'api',
    post: normalizeSubmission(MEDIA.crosspost),
    context: [],
    selfThread: [],
    replies: [],
    replyCount: 0,
    hasMoreReplies: false,
  };
  const html = renderThread(r, { origin: 'http://x' });
  assert.match(html, /Crossposted · r\/aww · u\/catperson/);
  assert.match(html, /data-hls="\/media\?u=https%3A%2F%2Fv\.redd\.it%2Fabc123%2FHLSPlaylist\.m3u8/);
  assert.match(html, /href="\/r\/aww\/comments\/1g00vid"/);
  const md = renderMarkdown(r, { origin: 'http://x' });
  assert.match(md, /> Crossposted from r\/aww by u\/catperson/);
  assert.match(md, /\[Video 1\]\(http:\/\/x\/media\?u=.*DASH_720.*\) \(with sound, HLS: http:\/\/x\/media\?u=/);
  assert.match(md, /_No comments yet\._/);
});

test('listing helper builds the same shape', () => {
  const r = parseListing(listing(MEDIA.gallery), { id: '1g00gal' });
  assert.equal(r.post.media.length, 2);
  assert.deepEqual(r.replies, []);
  assert.equal(r.hasMoreReplies, false);
});
