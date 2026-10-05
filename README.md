# threads·proxy

Read any public Threads or Reddit post without logging in. Paste a link and get a clean page, JSON or Markdown. You get the full text, every image and video, the conversation above the post, the replies below it (with their sub-replies), and exact engagement counts. On Threads you also get the author's follow-ups; on Reddit, the comment tree with scores, flairs and OP/mod markers. Pages are server-rendered, so AI agents and `curl` see everything without running JavaScript.

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
npm test             # parser + route tests against trimmed Threads responses and Reddit-format fixtures
```

Node 20.18+ is required. Docker also works: `docker build -t threads-proxy . && docker run -p 3000:3000 threads-proxy`.

## Use it

| What | URL |
|---|---|
| Home (paste box) | `/` |
| View a Threads post (HTML) | `/t/CODE` or `/@user/post/CODE` (swap the domain in any Threads link) |
| View a Reddit post (HTML) | `/r/SUB/comments/ID[/slug]`, `/comments/ID`, `/r/SUB/s/SHARE` (swap the domain in any Reddit link) |
| View a Reddit comment | `/r/SUB/comments/ID/slug/COMMENT` or `…/comment/COMMENT`: the comment, its parents and its replies |
| Markdown | `/t/CODE.md`, `/@user/post/CODE.md`, `/r/SUB/comments/ID.md`, `/fetch.md/<any link or code>` |
| JSON | `/t/CODE.json`, `/r/SUB/comments/ID.json`, `/fetch/<any link or code>` |
| Plain text | `/t/CODE.txt`, `/r/SUB/comments/ID.txt`, `/fetch.txt/<any link or code>` |
| Query forms | `/fetch.md?url=…`, `/fetch?url=…`, `?format=md\|json\|text`, `/view?url=…` |
| Agent instructions | `/llms.txt` |
| Media passthrough | `/media?u=<cdn url>` (Meta CDN and Reddit media hosts only) |

Prefer the query-free forms for AI agents. Some agent fetch tools (Claude.ai's included) drop query strings from URLs they build themselves, so `?url=` arrives empty and `?format=` is ignored.

`/api/thread…` still works as an alias for `/fetch…`. `url` accepts full links (threads.com or threads.net, with tracking params), `@user/post/CODE`, or a bare shortcode (which always means Threads). For Reddit it accepts www/old/new/np/m.reddit.com links, `redd.it/ID`, `/gallery/ID`, user-profile posts, `/r/SUB/s/…` share links and `r/SUB/comments/ID`. Post paths also respond to `Accept: application/json` and `Accept: text/markdown`.

```bash
curl "https://your-app.vercel.app/t/Ddt7cL5EfUG.md"
curl "https://your-app.vercel.app/r/webdev/comments/1fxk2ab.md"
```

## How it works

### Threads

1. **Post page JSON (primary).** It fetches `threads.com/@user/post/CODE` with a browser-style `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,…` header. With that header, Threads inlines its Relay data, and no cookies or login are needed. The handler reads:
   - `result.data.media`: the post (exact counts, full-res carousel images and videos, text fragments with mentions and links, quotes, link previews)
   - `text_post_app_info.containing_thread`: the posts above it
   - `text_post_app_info.self_thread`: the author's follow-ups
   - `text_post_app_info.direct_replies`: the first page of replies, each with its sub-replies
2. **Embed page (fallback).** `threads.com/t/CODE/embed` gives the post and its parents with rounded counts, but no replies.
3. **Open Graph tags (last resort).** Text and one image only.

### Reddit

1. **OAuth API (if configured).** With `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`, it gets an app-only token (`client_credentials`, no user login) and reads `oauth.reddit.com/comments/ID`. This is the reliable path on serverless hosts.
2. **Public JSON.** Otherwise it reads `www.reddit.com/comments/ID.json`, then `old.reddit.com`, with `raw_json=1` and up to 200 comments. For a comment link it adds `comment=ID&context=8`, so the response holds the parent chain and the comment's replies. Share links (`/r/SUB/s/…`) are resolved from their redirect first.
3. **HTML page (last resort).** The `<shreddit-post>` element, any server-rendered `<shreddit-comment>`s, then Open Graph tags (`source: "html"` / `"opengraph"`, with a `note`).
4. **What you get.** Title, Markdown body, subreddit, flair, NSFW/spoiler/locked/pinned flags, edit time, score, upvote ratio, comment and crosspost counts, galleries (in order, with captions), images, GIFs, `v.redd.it` video, link previews, polls and crossposts. Comments come as a tree (`depth` on each), with OP/mod/pinned markers, author flair, and links to load replies Reddit didn't include ("+N more replies", "Continue this thread").
5. **Video sound.** Reddit's MP4 (`url`) has no audio track. The HLS stream (`hlsUrl`) does, so `/media` rewrites HLS playlists to route their segments through itself, and the HTML page plays the stream natively or with hls.js.

### Both

1. **Media.** Meta's CDN blocks cross-site embedding, so images and videos go through `/media`. It streams with Range support and only allows `*.cdninstagram.com`, `*.fbcdn.net`, `*.redd.it`, `*.redditmedia.com` and `*.redditstatic.com`, including after redirects. Posts are only fetched from Threads and Reddit, so this isn't an open proxy.
2. **Caching.** Responses send `s-maxage` (5 min for posts, 1 day for media), so Vercel's CDN absorbs repeat traffic. Each warm instance also has a small in-memory cache and a best-effort per-IP rate limit.

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | (from request) | Force the origin used in absolute `proxyUrl`s |
| `CACHE_TTL_SECONDS` | `300` | CDN + in-memory cache for posts |
| `RATE_LIMIT_PER_MIN` | `60` | Per IP, per instance; `0` disables |
| `TRUST_PROXY` | auto on Vercel | `1` to honour `X-Forwarded-*` when self-hosting behind a proxy |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | (unset) | Reddit app credentials (create a "web app" or "script" at reddit.com/prefs/apps). Strongly recommended on Vercel: Reddit often blocks unauthenticated requests from datacenter IPs |
| `REDDIT_USER_AGENT` | `web:threads-proxy:1.0 (public post reader)` | Reddit asks for a unique, descriptive User-Agent; include your Reddit username |
| `REDDIT_COMMENT_LIMIT` | `200` | Comments requested per Reddit post |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Local server only |

## Limitations

- Public posts only.
- **Replies:** you get only the first batch that Threads shows logged-out visitors (typically 10–20 top-level replies plus some sub-replies). Threads requires login for the rest. To go deeper, open any reply; its page lists that reply's own replies.
- Threads may serve datacenter IPs (Vercel included) differently from home connections. If the post page comes back without data, the response falls back to the embed (`source: "embed"`: no replies, rounded counts) and includes a `note` saying why.
- **Reddit comments:** up to 200 per request, in Reddit's suggested order. Collapsed branches show "+N more replies" / "Continue this thread"; open that comment to load them. Reddit fuzzes scores slightly.
- **Reddit blocking:** without OAuth credentials, Reddit may refuse requests from cloud IPs. The response then falls back to the HTML page (`source: "html"`) or fails with a 502 that says which sources were tried.
- Private, quarantined and premium-only subreddits return 403.
- Large videos are streamed through the function. Each request is a byte range, but very long videos still count against Vercel's bandwidth and function duration.
- CDN URLs are signed and expire after a few days. Re-request the post for fresh ones.
- Parsing depends on Threads' internal page structure and Reddit's JSON format. If they change, update `src/threads.js` / `src/reddit.js` and the fixtures in `test/fixtures/`.

Not affiliated with Threads, Meta or Reddit.
