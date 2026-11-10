import express from 'express';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { hostHeaderValidation, requireBearerAuth, mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import { initDb, pingDb, loadFile, noteCount } from './store.mjs';
import { createOAuth } from './oauth.mjs';
import { createToolServer } from './tools.mjs';
import { planPage } from './plan.mjs';
import { warmUp } from './transcribe.mjs';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)
).replace(/\/$/, '');
const publicUrl = new URL(PUBLIC_URL);
const insecure = publicUrl.protocol !== 'https:';
if (insecure && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) {
  throw new Error('PUBLIC_URL must be https unless it points at localhost.');
}
if (insecure) process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = 'true';

// Owner passphrase: only the owner knows it. It is typed on the sign-in page.
const ownerSecret = process.env.OWNER_SECRET;
if (!ownerSecret || ownerSecret.length < 12) throw new Error('Set OWNER_SECRET (at least 12 characters) in the environment.');
await initDb();

const mcpUrl = `${PUBLIC_URL}/mcp`;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const allowedHosts = new Set([publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]']);
for (const h of (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) allowedHosts.add(h);
app.use(hostHeaderValidation([...allowedHosts]));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// Request log: method, path (no query string), status, time, size, caller. Never headers, bodies or tokens.
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const rpc = res.locals.rpc ? ` rpc=${res.locals.rpc}` : '';
    const ua = String(req.get('user-agent') || '-').slice(0, 60);
    console.log(`req ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms ${res.get('content-length') || '-'}B ip=${req.ip} ua="${ua}"${rpc}`);
  });
  next();
});

app.get('/healthz', async (_req, res) => {
  try {
    await pingDb();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

/* ---------- OAuth (authorization server) ---------- */
const oauth = createOAuth({ publicUrl: PUBLIC_URL, mcpUrl, ownerSecret });
app.use(oauth.router);

/* ---------- Protected resource metadata (names the plan page) ---------- */
app.use(
  mcpAuthMetadataRouter({
    oauthMetadata: oauth.metadata,
    resourceServerUrl: new URL(mcpUrl),
    serviceDocumentationUrl: new URL(`${PUBLIC_URL}/plan`),
    scopesSupported: ['mcp'],
    resourceName: 'Schema-first MCP server',
    dangerouslyAllowInsecureIssuerUrl: insecure,
  }),
);

/* ---------- Plan page ---------- */
app.get('/plan', (_req, res) => {
  res
    .type('html')
    .set('Cache-Control', 'public, max-age=300')
    .send(planPage({ publicUrl: PUBLIC_URL }));
});
app.get('/', (_req, res) => res.redirect('/plan'));

/* ---------- Uploaded files (open to anyone with the link) ---------- */
app.get('/files/:id{/:name}', async (req, res, next) => {
  try {
    const file = await loadFile(req.params.id);
    if (!file) return res.status(404).type('text').send('Not found');
    res.set({
      'Content-Type': file.contentType,
      'Content-Length': String(file.size),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'none',
    });
    res.end(file.data);
  } catch (e) {
    next(e);
  }
});

/* ---------- MCP endpoint ---------- */
const handler = createMcpHandler(() => createToolServer({ publicUrl: PUBLIC_URL }), {
  legacy: 'stateless',
  onerror: (e) => console.error('mcp error:', e?.message),
});
const nodeHandler = toNodeHandler(handler, { onerror: (e) => console.error('mcp adapter error:', e?.message), maxRequestBodySize: 32 * 1024 * 1024 });

app.all(
  '/mcp',
  requireBearerAuth({
    verifier: oauth.verifier,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl)),
    expectedResource: new URL(mcpUrl),
  }),
  express.json({ limit: '30mb' }),
  (req, res) => {
    const b = Array.isArray(req.body) ? req.body[0] : req.body;
    if (b && typeof b.method === 'string') {
      const tool = b.method === 'tools/call' && typeof b.params?.name === 'string' ? `:${b.params.name.slice(0, 40)}` : '';
      res.locals.rpc = `${b.method.slice(0, 40)}${tool}`;
    }
    nodeHandler(req, res, req.body);
  },
);

app.use((err, _req, res, _next) => {
  console.error('request error:', err?.message);
  if (!res.headersSent) res.status(500).type('text').send('Internal error');
});

const notes = await noteCount();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP server listening on :${PORT}`);
  console.log(`public URL ${PUBLIC_URL}  mcp ${mcpUrl}  notes ${notes}`);
  warmUp()
    .then((ms) => console.log(`transcribe model warm in ${ms}ms`))
    .catch((e) => console.error('transcribe warm-up failed:', e?.message));
});
