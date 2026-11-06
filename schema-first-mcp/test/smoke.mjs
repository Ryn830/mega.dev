// Local smoke test. Start the server first, with a test database and ALLOW_PRIVATE_FETCH=1:
//   DATABASE_URL=postgres://... OWNER_SECRET=test-passphrase-123 PORT=3111 PUBLIC_URL=http://localhost:3111 \
//   ALLOW_PRIVATE_FETCH=1 node src/main.mjs
// Then: OWNER_SECRET=test-passphrase-123 SPEECH_FILE=/path/to/speech.wav node test/smoke.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const BASE = process.env.BASE || 'http://localhost:3111';
const SECRET = process.env.OWNER_SECRET;
if (!SECRET) throw new Error('Set OWNER_SECRET to the same value the server uses.');
const SPEECH_FILE = process.env.SPEECH_FILE;
const REDIRECT = 'http://localhost:9999/cb';
let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log('ok  ', name);
};

async function getToken() {
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'smoke test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  })).json();
  check('registration returns client_id', !!reg.client_id);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope: 'mcp', resource: `${BASE}/mcp`,
  });
  const page = await fetch(`${meta.authorization_endpoint}?${q}`);
  check('consent page renders', page.status === 200 && (await page.text()).includes('Owner passphrase'));
  const post = (passphrase, decision = 'allow') => fetch(meta.authorization_endpoint, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(q), passphrase, decision }),
  });
  const wrong = await post('nope');
  check('wrong passphrase refused', wrong.status === 401);
  const denied = await post('', 'deny');
  check('deny redirects with access_denied', denied.status === 302 && denied.headers.get('location').includes('error=access_denied'));
  const good = await post(SECRET);
  check('allow redirects', good.status === 302);
  const loc = new URL(good.headers.get('location'));
  check('redirect carries state and iss', loc.searchParams.get('state') === 'xyz' && loc.searchParams.get('iss') === BASE);
  const code = loc.searchParams.get('code');
  const tokenReq = (extra) => fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: reg.client_id, ...extra }),
  });
  const bad = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: crypto.randomBytes(32).toString('base64url') });
  check('wrong PKCE verifier refused', bad.status === 400);
  const code2 = new URL((await post(SECRET)).headers.get('location')).searchParams.get('code');
  const tok = await (await tokenReq({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` })).json();
  check('token issued', !!tok.access_token && tok.token_type === 'Bearer');
  const replay = await tokenReq({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, code_verifier: verifier });
  check('code is single use', replay.status === 400);
  const refreshed = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).json();
  check('refresh works', !!refreshed.access_token);
  const reuse = await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  check('refresh token rotates', reuse.status === 400);
  return refreshed.access_token;
}

const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
check('resource metadata names plan page', prm.resource_documentation === `${BASE}/plan`);
const plan = await fetch(prm.resource_documentation);
check('plan page is served', plan.status === 200 && (await plan.text()).includes('memo_write'));

const noAuth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('no token -> 401 with resource_metadata', noAuth.status === 401 && /resource_metadata=/.test(noAuth.headers.get('www-authenticate')));
const badAuth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
check('bad token -> 401', badAuth.status === 401);

const token = await getToken();

/* ----- modern client (2026-07-28) ----- */
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: { token: async () => token } }));
const tools = (await client.listTools()).tools;
check('four tools listed', ['memo_write', 'memo_search', 'upload', 'transcribe'].every((n) => tools.some((t) => t.name === n)));
check('every tool declares outputSchema', tools.every((t) => t.outputSchema && t.outputSchema.type === 'object'));

const marker = `smoke-${crypto.randomUUID()}`;
const w = await client.callTool({ name: 'memo_write', arguments: { text: `hello ${marker}` } });
check('memo_write returns id', typeof w.structuredContent?.id === 'string');
const s = await client.callTool({ name: 'memo_search', arguments: { query: marker } });
check('memo_search finds the note', s.structuredContent.notes.some((n) => n.id === w.structuredContent.id && n.text.includes(marker)));
const s2 = await client.callTool({ name: 'memo_search', arguments: { query: 'zzzz-no-such-word' } });
check('memo_search empty result is an empty list', Array.isArray(s2.structuredContent.notes) && s2.structuredContent.notes.length === 0);

const body = `file body ${marker}`;
const up = await client.callTool({ name: 'upload', arguments: { filename: 'a b.txt', data: Buffer.from(body).toString('base64'), contentType: 'text/plain' } });
const url = up.structuredContent?.url;
check('upload returns url on this host', typeof url === 'string' && url.startsWith(`${BASE}/files/`));
const got = await fetch(url);
check('uploaded file opens without sign-in', got.status === 200 && (await got.text()) === body);
check('uploaded file is sandboxed', /sandbox/.test(got.headers.get('content-security-policy')) && got.headers.get('x-content-type-options') === 'nosniff');
const up2 = await client.callTool({ name: 'upload', arguments: { name: 'n.txt', content: 'plain via alias' } });
check('upload accepts alias fields', typeof up2.structuredContent?.url === 'string');
const up3 = await client.callTool({ name: 'upload', arguments: {} });
check('upload with no data is a tool error', up3.isError === true);

if (SPEECH_FILE) {
  const wav = fs.readFileSync(SPEECH_FILE);
  const upWav = await client.callTool({ name: 'upload', arguments: { filename: 'speech.wav', data: wav.toString('base64'), contentType: 'audio/wav' } });
  const t0 = Date.now();
  const tr = await client.callTool({ name: 'transcribe', arguments: { url: upWav.structuredContent.url } });
  console.log(`      transcribe took ${Date.now() - t0} ms:`, JSON.stringify(tr.structuredContent));
  const segs = tr.structuredContent.segments;
  check('transcribe returns timestamped segments', segs.length > 0 && segs.every((s) => typeof s.start === 'number' && typeof s.end === 'number' && s.end >= s.start && s.text));
  check('transcript contains the spoken words', /country/i.test(segs.map((s) => s.text).join(' ')));
}
const trNotAudio = await client.callTool({ name: 'transcribe', arguments: { url } });
check('transcribe on a non-audio file is a tool error', trNotAudio.isError === true);
const trBad = await client.callTool({ name: 'transcribe', arguments: { url: 'ftp://x/y.mp3' } });
check('transcribe rejects non-http(s) url', trBad.isError === true);
await client.close();

/* ----- 2025-era client, stateless fallback ----- */
const rpc = (id, method, params) => fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
});
const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '0' } });
check('legacy initialize works', init.status === 200);
const lt = await rpc(2, 'tools/call', { name: 'memo_search', arguments: { query: marker } });
const ltText = await lt.text();
check('legacy tools/call works', lt.status === 200 && ltText.includes(marker));

console.log(`\n${passed} checks passed`);
