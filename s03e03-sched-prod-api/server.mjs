// Node host for the Worker in src/index.js (Railway). Same fetch handler, env from process.env.
import http from 'node:http';
import worker from './src/index.js';

const port = Number(process.env.PORT || 8080);
http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const request = new Request(url, { method: req.method, headers: req.headers, body });
    const response = await worker.fetch(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}).listen(port, () => console.log(`sched-prod-api on ${port}`));
