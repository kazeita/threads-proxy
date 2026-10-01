// Local / self-hosted Node server. On Vercel, api/index.js is used instead.
import http from 'node:http';
import { Readable } from 'node:stream';
import { handle } from './handler.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const request = new Request(`http://${req.headers.host || `localhost:${PORT}`}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      signal: ac.signal,
    });
    const response = await handle(request, { ip: req.socket.remoteAddress });
    const headers = {};
    response.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(response.status, headers);
    if (!response.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(response.body)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal error\n');
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`threads-proxy listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
