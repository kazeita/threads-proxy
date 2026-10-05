import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}.html`, import.meta.url), 'utf8');
const json = (n) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8');
const realFetch = globalThis.fetch;
let handle;

before(async () => {
  process.env.RATE_LIMIT_PER_MIN = '0';
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'www.threads.com') {
      if (u.pathname === '/t/Ddt7cL5EfUG' || u.pathname === '/@zuck/post/Ddt7cL5EfUG') return new Response(fx('page-carousel'));
      if (u.pathname === '/t/DOdVHOeERQj/embed') return new Response(fx('error'));
      return new Response('nf', { status: 404 });
    }
    if (u.hostname === 'www.reddit.com' || u.hostname === 'old.reddit.com') {
      if (u.pathname === '/comments/1fxk2ab.json') return new Response(u.searchParams.get('comment') ? json('reddit-comment') : json('reddit-post'));
      return new Response(JSON.stringify({ message: 'Not Found', error: 404 }), { status: 404 });
    }
    if (u.hostname === 'v.redd.it' && u.pathname.endsWith('.m3u8')) {
      return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="HLS_AUDIO_64.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nHLS_720.m3u8?a=1\n', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (/cdninstagram|fbcdn|redd\.it$/.test(u.hostname)) return new Response('IMG', { headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
    if (u.hostname === 'evil.example') return new Response('<html>', { headers: { 'content-type': 'text/html' } });
    throw new Error('unexpected fetch ' + u);
  };
  ({ handle } = await import('../src/handler.js'));
});
after(() => {
  globalThis.fetch = realFetch;
});

const get = (path, headers = {}) => handle(new Request('http://localhost:3000' + path, { headers }));

test('home and static routes', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Read any Threads or Reddit post/);
  assert.equal((await get('/healthz')).status, 200);
  const robots = await (await get('/robots.txt')).text();
  assert.doesNotMatch(robots, /Disallow/, 'agents must be allowed to fetch');
  assert.match(await (await get("/llms.txt")).text(), /\/fetch\.md\?url=/);
});

test('vercel rewrite path (?__p=) is honoured', async () => {
  const r = await handle(new Request('https://proxy.example/api/index?__p=t/Ddt7cL5EfUG&format=json'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.replies.length, 2);
  assert.match(j.post.media[0].proxyUrl, /^https:\/\/proxy\.example\/media\?u=/);
  const home = await handle(new Request('https://proxy.example/api/index?__p='));
  assert.match(await home.text(), /Read any Threads or Reddit post/);
});

test('api formats', async () => {
  const j = await (await get('/fetch?url=' + encodeURIComponent('https://www.threads.net/@zuck/post/Ddt7cL5EfUG?xmt=1'))).json();
  assert.equal(j.source, 'page');
  assert.equal(j.post.stats.likes, 5017);
  const md = await get('/fetch.md?url=Ddt7cL5EfUG');
  assert.match(md.headers.get('content-type'), /markdown/);
  assert.match(await md.text(), /## Replies/);
  const txt = await (await get('/@zuck/post/Ddt7cL5EfUG?format=text')).text();
  assert.match(txt, /=== Replies ===/);
  const neg = await get('/t/Ddt7cL5EfUG', { accept: 'application/json' });
  assert.match(neg.headers.get('content-type'), /json/);
});

test('errors', async () => {
  assert.equal((await get('/fetch?url=nope')).status, 400);
  assert.equal((await get('/api/thread?url=nope')).status, 400, 'legacy alias still routed');
  const nf = await get('/t/DOdVHOeERQj?format=json');
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).ok, false);
  assert.equal((await get('/nothing/here')).status, 404);
  const pasted = await get('/https:/www.threads.com/@zuck/post/Ddt7cL5EfUG');
  assert.equal(pasted.status, 302);
  assert.equal(pasted.headers.get('location'), '/t/Ddt7cL5EfUG');
});

test('media proxy only allows Meta CDN', async () => {
  const ok = await get('/media?u=' + encodeURIComponent('https://scontent.cdninstagram.com/v/x.jpg'));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'IMG');
  assert.equal(ok.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await get('/media?u=' + encodeURIComponent('https://evil.example/x'))).status, 403);
  assert.equal((await get('/media?u=' + encodeURIComponent('https://evil.example.fbcdn.net.attacker.com/x'))).status, 403);
});

test('query-free path forms work (some agent fetchers drop query strings)', async () => {
  for (const [p, type, needle] of [
    ['/t/Ddt7cL5EfUG.md', /markdown/, /^# Threads post by @zuck/],
    ['/t/Ddt7cL5EfUG.json', /json/, /"ok": true/],
    ['/t/Ddt7cL5EfUG.txt', /text\/plain/, /=== Replies ===/],
    ['/@zuck/post/Ddt7cL5EfUG.md', /markdown/, /## Replies/],
    ['/fetch.md/Ddt7cL5EfUG', /markdown/, /^# Threads post/],
    ['/fetch.md/https://www.threads.com/@zuck/post/Ddt7cL5EfUG', /markdown/, /^# Threads post/],
    ['/fetch.md/https:/www.threads.com/@zuck/post/Ddt7cL5EfUG', /markdown/, /^# Threads post/],
    ['/fetch.md/' + encodeURIComponent('https://www.threads.com/@zuck/post/Ddt7cL5EfUG?xmt=abc'), /markdown/, /^# Threads post/],
    ['/fetch/Ddt7cL5EfUG', /json/, /"directRepliesShown": 2/],
  ]) {
    const r = await get(p, { accept: 'text/html' });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
    assert.match(await r.text(), needle, p);
  }
});

test('same paths via the Vercel rewrite', async () => {
  const r = await handle(new Request('https://proxy.example/api/index?__p=' + encodeURIComponent('fetch.md/https://www.threads.com/@zuck/post/Ddt7cL5EfUG')));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /^# Threads post/);
  const t = await handle(new Request('https://proxy.example/api/index?__p=t/Ddt7cL5EfUG.json'));
  assert.equal((await t.json()).code, 'Ddt7cL5EfUG');
});

test('format param still works on /t/ and responses vary on Accept', async () => {
  const r = await get('/t/Ddt7cL5EfUG?format=json', { accept: 'text/html' });
  assert.match(r.headers.get('content-type'), /json/);
  assert.equal(r.headers.get('vary'), 'Accept');
});

// ---------------------------------------------------------------------------
// Reddit

test('reddit: mirrored paths in every format', async () => {
  for (const [p, type, needle] of [
    ['/r/webdev/comments/1fxk2ab', /text\/html/, /<h1 class="title">What&#39;s one tool/],
    ['/r/webdev/comments/1fxk2ab/whats_one_tool_you_cant_live_without/', /text\/html/, /Open on Reddit/],
    ['/r/webdev/comments/1fxk2ab.md', /markdown/, /^# Reddit post in r\/webdev by u\/pixel_wrangler/],
    ['/r/webdev/comments/1fxk2ab/whats_one_tool_you_cant_live_without/.json', /json/, /"platform": "reddit"/],
    ['/r/webdev/comments/1fxk2ab.txt', /text\/plain/, /=== Comments ===/],
    ['/comments/1fxk2ab.md', /markdown/, /## Comments \(5 of 412 shown\)/],
    ['/r/webdev/comments/1fxk2ab/_/lqm0003.md', /markdown/, /^# Reddit comment by u\/pixel_wrangler in r\/webdev/],
    ['/r/webdev/comments/1fxk2ab/whats_one_tool/comment/lqm0003.md', /markdown/, /## In reply to/],
  ]) {
    const r = await get(p, { accept: 'text/html' });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
    assert.match(await r.text(), needle, p);
  }
});

test('reddit: /fetch with any link form, JSON proxy URLs, errors', async () => {
  const j = await (await get('/fetch/https:/www.reddit.com/r/webdev/comments/1fxk2ab/whats/?utm_source=share')).json();
  assert.equal(j.ok, true);
  assert.equal(j.platform, 'reddit');
  assert.equal(j.proxyPath, '/r/webdev/comments/1fxk2ab');
  assert.match(j.post.community.iconProxyUrl, /^http:\/\/localhost:3000\/media\?u=https%3A%2F%2Fstyles\.redditmedia\.com/);
  assert.equal(j.replies[1].posts[2].depth, 2);
  const md = await get('/fetch.md?url=' + encodeURIComponent('https://redd.it/1fxk2ab'));
  assert.match(await md.text(), /^# Reddit post/);
  const nf = await get('/r/webdev/comments/zzzzz9.json');
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).url, 'https://www.reddit.com/r/webdev/comments/zzzzz9/');
  const bad = await get('/fetch.md/https://www.reddit.com/r/webdev/');
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Threads or Reddit/);
  const pasted = await get('/https:/www.reddit.com/r/webdev/comments/1fxk2ab/whats/lqm0003/');
  assert.equal(pasted.status, 302);
  assert.equal(pasted.headers.get('location'), '/r/webdev/comments/1fxk2ab/_/lqm0003');
});

test('reddit: media proxy allows Reddit hosts and rewrites HLS playlists', async () => {
  assert.equal((await get('/media?u=' + encodeURIComponent('https://i.redd.it/x.jpg'))).status, 200);
  assert.equal((await get('/media?u=' + encodeURIComponent('https://preview.redd.it/x.jpg?s=1'))).status, 200);
  assert.equal((await get('/media?u=' + encodeURIComponent('https://evil.example/redd.it'))).status, 403);
  assert.equal((await get('/media?u=' + encodeURIComponent('https://redd.it.evil.example/x'))).status, 403);
  const pl = await get('/media?u=' + encodeURIComponent('https://v.redd.it/abc/HLSPlaylist.m3u8?a=1'));
  assert.equal(pl.status, 200);
  const body = await pl.text();
  assert.match(body, /URI="\/media\?u=https%3A%2F%2Fv\.redd\.it%2Fabc%2FHLS_AUDIO_64\.m3u8"/);
  assert.match(body, /^\/media\?u=https%3A%2F%2Fv\.redd\.it%2Fabc%2FHLS_720\.m3u8%3Fa%3D1$/m);
});
