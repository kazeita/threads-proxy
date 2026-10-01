import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEmbed, parseCount, parseOpenGraph, fetchThread, parsePostPage } from '../src/threads.js';
import { parseThreadsRef, parseThreadsPath, createdAtFromCode, unwrapLink, mediaIdFromCode } from '../src/url.js';
import { renderMarkdown, renderThread } from '../src/render.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

test('parses many link shapes', () => {
  const want = { code: 'Ddt7cL5EfUG', username: 'zuck' };
  assert.deepEqual(parseThreadsRef('https://www.threads.com/@zuck/post/Ddt7cL5EfUG?xmt=AQG0'), want);
  assert.deepEqual(parseThreadsRef('https://www.threads.net/@zuck/post/Ddt7cL5EfUG/media'), want);
  assert.deepEqual(parseThreadsRef('threads.net/@zuck/post/Ddt7cL5EfUG'), want);
  assert.deepEqual(parseThreadsRef('  @zuck/post/Ddt7cL5EfUG  '), want);
  assert.deepEqual(parseThreadsRef('https://threads.com/t/Ddt7cL5EfUG'), { code: 'Ddt7cL5EfUG', username: null });
  assert.deepEqual(parseThreadsRef('Ddt7cL5EfUG'), { code: 'Ddt7cL5EfUG', username: null });
  assert.deepEqual(parseThreadsRef('https://www.threads.com/@some.user_1/post/Dd1MriSm3-u'), { code: 'Dd1MriSm3-u', username: 'some.user_1' });
  assert.equal(parseThreadsRef('https://evil.com/@zuck/post/Ddt7cL5EfUG'), null);
  assert.equal(parseThreadsRef('https://www.threads.com/@zuck'), null);
  assert.equal(parseThreadsRef(''), null);
  assert.equal(parseThreadsPath('/%E0%A4%A'), null);
});

test('decodes creation time from shortcode', () => {
  assert.equal(mediaIdFromCode('Ddt7cL5EfUG'), '3994109866205639942');
  assert.equal(createdAtFromCode('Ddt7cL5EfUG'), '2026-09-25T16:50:21.259Z');
});

test('unwraps redirect links and strips tracking', () => {
  assert.equal(unwrapLink('https://l.facebook.com/l.php?u=https%3A%2F%2Fmeta.com%2Fx&h=AUC'), 'https://meta.com/x');
  assert.equal(unwrapLink('https://www.threads.com/@zuck?xmt=abc'), 'https://www.threads.com/@zuck');
});

test('parseCount', () => {
  assert.equal(parseCount('5K'), 5000);
  assert.equal(parseCount('2.9K'), 2900);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount(undefined), 0);
});

test('carousel embed: images + videos in order, stats, author', () => {
  const { post, context } = parseEmbed(fx('carousel'));
  assert.equal(context.length, 0);
  assert.equal(post.author.username, 'zuck');
  assert.equal(post.author.verified, true);
  assert.match(post.author.avatar, /avatar\.jpg/);
  assert.equal(post.text, "Agrippa said it's time to get back to work 😎");
  assert.deepEqual(post.media.map((m) => m.type), ['image', 'image', 'image', 'image', 'image', 'video', 'image', 'image', 'video']);
  assert.ok(post.media[0].url.includes('&oh=00_A&'), 'entities decoded in media URLs');
  assert.deepEqual(post.stats, { likes: 5000, replies: 496, reposts: 305, quotes: null, shares: 140 });
  assert.equal(post.displayTime, '9:50 AM · Sep 25, 2026');
  assert.equal(post.url, 'https://www.threads.com/@zuck/post/Ddt7cL5EfUG');
});

test('reply embed: parent goes to context', () => {
  const { post, context } = parseEmbed(fx('reply'));
  assert.equal(context.length, 1);
  assert.match(context[0].text, /^To lead this effort/);
  assert.equal(context[0].replyingTo, 'zuck');
  assert.equal(context[0].stats.likes, 134);
  assert.match(post.text, /^CJ joins us from MongoDB/);
  assert.equal(post.stats.likes, 121);
});

test('single video embed', () => {
  const { post } = parseEmbed(fx('video'));
  assert.equal(post.media.length, 1);
  assert.equal(post.media[0].type, 'video');
  assert.match(post.media[0].url, /solo\.mp4/);
  assert.equal(post.stats.likes, 2900);
});

test('links are unwrapped and expanded in plain text', () => {
  const { post } = parseEmbed(fx('link'));
  const link = post.segments.find((s) => s.type === 'link');
  assert.equal(link.href, 'https://meta.com/thefutureisforeveryone');
  assert.equal(link.kind, 'url');
  assert.match(post.text, /everyone: https:\/\/meta\.com\/thefutureisforeveryone\s*\n\nEvery lab has the responsibility & incentive/);
});

test('error embed', () => {
  const r = parseEmbed(fx('error'));
  assert.equal(r.post, null);
  assert.equal(r.error, 'Thread not available');
});

test('open graph fallback', () => {
  const html = `<meta property="og:title" content="Mark Zuckerberg (&#064;zuck) on Threads"><meta property="og:description" content="Agrippa said it&#039;s time &#x1f60e;"><meta property="og:image" content="https://instagram.fsgn2-11.fna.fbcdn.net/x.jpg">`;
  const { post } = parseOpenGraph(html);
  assert.equal(post.author.username, 'zuck');
  assert.equal(post.author.fullName, 'Mark Zuckerberg');
  assert.equal(post.text, "Agrippa said it's time 😎");
  assert.equal(post.media.length, 1);
});

function fakeFetch(routes) {
  return async (url) => {
    const r = routes[String(url)];
    if (!r) return new Response('nope', { status: 404 });
    return new Response(r.body, { status: r.status ?? 200 });
  };
}

test('fetchThread: embed path, canonical url uses parsed username', async () => {
  const f = fakeFetch({ 'https://www.threads.com/t/Ddt7cL5EfUG/embed': { body: fx('carousel') } });
  const r = await fetchThread({ code: 'Ddt7cL5EfUG', username: null }, { fetchImpl: f });
  assert.equal(r.source, 'embed');
  assert.equal(r.url, 'https://www.threads.com/@zuck/post/Ddt7cL5EfUG');
  assert.equal(r.post.createdAt, '2026-09-25T16:50:21.259Z');
  assert.deepEqual(r.replies, []);
  assert.match(r.note, /HTTP 404/);
});

test('fetchThread: falls back to open graph, then 404s', async () => {
  const og = `<meta property="og:title" content="A (@a.b) on Threads"><meta property="og:description" content="hello">`;
  const f1 = fakeFetch({
    'https://www.threads.com/t/Ddt7cL5EfUG/embed': { body: fx('error') },
    'https://www.threads.com/t/Ddt7cL5EfUG': { body: og },
    // post page without Relay JSON -> embed error -> OG
  });
  const r = await fetchThread({ code: 'Ddt7cL5EfUG', username: null }, { fetchImpl: f1 });
  assert.equal(r.source, 'opengraph');
  assert.equal(r.post.text, 'hello');
  assert.equal(r.url, 'https://www.threads.com/@a.b/post/Ddt7cL5EfUG');

  const f2 = fakeFetch({ 'https://www.threads.com/t/Ddt7cL5EfUG/embed': { body: fx('error') } });
  await assert.rejects(fetchThread({ code: 'Ddt7cL5EfUG', username: null }, { fetchImpl: f2 }), (e) => e.status === 404);
});

test('renderers escape content and include media', async () => {
  const f = fakeFetch({ 'https://www.threads.com/t/DdU1-6okapE/embed': { body: fx('link') } });
  const r = await fetchThread({ code: 'DdU1-6okapE', username: null }, { fetchImpl: f });
  const html = renderThread(r, { origin: 'http://x' });
  assert.match(html, /responsibility &amp; incentive/);
  assert.match(html, /href="https:\/\/meta\.com\/thefutureisforeveryone"/);
  const md = renderMarkdown(r, { origin: 'http://x' });
  assert.match(md, /Likes: 1,600/);
  assert.match(md, /Links:\n- https:\/\/meta\.com\/thefutureisforeveryone/);
});

// ---------------------------------------------------------------------------
// Post page (Relay JSON) — fixtures trimmed from real logged-out responses

test('post page: main post, exact stats, carousel, replies with sub-replies', () => {
  const r = parsePostPage(fx('page-carousel'), 'Ddt7cL5EfUG');
  assert.ok(r);
  const p = r.post;
  assert.equal(p.author.username, 'zuck');
  assert.equal(p.author.fullName, 'Mark Zuckerberg');
  assert.equal(p.author.verified, true);
  assert.equal(p.text, "Agrippa said it's time to get back to work 😎");
  assert.deepEqual(p.stats, { likes: 5017, replies: 496, reposts: 258, quotes: 47, shares: 140 });
  assert.equal(p.statsDisplay.likes, '5K');
  assert.equal(p.createdAt, '2026-09-25T16:50:21.000Z');
  assert.deepEqual(p.media.map((m) => m.type), ['image', 'video']);
  assert.equal(p.media[0].width, 2160);
  assert.match(p.media[1].poster, /824759444/);

  assert.equal(r.replies.length, 2);
  assert.equal(r.replies[0].posts[0].author.username, 'i_am_omerj');
  assert.equal(r.replies[0].posts[0].text, '💖💖💖');
  assert.equal(r.replies[0].posts[0].media.length, 0, 'text-only reply has no media');
  const sub = r.replies[1].posts;
  assert.equal(sub.length, 2);
  assert.equal(sub[1].replyingTo, 'zedski27');
  assert.equal(r.hasMoreReplies, true);
  assert.deepEqual(r.context, []);
  assert.deepEqual(r.selfThread, []);
});

test('post page: mention and wrapped link fragments', () => {
  const r = parsePostPage(fx('page-carousel'), 'Ddt7cL5EfUG');
  const q = r.replies[1].posts[0];
  const mention = q.segments.find((s) => s.kind === 'mention');
  assert.equal(mention.href, 'https://www.threads.com/@musetipsdaily');
  const link = q.segments.find((s) => s.kind === 'url');
  assert.equal(link.href, 'https://ai.meta.com/muse/pricing');
  assert.equal(q.text, 'How much is Muse going to cost? Ask @musetipsdaily or see https://ai.meta.com/muse/pricing');
});

test('post page: reply post has parent chain (excluding itself) and author follow-ups', () => {
  const r = parsePostPage(fx('page-reply'), 'Dd1MriSm3-u');
  assert.equal(r.post.code, 'Dd1MriSm3-u');
  assert.equal(r.post.replyingTo, 'zuck');
  assert.deepEqual(r.context.map((p) => p.code), ['Dd1MqfcG0aH', 'Dd1Mqfum3QF']);
  assert.equal(r.context[0].stats.replies, 2417);
  assert.deepEqual(r.selfThread.map((p) => p.code), ['Dd1MqeyG15H']);
  assert.equal(r.replies.length, 1);
  assert.equal(r.hasMoreReplies, false);
});

test('post page without data returns null', () => {
  assert.equal(parsePostPage('<html><body>login</body></html>', 'Ddt7cL5EfUG'), null);
  assert.equal(parsePostPage(fx('page-carousel'), 'OtherCode123'), null);
});

test('fetchThread prefers the post page and sends a browser Accept header', async () => {
  let seenAccept = null;
  const f = async (url, opts) => {
    if (String(url) === 'https://www.threads.com/@zuck/post/Ddt7cL5EfUG') {
      seenAccept = opts.headers.accept;
      return new Response(fx('page-carousel'));
    }
    return new Response('nope', { status: 404 });
  };
  const r = await fetchThread({ code: 'Ddt7cL5EfUG', username: 'zuck' }, { fetchImpl: f });
  assert.equal(r.source, 'page');
  assert.equal(r.replyCount, 496);
  assert.equal(r.directRepliesShown, 2);
  assert.equal(r.nestedRepliesShown, 1);
  assert.equal(r.replies.length, 2);
  assert.match(seenAccept, /^text\/html,application\/xhtml\+xml,application\/xml;q=0\.9/);
  assert.equal(r.note, undefined);
});

test('markdown includes replies, nesting and the more-replies note', async () => {
  const f = async (url) =>
    String(url) === 'https://www.threads.com/t/Ddt7cL5EfUG' ? new Response(fx('page-carousel')) : new Response('', { status: 404 });
  const r = await fetchThread({ code: 'Ddt7cL5EfUG', username: null }, { fetchImpl: f });
  const md = renderMarkdown(r, { origin: 'http://x' });
  assert.match(md, /## Replies \(2 of 496 direct replies shown, plus 1 nested\)/);
  assert.match(md, /- \*\*@i_am_omerj\*\* ✓/);
  assert.match(md, /\n  - \*\*@musetipsdaily\*\*/);
  assert.match(md, /Quotes: 47/);
  assert.match(md, /More replies exist/);
  const html = renderThread(r, { origin: 'http://x' });
  assert.match(html, /showing 2 of 496 · \+1 nested/);
  assert.match(html, /href="\/t\/DdwX1zzmws_">1 replies →|href="\/t\/DdwX1zzmws_"/);
});
