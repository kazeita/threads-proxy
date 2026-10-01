# threads·proxy

Read any public Threads post without logging in. Paste a link and get a clean page, JSON or Markdown. You get the full text, every image and video, the conversation above the post, the author's follow-ups, the first batch of replies (with their sub-replies), and exact engagement counts. Pages are server-rendered, so AI agents and `curl` see everything without running JavaScript.

## Deploy to Vercel

The app is a single serverless function. `vercel.json` rewrites every path to `api/index.js`, which calls the platform-neutral `handle(Request) → Response` in `src/handler.js`.

```bash
npm i -g vercel
vercel          # preview
vercel --prod
```

Or import the repo in the Vercel dashboard. No framework preset or build step is needed; `vercel.json` sets `"framework": null`.

## Run locally

```bash
npm install
npm start            # http://localhost:3000  (Node adapter in src/node-server.js)
npm test             # parser + route tests against trimmed real Threads responses
```

Node 20.18+ is required. Docker also works: `docker build -t threads-proxy . && docker run -p 3000:3000 threads-proxy`.

## Use it

| What | URL |
|---|---|
| Home (paste box) | `/` |
| View a post | `/view?url=https://www.threads.com/@user/post/CODE` |
| Mirror path (swap the domain) | `/@user/post/CODE` or `/t/CODE` |
| JSON | `/api/thread?url=…` or `?format=json` on any post path |
| Markdown | `/api/thread.md?url=…` or `?format=md` |
| Plain text | `/api/thread.txt?url=…` or `?format=text` |
| Agent instructions | `/llms.txt` |
| Media passthrough | `/media?u=<cdn url>` (Meta CDN hosts only) |

`url` accepts full links (threads.com or threads.net, with tracking params), `@user/post/CODE`, or a bare shortcode. Post paths also respond to `Accept: application/json` and `Accept: text/markdown`.

```bash
curl "https://your-app.vercel.app/api/thread.md?url=https://www.threads.com/@zuck/post/Ddt7cL5EfUG"
```

## How it works

1. **Post page JSON (primary).** It fetches `threads.com/@user/post/CODE` with a browser-style `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,…` header. With that header, Threads inlines its Relay data, and no cookies or login are needed. The handler reads:
   - `result.data.media`: the post (exact counts, full-res carousel images and videos, text fragments with mentions and links, quotes, link previews)
   - `text_post_app_info.containing_thread`: the posts above it
   - `text_post_app_info.self_thread`: the author's follow-ups
   - `text_post_app_info.direct_replies`: the first page of replies, each with its sub-replies
2. **Embed page (fallback).** `threads.com/t/CODE/embed` gives the post and its parents with rounded counts, but no replies.
3. **Open Graph tags (last resort).** Text and one image only.
4. **Media.** Meta's CDN blocks cross-site embedding, so images and videos go through `/media`. It streams with Range support and only allows `*.cdninstagram.com` and `*.fbcdn.net`. Only `www.threads.com` is ever fetched for posts, so this isn't an open proxy.
5. **Caching.** Responses send `s-maxage` (5 min for posts, 1 day for media), so Vercel's CDN absorbs repeat traffic. Each warm instance also has a small in-memory cache and a best-effort per-IP rate limit.

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | (from request) | Force the origin used in absolute `proxyUrl`s |
| `CACHE_TTL_SECONDS` | `300` | CDN + in-memory cache for posts |
| `RATE_LIMIT_PER_MIN` | `60` | Per IP, per instance; `0` disables |
| `TRUST_PROXY` | auto on Vercel | `1` to honour `X-Forwarded-*` when self-hosting behind a proxy |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Local server only |

## Limitations

- Public posts only.
- **Replies:** you get only the first batch that Threads shows logged-out visitors (typically 10–20 top-level replies plus some sub-replies). Threads requires login for the rest. To go deeper, open any reply; its page lists that reply's own replies.
- Threads may serve datacenter IPs (Vercel included) differently from home connections. If the post page comes back without data, the response falls back to the embed (`source: "embed"`: no replies, rounded counts) and includes a `note` saying why.
- Large videos are streamed through the function. Each request is a byte range, but very long videos still count against Vercel's bandwidth and function duration.
- CDN URLs are signed and expire after a few days. Re-request the post for fresh ones.
- Parsing depends on Threads' internal page structure. If it changes, update `src/threads.js` and the fixtures in `test/fixtures/`.

Not affiliated with Threads or Meta.
