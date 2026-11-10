// Node wrapper: serves the same fetch handler that src/worker.js exports.
import http from 'node:http';
import worker from './src/worker.js';

const port = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  try {
    const request = new Request(`https://${req.headers.host || 'localhost'}${req.url}`, { method: req.method });
    const out = await worker.fetch(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await out.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  }
}).listen(port, '0.0.0.0', () => console.log(`status page on :${port}`));
