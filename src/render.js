// HTML and Markdown output. Everything is server-rendered so a plain HTTP fetch
// (curl, an AI agent's browse tool) sees the full post without running JS.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = new Intl.NumberFormat('en-US');

export function mediaProxy(url) {
  return url ? `/media?u=${encodeURIComponent(url)}` : '';
}

const isReddit = (x) => x?.platform === 'reddit';
const siteName = (x) => (isReddit(x) ? 'Reddit' : 'Threads');
/** "@zuck" on Threads, "u/spez" on Reddit. */
function userLabel(p) {
  const n = p?.author?.username || 'unknown';
  return isReddit(p) ? (n === '[deleted]' ? n : `u/${n}`) : `@${n}`;
}
const replyLabel = (p, name) => (isReddit(p) ? (name === '[deleted]' ? name : `u/${name}`) : `@${name}`);
const postPath = (p) => p?.proxyPath || (p?.code ? `/t/${p.code}` : null);

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' UTC';
}

// ---------------------------------------------------------------------------
// Layout

const CSS = `
:root{
  --bg:#f4f1ea;--card:#fffdf8;--ink:#1b1a17;--muted:#6d685f;--line:#e3ddd1;--accent:#2d5b4e;--accent-ink:#fff;
  --soft:#ece7dc;--danger:#9a3a2a;
  --serif:Charter,"Bitstream Charter","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#121211;--card:#1a1918;--ink:#ebe7df;--muted:#9b968c;--line:#2d2b28;--accent:#8cc2ad;--accent-ink:#0f1a16;--soft:#232220;--danger:#e08a78;}}
:root[data-theme=dark]{--bg:#121211;--card:#1a1918;--ink:#ebe7df;--muted:#9b968c;--line:#2d2b28;--accent:#8cc2ad;--accent-ink:#0f1a16;--soft:#232220;--danger:#e08a78;}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
a{color:var(--accent)}
.wrap{max-width:680px;margin:0 auto;padding:0 16px}
.top{border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:5}
.top .wrap{display:flex;gap:16px;align-items:center;padding-top:12px;padding-bottom:12px}
.mark{font:600 15px/1 var(--mono);color:var(--ink);text-decoration:none;white-space:nowrap;letter-spacing:-.02em}
.mark b{color:var(--accent);font-weight:600}
form.bar{flex:1;display:flex;min-width:0}
.bar input{flex:1;min-width:0;font:14px var(--mono);padding:9px 12px;border:1px solid var(--line);border-right:0;border-radius:8px 0 0 8px;background:var(--card);color:var(--ink)}
.bar input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.bar button{font:600 14px var(--sans);padding:0 16px;border:0;border-radius:0 8px 8px 0;background:var(--accent);color:var(--accent-ink);cursor:pointer}
main{padding:28px 0 64px}
.hero{padding:56px 0 24px}
.hero h1{font:400 clamp(30px,6vw,44px)/1.1 var(--serif);margin:0 0 14px;letter-spacing:-.01em}
.hero p{color:var(--muted);margin:0 0 28px;max-width:52ch}
.hero form.bar input{font-size:16px;padding:14px 16px}
.hero form.bar button{padding:0 22px;font-size:15px}
.hint{font:13px var(--mono);color:var(--muted);margin-top:10px}
.agents{margin-top:48px;border-top:1px solid var(--line);padding-top:24px}
.agents h2{font:600 13px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
pre{font:13px/1.6 var(--mono);background:var(--soft);padding:14px 16px;border-radius:8px;overflow-x:auto;margin:0 0 12px}
.post{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 20px 16px}
.chain .post{border-radius:14px 14px 14px 14px;margin-bottom:0;opacity:.92}
.chain .link{width:2px;height:18px;background:var(--line);margin-left:38px}
.who{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.who img{width:38px;height:38px;border-radius:50%;background:var(--soft);flex:none;object-fit:cover}
.who .name{font-weight:600;color:var(--ink);text-decoration:none}
.who .name:hover{text-decoration:underline}
.tick{display:inline-block;width:15px;height:15px;vertical-align:-2px;margin-left:3px;color:var(--accent)}
.who .meta{font:12.5px var(--mono);color:var(--muted)}
.replying{font:12.5px var(--mono);color:var(--muted);margin:-6px 0 10px}
.body{font:19px/1.55 var(--serif);white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 4px}
.chain .body{font-size:17px}
.media{margin:16px 0 0;display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 0 6px;scrollbar-width:thin}
.mcount{font:12px var(--mono);color:var(--muted);margin-top:6px}
.media .m{flex:none;scroll-snap-align:start;border-radius:10px;overflow:hidden;background:var(--soft);height:360px;max-width:85%}
.media.one .m{height:auto;max-width:100%;width:100%}
.media img,.media video{display:block;height:100%;width:auto;max-width:100%;object-fit:cover}
.media.one img,.media.one video{width:100%;height:auto;max-height:640px;object-fit:contain}
.stats{display:flex;flex-wrap:wrap;gap:4px 18px;font:13px var(--mono);color:var(--muted);margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.stats b{color:var(--ink);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.btn{font:13px var(--mono);padding:7px 12px;border:1px solid var(--line);border-radius:8px;color:var(--ink);text-decoration:none;background:var(--card);cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.note{font:13px var(--mono);color:var(--muted);margin-top:18px}
.err{border-left:3px solid var(--danger);padding:12px 16px;background:var(--card);border-radius:0 8px 8px 0}
.err h1{font:400 26px var(--serif);margin:0 0 6px}
.who .full{font-weight:400;color:var(--muted);margin-left:6px}
.quote{display:block;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:14px;color:inherit;text-decoration:none;background:var(--bg)}
.quote:hover{border-color:var(--accent)}
.quote .qwho{font:600 14px var(--sans)}
.quote .qwho span{font:12px var(--mono);color:var(--muted);font-weight:400;margin-left:6px}
.quote .qtext{font:16px/1.5 var(--serif);white-space:pre-wrap;margin-top:4px;overflow-wrap:anywhere}
.quote .media .m{height:200px}
.preview{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:14px;text-decoration:none;color:inherit}
.preview img{width:96px;height:96px;object-fit:cover;flex:none;background:var(--soft)}
.preview div{padding:10px 12px 10px 0;min-width:0}
.preview b{display:block;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview span{font:12px var(--mono);color:var(--muted)}
.section{margin-top:36px}
.section h2{font:600 12.5px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.section h2 span{text-transform:none;letter-spacing:0;font-weight:400}
.rthread{border-top:1px solid var(--line);padding:16px 0 4px}
.rthread:first-of-type{border-top:0;padding-top:4px}
.rpost{display:grid;grid-template-columns:32px 1fr;gap:0 12px;position:relative}
.rpost+.rpost{margin-top:14px}
.rpost+.rpost::before{content:"";position:absolute;left:15px;top:-14px;height:14px;width:2px;background:var(--line)}
.rpost img.av{width:32px;height:32px;border-radius:50%;background:var(--soft);object-fit:cover}
.rhead{font-size:14px;display:flex;flex-wrap:wrap;gap:0 8px;align-items:baseline}
.rhead a.name{font-weight:600;color:var(--ink);text-decoration:none}
.rhead .meta{font:12px var(--mono);color:var(--muted)}
.rhead .meta a{color:var(--muted)}
.rbody{font:16.5px/1.5 var(--serif);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px}
.rstats{font:12px var(--mono);color:var(--muted);margin-top:6px;display:flex;gap:14px;flex-wrap:wrap}
.rstats a{color:var(--muted)}
.rpost .media{margin-top:8px}
.rpost .media .m{height:220px}
.more{font:13px var(--mono);color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:12px 14px;margin-top:16px}
.title{font:600 23px/1.3 var(--sans);margin:0 0 10px;letter-spacing:-.01em;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.chip{font:12px var(--mono);border:1px solid var(--line);border-radius:999px;padding:1px 9px;color:var(--muted);background:var(--soft)}
.chip.warn{color:var(--danger);border-color:var(--danger);background:transparent}
.badge{font:600 10.5px var(--mono);padding:1px 5px;border-radius:4px;background:var(--accent);color:var(--accent-ink);letter-spacing:.03em}
.poll{margin-top:14px;border:1px solid var(--line);border-radius:12px;padding:10px 14px;font-size:15px}
.poll div{display:flex;justify-content:space-between;gap:12px;padding:4px 0}
.poll span{font:13px var(--mono);color:var(--muted)}
.cthread{padding:14px 0 2px;border-top:1px solid var(--line)}
.cthread:first-of-type{border-top:0;padding-top:4px}
.cpost{margin-left:calc(min(var(--d),6) * 14px);padding-left:0}
.cpost.nested{border-left:2px solid var(--line);padding-left:12px}
.cpost+.cpost{margin-top:12px}
.cpost .rhead .flair{font:11.5px var(--mono);color:var(--muted);background:var(--soft);border-radius:4px;padding:0 5px}
.cpost .media .m{height:220px}
footer.site{border-top:1px solid var(--line);font:12.5px var(--mono);color:var(--muted);padding:18px 0 40px}
footer.site a{color:var(--muted)}
@media (max-width:520px){
  .top .wrap{flex-wrap:wrap}
  .post{padding:16px 16px 14px;border-radius:12px}
  .media .m{height:300px}
  .body{font-size:18px}
  .chain .link{margin-left:34px}
}`;

const TICK = `<svg class="tick" viewBox="0 0 24 24" aria-label="Verified" role="img"><path fill="currentColor" d="M12 1.5l2.6 1.9 3.2-.2.9 3.1 2.7 1.8-1 3.1 1 3.1-2.7 1.8-.9 3.1-3.2-.2L12 22.5l-2.6-1.9-3.2.2-.9-3.1-2.7-1.8 1-3.1-1-3.1 2.7-1.8.9-3.1 3.2.2z"/><path fill="none" stroke="var(--card)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M7.8 12.3l2.8 2.8 5.6-6"/></svg>`;

function layout({ title, description = '', head = '', body, query = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2d5b4e"/><text x="16" y="23" font-family="monospace" font-size="20" font-weight="700" fill="#fff" text-anchor="middle">@</text></svg>')}">
${head}
<style>${CSS}</style>
</head>
<body>
<div class="top"><div class="wrap">
  <a class="mark" href="/">threads<b>·</b>proxy</a>
  <form class="bar" action="/view" method="get" role="search">
    <input name="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Paste a Threads or Reddit link" value="${esc(query)}" aria-label="Threads or Reddit link">
    <button type="submit">Read</button>
  </form>
</div></div>
<main><div class="wrap">
${body}
</div></main>
<footer class="site"><div class="wrap">Not affiliated with Threads, Meta or Reddit. Public posts only · <a href="/llms.txt">API for AI agents</a></div></footer>
<script>
document.querySelectorAll('form.bar input').forEach(function(i){i.addEventListener('paste',function(){var f=i.form;setTimeout(function(){if(/threads\\.(com|net)\\/|reddit\\.com\\/|redd\\.it\\/|^@?[\\w.]+\\/post\\//i.test(i.value.trim()))f.submit()},0)})});
// Reddit video: the MP4 has no sound, the HLS stream does. Use native HLS, else load hls.js.
(function(){var vs=document.querySelectorAll('video[data-hls]');if(!vs.length)return;if(vs[0].canPlayType('application/vnd.apple.mpegurl')){vs.forEach(function(v){v.src=v.getAttribute('data-hls')});return}var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';s.onload=function(){if(!window.Hls||!Hls.isSupported())return;vs.forEach(function(v){var h=new Hls({autoStartLoad:false});h.loadSource(v.getAttribute('data-hls'));h.attachMedia(v);v.addEventListener('play',function(){h.startLoad()},{once:true})})};document.head.appendChild(s)})();
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));if(!t)return;navigator.clipboard.writeText(t.textContent).then(function(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1400)})})});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Pages

export function renderHome({ origin }) {
  const body = `
<section class="hero">
  <h1>Read any Threads or Reddit post,<br>no login wall.</h1>
  <p>Paste a link to a public post. You get the full text, every image and video, the conversation above it and the replies below — as a clean page, JSON, or Markdown.</p>
  <form class="bar" action="/view" method="get">
    <input name="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" autofocus placeholder="https://www.threads.com/@user/post/… or https://www.reddit.com/r/…" aria-label="Threads or Reddit link">
    <button type="submit">Read</button>
  </form>
  <div class="hint">Tip: swap <b>threads.com</b> or <b>reddit.com</b> for <b>${esc(new URL(origin).host)}</b> in any post URL.</div>
</section>
<section class="agents">
  <h2>For AI agents &amp; scripts</h2>
<pre>GET ${esc(origin)}/t/CODE.md                       → Threads post, Markdown
GET ${esc(origin)}/r/SUB/comments/ID.md            → Reddit post, Markdown
GET ${esc(origin)}/r/SUB/comments/ID.json          → JSON (same for /t/CODE.json)
GET ${esc(origin)}/fetch.md/&lt;threads or reddit link&gt; → Markdown, any link form</pre>
  <div class="hint">Media URLs in responses include a <code>proxyUrl</code> that works without hotlink restrictions. Full notes at <a href="/llms.txt">/llms.txt</a>.</div>
</section>`;
  return layout({
    title: 'threads·proxy — read Threads and Reddit posts without logging in',
    description: 'Paste a Threads or Reddit link to read the post as clean HTML, JSON or Markdown.',
    body,
  });
}

function renderSegments(segments) {
  return segments
    .map((s) => {
      if (s.type !== 'link') return esc(s.text);
      const local = s.kind === 'post' && (s.proxyPath || (s.code ? `/t/${s.code}` : null));
      if (local) return `<a href="${esc(local)}">${esc(s.text)}</a>`;
      const label = s.kind === 'url' && /…$/.test(s.text) ? s.href.replace(/^https?:\/\/(www\.)?/, '') : s.text;
      return `<a href="${esc(s.href)}" rel="nofollow noopener noreferrer" target="_blank">${esc(label)}</a>`;
    })
    .join('');
}

function renderMedia(media) {
  if (!media?.length) return '';
  const items = media
    .map((m, i) => {
      const src = esc(mediaProxy(m.url));
      if (m.type === 'video') {
        const poster = m.poster ? ` poster="${esc(mediaProxy(m.poster))}"` : '';
        const hls = m.hlsUrl ? ` data-hls="${esc(mediaProxy(m.hlsUrl))}"` : '';
        const play = m.gif ? 'autoplay loop muted playsinline' : 'controls playsinline preload="none"';
        return `<div class="m"><video src="${src}"${hls}${poster} ${play} aria-label="Video ${i + 1} of ${media.length}"></video></div>`;
      }
      return `<a class="m" href="${src}" target="_blank" rel="noopener"><img src="${src}" loading="lazy" alt="${esc(m.alt || `Image ${i + 1} of ${media.length}`)}"></a>`;
    })
    .join('');
  if (media.length === 1) return `<div class="media one">${items}</div>`;
  const imgs = media.filter((m) => m.type === 'image').length;
  const vids = media.length - imgs;
  const parts = [imgs && `${imgs} image${imgs > 1 ? 's' : ''}`, vids && `${vids} video${vids > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  return `<div class="media">${items}</div><div class="mcount">${parts} · scroll sideways →</div>`;
}

function renderExtras(post) {
  let out = '';
  if (post.linkPreview) {
    const lp = post.linkPreview;
    let host = lp.displayUrl;
    try {
      host ||= new URL(lp.url).host;
    } catch {
      /* keep */
    }
    out += `<a class="preview" href="${esc(lp.url)}" target="_blank" rel="nofollow noopener noreferrer">${lp.image ? `<img src="${esc(mediaProxy(lp.image))}" alt="" loading="lazy">` : ''}<div><b>${esc(lp.title || lp.displayUrl || lp.url)}</b><span>${esc(host || '')}</span></div></a>`;
  }
  if (post.poll) {
    const pl = post.poll;
    out += `<div class="poll">${pl.options.map((o) => `<div>${esc(o.text)}${o.votes != null ? `<span>${nf.format(o.votes)}</span>` : ''}</div>`).join('')}${pl.totalVotes != null ? `<span>${nf.format(pl.totalVotes)} votes</span>` : ''}</div>`;
  }
  for (const [q, label] of [[post.quote, ''], [post.repostOf, isReddit(post) ? 'Crossposted · ' : 'Reposted · ']]) {
    if (!q) continue;
    const who = isReddit(q) && q.community ? `${q.community.name} · ${userLabel(q)}` : userLabel(q);
    const title = q.title ? `<div class="qtext"><b>${esc(q.title)}</b></div>` : '';
    out += `<a class="quote" href="${esc(postPath(q) || q.url || '#')}"><div class="qwho">${esc(label)}${esc(who)}${q.author?.verified ? TICK : ''}<span>${esc(fmtDate(q.createdAt))}</span></div>${title}${q.text ? `<div class="qtext">${esc(q.text.length > 500 ? q.text.slice(0, 500) + '…' : q.text)}</div>` : ''}${renderMedia(q.media)}${renderExtras({ ...q, repostOf: null, quote: null })}</a>`;
  }
  return out;
}

const STAT_LABELS = {
  threads: [['likes', 'likes'], ['replies', 'replies'], ['reposts', 'reposts'], ['quotes', 'quotes'], ['shares', 'shares']],
  redditPost: [['score', 'points'], ['upvoteRatio', 'upvoted'], ['comments', 'comments'], ['crossposts', 'crossposts']],
  redditComment: [['score', 'points'], ['replies', 'replies']],
};
const statLabels = (p) => (isReddit(p) ? (p.kind === 'comment' ? STAT_LABELS.redditComment : STAT_LABELS.redditPost) : STAT_LABELS.threads);

function statsLine(post) {
  if (!post.stats) return '';
  const d = post.statsDisplay;
  const items = statLabels(post).map(([k, l]) => [d[k], l]).filter(([v]) => v != null);
  return `<div class="stats">${items.map(([v, l]) => `<span><b>${esc(v)}</b> ${l}</span>`).join('')}</div>`;
}

function redditChips(post) {
  const f = post.flags || {};
  const chips = [
    post.flair && [post.flair, ''],
    f.nsfw && ['NSFW', 'warn'],
    f.spoiler && ['Spoiler', 'warn'],
    f.pinned && ['Pinned', ''],
    f.locked && ['Locked', ''],
    f.archived && ['Archived', ''],
    f.removed && [`Removed (${f.removed})`, 'warn'],
    post.editedAt && [`Edited ${fmtDate(post.editedAt)}`, ''],
  ].filter(Boolean);
  return chips.length ? `<div class="chips">${chips.map(([t, c]) => `<span class="chip${c ? ` ${c}` : ''}">${esc(t)}</span>`).join('')}</div>` : '';
}

function renderPost(post, { id } = {}) {
  const u = post.author || {};
  const when = post.createdAt
    ? `<time datetime="${esc(post.createdAt)}" title="${esc(post.createdAt)}">${esc(fmtDate(post.createdAt))}</time>`
    : esc(post.displayTime || '');
  const path = postPath(post);
  const link = path && !id ? ` · <a href="${esc(path)}" style="color:inherit">open</a>` : '';
  let header;
  if (isReddit(post) && post.kind === 'post') {
    // Reddit posts: the subreddit leads, the author goes in the meta line.
    const c = post.community;
    const icon = c?.icon ? `<img src="${esc(mediaProxy(c.icon))}" alt="" loading="lazy">` : '<img alt="">';
    const by = u.profileUrl ? `<a href="${esc(u.profileUrl)}" target="_blank" rel="noopener" style="color:inherit">${esc(userLabel(post))}</a>` : esc(userLabel(post));
    header = `${icon}<div>${c ? `<a class="name" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : ''}<div class="meta">${by} · ${when}${link}</div></div>`;
  } else {
    const avatar = u.avatar ? `<img src="${esc(mediaProxy(u.avatar))}" alt="" loading="lazy">` : '<img alt="">';
    const badges = isReddit(post)
      ? `${post.isOp ? ' <span class="badge">OP</span>' : ''}${post.distinguished === 'moderator' ? ' <span class="badge">MOD</span>' : ''}${u.flair ? `<span class="full">${esc(u.flair)}</span>` : ''}`
      : `${u.verified ? TICK : ''}${u.fullName ? `<span class="full">${esc(u.fullName)}</span>` : ''}`;
    header = `${avatar}<div><a class="name" href="${esc(u.profileUrl || '#')}" target="_blank" rel="noopener">${esc(userLabel(post))}</a>${badges}<div class="meta">${when}${link}</div></div>`;
  }
  return `<article class="post"${id ? ` aria-labelledby="${id}-who"` : ''}>
  <header class="who"${id ? ` id="${id}-who"` : ''}>${header}</header>
  ${post.replyingTo ? `<div class="replying">Replying to ${esc(replyLabel(post, post.replyingTo))}</div>` : ''}
  ${post.title ? `<h1 class="title">${esc(post.title)}</h1>` : ''}
  ${isReddit(post) ? redditChips(post) : ''}
  ${post.text ? `<div class="body"${id ? ` id="${id}-text"` : ''}>${renderSegments(post.segments?.length ? post.segments : [{ type: 'text', text: post.text }])}</div>` : ''}
  ${renderMedia(post.media)}
  ${renderExtras(post)}
  ${statsLine(post)}
</article>`;
}

function renderReply(p) {
  if (isReddit(p)) return renderComment(p);
  const u = p.author || {};
  const s = p.stats || {};
  const bits = [];
  const pl = (n, d, w) => `${esc(d)} ${w}${n === 1 ? '' : w === 'reply' ? '' : 's'}`.replace(/reply$/, n === 1 ? 'reply' : 'replies');
  if (s.likes) bits.push(pl(s.likes, p.statsDisplay.likes, 'like'));
  if (s.replies) bits.push(p.code ? `<a href="/t/${esc(p.code)}">${pl(s.replies, p.statsDisplay.replies, 'reply')} →</a>` : pl(s.replies, p.statsDisplay.replies, 'reply'));
  if (s.reposts) bits.push(pl(s.reposts, p.statsDisplay.reposts, 'repost'));
  return `<div class="rpost">
  ${u.avatar ? `<img class="av" src="${esc(mediaProxy(u.avatar))}" alt="" loading="lazy">` : '<img class="av" alt="">'}
  <div>
    <div class="rhead"><a class="name" href="${esc(u.profileUrl || '#')}" target="_blank" rel="noopener">@${esc(u.username || 'unknown')}</a>${u.verified ? TICK : ''}<span class="meta">${p.code ? `<a href="/t/${esc(p.code)}">` : ''}${esc(fmtDate(p.createdAt))}${p.code ? '</a>' : ''}</span></div>
    ${p.text ? `<div class="rbody">${renderSegments(p.segments)}</div>` : ''}
    ${renderMedia(p.media)}
    ${renderExtras(p)}
    ${bits.length ? `<div class="rstats">${bits.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
  </div>
</div>`;
}

/** A Reddit comment, indented by its depth in the tree. */
function renderComment(p) {
  const u = p.author || {};
  const s = p.stats || {};
  const path = postPath(p);
  const name = u.profileUrl
    ? `<a class="name" href="${esc(u.profileUrl)}" target="_blank" rel="noopener">${esc(userLabel(p))}</a>`
    : `<span class="name">${esc(userLabel(p))}</span>`;
  const badges = `${p.isOp ? '<span class="badge">OP</span>' : ''}${p.distinguished === 'moderator' ? '<span class="badge">MOD</span>' : ''}${p.pinned ? '<span class="badge">PINNED</span>' : ''}${u.flair ? `<span class="flair">${esc(u.flair)}</span>` : ''}`;
  const time = `${path ? `<a href="${esc(path)}">` : ''}${esc(fmtDate(p.createdAt))}${path ? '</a>' : ''}${p.editedAt ? ' · edited' : ''}`;
  const bits = [];
  bits.push(s.score == null ? 'score hidden' : `${esc(p.statsDisplay.score)} point${s.score === 1 ? '' : 's'}`);
  if (p.moreReplies && path) bits.push(`<a href="${esc(path)}">+${nf.format(p.moreReplies)} more repl${p.moreReplies === 1 ? 'y' : 'ies'} →</a>`);
  else if (p.continueThread && path) bits.push(`<a href="${esc(path)}">Continue this thread →</a>`);
  return `<div class="cpost${p.depth ? ' nested' : ''}" style="--d:${Number(p.depth) || 0}">
  <div class="rhead">${name}${badges}<span class="meta">${time}</span></div>
  ${p.text ? `<div class="rbody">${renderSegments(p.segments?.length ? p.segments : [{ type: 'text', text: p.text }])}</div>` : ''}
  ${renderMedia(p.media)}
  <div class="rstats">${bits.map((b) => `<span>${b}</span>`).join('')}</div>
</div>`;
}

/** Direct replies vs. replies-to-replies. replyCount from Threads counts direct replies only. */
function replyTally(result) {
  const direct = result.replies?.length || 0;
  const all = (result.replies || []).reduce((n, t) => n + t.posts.length, 0);
  return { direct, nested: all - direct, all };
}

/** True when the source includes the replies (not the limited embed / preview). */
const hasReplyData = (result) => result.source === 'page' || result.source === 'api' || result.source === 'html';

function redditRepliesHeading(result) {
  const { all } = replyTally(result);
  const noun = result.post.kind === 'comment' ? 'Replies' : 'Comments';
  const total = result.replyCount;
  const label = all ? `showing ${nf.format(all)}${total && total >= all ? ` of ${nf.format(total)}` : ''}` : 'none yet';
  return { noun, label };
}

export function renderThread(result, { origin, query }) {
  const { post, context = [], selfThread = [], replies = [] } = result;
  const reddit = isReddit(result);
  const site = siteName(result);
  const firstImage = post.media.find((m) => m.type === 'image') || null;
  const chain = context.length
    ? `<div class="chain">${context.map((p) => renderPost(p) + '<div class="link"></div>').join('')}</div>`
    : '';
  const proxyPath = result.proxyPath || `/t/${encodeURIComponent(result.code)}`;
  const jsonUrl = `${proxyPath}.json`;
  const mdUrl = `${proxyPath}.md`;

  const self = selfThread.length
    ? `<section class="section"><h2>Continued by ${esc(userLabel(post))}</h2>${selfThread.map((p) => `<div class="rthread">${renderReply(p)}</div>`).join('')}</section>`
    : '';

  let repliesHtml = '';
  if (hasReplyData(result) && reddit) {
    const { noun, label } = redditRepliesHeading(result);
    const more = result.hasMoreReplies
      ? `<div class="more">Reddit sends the top comments first. Follow a “more replies” link to load deeper parts of the thread, or <a href="${esc(result.url)}" target="_blank" rel="noopener">view everything on Reddit ↗</a>.</div>`
      : '';
    repliesHtml = `<section class="section" id="replies"><h2>${noun} <span>${label}</span></h2>${replies.map((t) => `<div class="cthread">${t.posts.map(renderComment).join('')}</div>`).join('')}${more}</section>`;
  } else if (hasReplyData(result)) {
    const { direct, nested } = replyTally(result);
    const total = result.replyCount;
    const label = direct
      ? `showing ${direct}${total ? ` of ${nf.format(total)}` : ''}${nested ? ` · +${nested} nested` : ''}`
      : 'none yet';
    const head = `<h2>Replies <span>${label}</span></h2>`;
    const more = result.hasMoreReplies
      ? `<div class="more">Threads only shows this first batch of replies to logged-out visitors. Open a reply to see its own replies, or <a href="${esc(result.url)}" target="_blank" rel="noopener">view the rest on Threads ↗</a>.</div>`
      : '';
    repliesHtml = `<section class="section" id="replies">${head}${replies.map((t) => `<div class="rthread">${t.posts.map(renderReply).join('')}</div>`).join('')}${more}</section>`;
  } else if (post.stats?.replies || post.stats?.comments) {
    repliesHtml = `<section class="section"><h2>Replies</h2><div class="more">Replies couldn’t be loaded this time (${site} served a limited page). Try again in a moment.</div></section>`;
  }

  const limited =
    result.source === 'opengraph'
      ? `<div class="note">Limited view: ${site} didn't serve the full post, so only the preview text and image are shown.</div>`
      : result.source === 'html'
        ? '<div class="note">Read from Reddit’s web page because its API was unavailable: some counts and comments may be missing.</div>'
        : '';

  const body = `
${chain}
${renderPost(post, { id: 'p' })}
<div class="actions">
  <a class="btn" href="${esc(result.url)}" target="_blank" rel="noopener">Open on ${site} ↗</a>
  ${post.text ? '<button class="btn" type="button" data-copy="p-text">Copy text</button>' : ''}
  <a class="btn" href="${esc(mdUrl)}">Markdown</a>
  <a class="btn" href="${esc(jsonUrl)}">JSON</a>
</div>
${limited}
${self}
${repliesHtml}`;

  const clip = (t, n) => `“${t.slice(0, n)}${t.length > n ? '…' : ''}”`;
  let title;
  let ogTitle;
  if (reddit) {
    const sub = post.community?.name || result.context?.[0]?.community?.name || 'Reddit';
    const postTitle = post.title || result.context?.[0]?.title || '';
    title = post.kind === 'comment' ? `${userLabel(post)} comments on ${clip(postTitle, 60)} · ${sub}` : `${postTitle || 'Reddit post'} : ${sub}`;
    ogTitle = post.kind === 'comment' ? `${userLabel(post)} on ${sub}` : postTitle || sub;
  } else {
    title = `${userLabel(post)} on Threads${post.text ? `: ${clip(post.text, 60)}` : ''}`;
    ogTitle = `${userLabel(post)} on Threads`;
  }
  const desc = (post.text || post.title || '').slice(0, 300);
  const head = [
    `<link rel="canonical" href="${esc(origin + proxyPath)}">`,
    `<link rel="alternate" type="application/json" href="${esc(jsonUrl)}">`,
    `<link rel="alternate" type="text/markdown" href="${esc(mdUrl)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(origin + proxyPath)}">`,
    firstImage ? `<meta property="og:image" content="${esc(origin + mediaProxy(firstImage.url))}">` : '',
    `<meta name="twitter:card" content="${firstImage ? 'summary_large_image' : 'summary'}">`,
  ].join('\n');
  return layout({ title, description: desc, head, body, query: query || result.url });
}

export function renderError({ status, message, query }) {
  const heading =
    status === 404
      ? 'Post not found'
      : status === 400
        ? 'That doesn’t look like a Threads or Reddit link'
        : status === 429
          ? 'Slow down a little'
          : status === 403
            ? 'This post isn’t public'
            : 'Couldn’t load that post';
  const body = `<div class="err"><h1>${esc(heading)}</h1><div>${esc(message)}</div></div>
<div class="note">Links look like <code>https://www.threads.com/@user/post/ABC123xyz</code> or <code>https://www.reddit.com/r/sub/comments/abc123/title/</code>.</div>`;
  return layout({ title: `${heading} — threads·proxy`, body, query });
}

// ---------------------------------------------------------------------------
// Markdown / text for agents

function mdStats(p) {
  if (!p.stats) return '';
  const s = p.stats;
  if (isReddit(p)) {
    const parts = [`Score: ${s.score == null ? 'hidden' : nf.format(s.score)}`];
    if (p.kind === 'comment') {
      if (s.replies != null) parts.push(`Replies: ${nf.format(s.replies)}`);
    } else {
      if (s.upvoteRatio != null) parts.push(`Upvoted: ${Math.round(s.upvoteRatio * 100)}%`);
      parts.push(`Comments: ${nf.format(s.comments)}`, `Crossposts: ${nf.format(s.crossposts)}`);
    }
    return parts.join(' · ');
  }
  const parts = [`Likes: ${nf.format(s.likes)}`, `Replies: ${nf.format(s.replies)}`, `Reposts: ${nf.format(s.reposts)}`];
  if (s.quotes != null) parts.push(`Quotes: ${nf.format(s.quotes)}`);
  parts.push(`Shares: ${nf.format(s.shares)}`);
  return parts.join(' · ');
}

function mdMediaLines(p, origin) {
  return (p.media || []).map((m, i) => {
    if (m.type === 'image') return `${i + 1}. ![${m.alt ? m.alt.replace(/[\[\]\n]/g, ' ') : `Image ${i + 1}`}](${origin + mediaProxy(m.url)})`;
    const label = m.gif ? `GIF ${i + 1}` : `Video ${i + 1}`;
    const hls = m.hlsUrl && m.hlsUrl !== m.url ? ` (with sound, HLS: ${origin + mediaProxy(m.hlsUrl)})` : '';
    return `${i + 1}. [${label}](${origin + mediaProxy(m.url)})${hls}`;
  });
}

function mdPost(p, origin, heading) {
  const lines = [];
  const u = p.author || {};
  const reddit = isReddit(p);
  if (reddit && p.kind === 'post') lines.push(`${heading} ${p.title || '(untitled)'}`);
  else lines.push(`${heading} ${userLabel(p)}${u.verified ? ' ✓' : ''}${p.isOp ? ' (OP)' : ''}${u.fullName ? ` (${u.fullName})` : ''}`);
  const meta = [];
  if (reddit && p.kind === 'post') {
    meta.push(`Author: ${userLabel(p)}`);
    if (p.community) meta.push(`Subreddit: ${p.community.name}`);
    if (p.flair) meta.push(`Flair: ${p.flair}`);
    const f = p.flags || {};
    const flags = ['nsfw', 'spoiler', 'pinned', 'locked', 'archived'].filter((k) => f[k]);
    if (f.removed) flags.push(`removed (${f.removed})`);
    if (flags.length) meta.push(`Flags: ${flags.join(', ')}`);
  }
  if (p.createdAt) meta.push(`Posted: ${p.createdAt}`);
  if (p.editedAt) meta.push(`Edited: ${p.editedAt}`);
  if (p.replyingTo) meta.push(`Replying to: ${replyLabel(p, p.replyingTo)}`);
  if (p.stats) meta.push(mdStats(p));
  if (p.code) meta.push(`Link: ${p.url || `https://www.threads.com/t/${p.code}`}`);
  if (meta.length) lines.push('', ...meta.map((m) => `- ${m}`));
  if (p.text) lines.push('', p.text);
  if (p.media?.length) lines.push('', 'Media:', ...mdMediaLines(p, origin));
  if (p.poll) {
    lines.push('', `Poll${p.poll.totalVotes != null ? ` (${nf.format(p.poll.totalVotes)} votes)` : ''}:`, ...p.poll.options.map((o) => `- ${o.text}${o.votes != null ? `: ${nf.format(o.votes)}` : ''}`));
  }
  if (p.linkPreview) lines.push('', `Link preview: [${p.linkPreview.title || p.linkPreview.url}](${p.linkPreview.url})`);
  for (const [q, label] of [[p.quote, 'Quoting'], [p.repostOf, reddit ? 'Crossposted from' : 'Reposting']]) {
    if (!q) continue;
    const who = reddit && q.community ? `${q.community.name} by ${userLabel(q)}` : userLabel(q);
    lines.push('', `> ${label} ${who}${q.url ? ` (${q.url})` : ''}:`);
    if (q.title) lines.push(`> **${q.title}**`);
    lines.push(...(q.text || '').split('\n').map((l) => `> ${l}`));
    if (q.media?.length) lines.push('', 'Media:', ...mdMediaLines(q, origin));
  }
  const links = (p.segments || []).filter((s) => s.type === 'link' && s.kind === 'url');
  if (links.length) lines.push('', 'Links:', ...links.map((l) => `- ${l.href}`));
  return lines.join('\n');
}

function mdReply(p, depth, origin) {
  const u = p.author || {};
  const indent = '  '.repeat(depth);
  const s = p.stats || {};
  const reddit = isReddit(p);
  const counts = reddit
    ? [s.score == null ? 'score hidden' : `${nf.format(s.score)} points`, s.replies ? `${nf.format(s.replies)} replies` : null]
    : [s.likes ? `${nf.format(s.likes)} likes` : null, s.replies ? `${nf.format(s.replies)} replies` : null];
  const meta = [p.createdAt ? p.createdAt.slice(0, 16).replace('T', ' ') + ' UTC' : null, ...counts].filter(Boolean).join(' · ');
  const link = reddit ? (p.proxyPath ? ` [link](${origin}${p.proxyPath}.md)` : '') : p.code ? ` [link](https://www.threads.com/t/${p.code})` : '';
  const head = `${indent}- **${userLabel(p)}**${u.verified ? ' ✓' : ''}${p.isOp ? ' (OP)' : ''}${p.distinguished === 'moderator' ? ' (mod)' : ''} (${meta})${link}`;
  const body = (p.text || '').split('\n').map((l) => `${indent}  ${l}`);
  const extra = [];
  if (p.media?.length) extra.push(`${indent}  [${p.media.length} media item${p.media.length > 1 ? 's' : ''}]`);
  if (p.quote) extra.push(`${indent}  > Quoting ${userLabel(p.quote)}: ${(p.quote.text || '').replace(/\n/g, ' ').slice(0, 200)}`);
  if (p.moreReplies && p.proxyPath) extra.push(`${indent}  _+${nf.format(p.moreReplies)} more replies: ${origin}${p.proxyPath}.md_`);
  else if (p.continueThread && p.proxyPath) extra.push(`${indent}  _Thread continues: ${origin}${p.proxyPath}.md_`);
  return [head, ...body, ...extra].join('\n');
}

export function renderMarkdown(result, { origin }) {
  const out = [];
  const { post } = result;
  const reddit = isReddit(result);
  const sub = post.community?.name || result.context?.[0]?.community?.name;
  if (reddit) out.push(post.kind === 'comment' ? `# Reddit comment by ${userLabel(post)}${sub ? ` in ${sub}` : ''}` : `# Reddit post${sub ? ` in ${sub}` : ''} by ${userLabel(post)}`, '');
  else out.push(`# Threads post by ${userLabel(post)}`, '');
  out.push(`Source: ${result.url}`);
  out.push(`Proxy: ${origin}${result.proxyPath || `/t/${result.code}`}`);
  out.push('');
  if (result.context?.length) {
    out.push('## In reply to', '');
    result.context.forEach((p) => out.push(mdPost(p, origin, '###'), ''));
    out.push(reddit ? '## Comment' : '## Post', '');
  }
  out.push(mdPost(post, origin, result.context?.length ? '###' : '##'));
  if (result.selfThread?.length) {
    out.push('', `## Continued by ${userLabel(post)}`, '');
    result.selfThread.forEach((p) => out.push(mdReply(p, 0, origin)));
  }
  if (hasReplyData(result) && reddit) {
    const { noun } = redditRepliesHeading(result);
    const { all } = replyTally(result);
    const total = result.replyCount;
    out.push('', `## ${noun} (${nf.format(all)}${total && total >= all ? ` of ${nf.format(total)}` : ''} shown)`, '');
    if (!all) out.push(`_No ${noun.toLowerCase()} yet._`);
    result.replies.forEach((t) => t.posts.forEach((p) => out.push(mdReply(p, p.depth ?? 0, origin))));
    if (result.hasMoreReplies) {
      out.push('', `_More ${noun.toLowerCase()} exist. Fetch a comment's [link] (${origin}/r/{sub}/comments/{id}/_/{comment}.md) to load its replies._`);
    }
  } else if (hasReplyData(result)) {
    const { direct, nested } = replyTally(result);
    out.push(
      '',
      `## Replies (${direct}${result.replyCount ? ` of ${nf.format(result.replyCount)}` : ''} direct replies shown${nested ? `, plus ${nested} nested` : ''})`,
      '',
    );
    if (!direct) out.push('_No replies yet._');
    result.replies.forEach((t) => {
      t.posts.forEach((p, i) => out.push(mdReply(p, i, origin)));
    });
    if (result.hasMoreReplies) {
      out.push('', `_More replies exist but Threads only serves the first batch without login. Fetch ${origin}/t/{code}.md for a reply's own sub-thread._`);
    }
  } else if (post.stats?.replies || post.stats?.comments) {
    out.push('', '_Replies unavailable (limited source)._');
  }
  if (result.source === 'opengraph') out.push('', '_Note: limited data (Open Graph preview only)._');
  if (result.source === 'html') out.push('', '_Note: read from the web page because the API was unavailable; some counts and comments may be missing._');
  return out.join('\n') + '\n';
}

export function renderText(result) {
  const parts = [];
  for (const p of [...(result.context || []), result.post, ...(result.selfThread || [])]) {
    const title = p.title ? `${p.title}\n` : '';
    parts.push(`${title}${userLabel(p)}${p.createdAt ? ` (${p.createdAt})` : ''}:\n${p.text || ''}`);
  }
  let txt = parts.join('\n\n---\n\n') + '\n';
  if (result.replies?.length) {
    txt += `\n=== ${isReddit(result) && result.post.kind !== 'comment' ? 'Comments' : 'Replies'} ===\n`;
    for (const t of result.replies) {
      t.posts.forEach((p, i) => {
        const pad = '  '.repeat(p.depth ?? i);
        txt += `\n${pad}${userLabel(p)}: ${(p.text || '').replace(/\n/g, '\n' + pad)}\n`;
      });
    }
  }
  return txt;
}

export function renderLlmsTxt({ origin }) {
  return `# threads·proxy

> Read public Threads (threads.com / threads.net) and Reddit posts without logging in. Returns full post text, author, timestamps, exact engagement counts, all images and videos, the post(s) it replies to, the author's follow-up posts (Threads), and the replies or comment tree.

## Endpoints

Prefer these query-free forms. Some fetch tools drop query strings, which breaks \`?url=\` and \`?format=\`.

Threads:
- GET ${origin}/t/{code}.md : Markdown (best for reading). {code} is the part after /post/ in a Threads link.
- GET ${origin}/t/{code}.json : JSON
- GET ${origin}/t/{code}.txt : plain text
- GET ${origin}/t/{code} : HTML page
- GET ${origin}/@{user}/post/{code}.md : same, mirroring threads.com paths (.json / .txt work too)

Reddit (swap reddit.com for this host in any post link):
- GET ${origin}/r/{sub}/comments/{id}.md : a post with its comment tree (.json / .txt / no extension for HTML)
- GET ${origin}/r/{sub}/comments/{id}/{slug}/{comment_id}.md : one comment, its parent chain and its replies
- GET ${origin}/comments/{id}.md, ${origin}/r/{sub}/s/{share_code}.md : also work

Any link form, either site:
- GET ${origin}/fetch.md/{link_or_code} : Markdown, e.g. ${origin}/fetch.md/https://www.threads.com/@zuck/post/Ddt7cL5EfUG or ${origin}/fetch.md/https://www.reddit.com/r/sub/comments/abc123/title/
- GET ${origin}/fetch/{link_or_code} : JSON (also /fetch.txt/…). A bare code means Threads.

Query forms also work when your tool keeps query strings: /fetch.md?url={url}, /fetch?url=…, /t/{code}?format=md|json|text.

- GET ${origin}/media?u={cdn_url} : fetches images/videos from Meta's CDN (cdninstagram.com, fbcdn.net) and Reddit's (i.redd.it, v.redd.it, preview.redd.it, redditmedia.com)

To read deeper into a conversation, fetch a reply's own page: Threads /t/{reply_code}.md, Reddit the comment's [link] in the Markdown (or its proxyPath in JSON).
Threads: "Replies (10 of 62 direct replies shown, plus 3 nested)": the 62 counts direct replies only; nested ones are replies to replies.
Reddit: "Comments (180 of 412 shown)": the 412 counts every comment. Comments with "+N more replies" have unloaded replies; fetch that comment's link.

## JSON shape

{
  "ok": true,
  "platform": "threads" | "reddit",
  "source": "page" | "embed" | "opengraph" (Threads) | "api" | "html" | "opengraph" (Reddit),
  "code": "Ddt7cL5EfUG",       // Threads shortcode, or the Reddit post/comment ID
  "url": "https://www.threads.com/@zuck/post/Ddt7cL5EfUG",
  "proxyPath": "/t/Ddt7cL5EfUG",
  "createdAt": "2026-09-25T16:50:21.000Z",
  "post": Post,
  "context": [Post],          // posts this one replies to, oldest first (Reddit: the post, then parent comments)
  "selfThread": [Post],       // the author's follow-up posts in the same thread (Threads only)
  "replies": [ { "posts": [Post, ...] } ],  // each item: a reply, then replies to it. Reddit posts carry "depth" (0 = top level)
  "replyCount": 496,          // Threads: direct replies. Reddit post: all comments. Reddit comment: direct replies
  "hasMoreReplies": true      // more exist than were returned
}

Post = {
  "code", "url", "createdAt",
  "author": { "username", "fullName", "profileUrl", "avatar", "avatarProxyUrl", "verified", "flair" },
  "text": "full text, links expanded (Reddit: the Markdown source)",
  "segments": [ { "type": "text" | "link", "kind": "url" | "mention" | "tag" | "post" | "community", "text", "href" } ],
  "media": [ { "type": "image" | "video", "url", "proxyUrl", "width", "height", "poster", "hlsUrl", "hlsProxyUrl", "gif" } ],
  "replyingTo": "username" | null,
  "quote": Post | null, "repostOf": Post | null,   // Reddit crossposts are repostOf
  "linkPreview": { "url", "title", "image" } | null,
  "stats": Threads { "likes", "replies", "reposts", "quotes", "shares" }
         | Reddit post { "score", "upvoteRatio", "comments", "crossposts" } | Reddit comment { "score", "replies" }
  Reddit only: "platform", "kind": "post" | "comment", "title", "community": { "name", "url", "icon" }, "flair",
               "flags": { "nsfw", "spoiler", "locked", "pinned", "archived", "removed" }, "poll", "editedAt",
               "isOp", "distinguished", "depth", "moreReplies", "continueThread", "proxyPath"
}

Reddit videos: "url" is an MP4 without sound; "hlsUrl" / "hlsProxyUrl" is the stream with sound.

## Errors

JSON errors are { "ok": false, "error": "...", "status": 400|403|404|429|502 }.

## Limits

- Public posts only.
- Threads replies: only the first batch Threads shows logged-out visitors (typically 10–20 top-level replies with some sub-replies).
- If Threads serves the limited embed instead of the full page, source is "embed": no replies, rounded counts.
- Reddit: up to 200 comments per request (in Reddit's suggested order); deeper ones need the comment's own link. Reddit's scores are slightly fuzzed by Reddit itself.
- CDN media URLs are signed and expire after a few days; refetch the post for fresh ones.
`;
}
