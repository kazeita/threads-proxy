import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}.html`, import.meta.url), 'utf8');
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
    if (/cdninstagram|fbcdn/.test(u.hostname)) return new Response('IMG', { headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
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
  assert.match(await r.text(), /Read any Threads post/);
  assert.equal((await get('/healthz')).status, 200);
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
  assert.match(await home.text(), /Read any Threads post/);
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
