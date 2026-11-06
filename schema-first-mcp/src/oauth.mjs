import crypto from 'node:crypto';
import express from 'express';
import * as db from './store.mjs';
import { sha256, randomId, randomToken } from './store.mjs';
import { safeFetch } from './safefetch.mjs';

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 200;
const SCOPE = 'mcp';

const cimdCache = new Map(); // url -> { at, client }

/* ---------- tiny rate limiter ---------- */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > windowMs) hits.delete(k);
    return list.length <= max;
  };
}
const registerLimit = limiter(20, 60_000);
const decisionLimit = limiter(8, 60_000);
const tokenLimit = limiter(120, 60_000);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function validRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// RFC 8252 section 7.3: for loopback redirects, the port may differ from the registered one.
export function redirectMatches(registered, requested) {
  if (registered.includes(requested)) return true;
  try {
    const r = new URL(requested);
    if (r.protocol !== 'http:' || !LOOPBACK.includes(r.hostname)) return false;
    return registered.some((x) => {
      const u = new URL(x);
      return u.protocol === 'http:' && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    });
  } catch {
    return false;
  }
}

function oauthError(res, status, error, description) {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

export function createOAuth({ publicUrl, mcpUrl, ownerSecret }) {
  const issuer = publicUrl.replace(/\/$/, '');
  const router = express.Router();
  const secretHash = crypto.createHash('sha256').update(ownerSecret).digest();

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };

  /* ---------- client lookup (registered or metadata document) ---------- */
  async function getClient(clientId) {
    if (typeof clientId !== 'string' || !clientId) return null;
    if (clientId.startsWith('https://')) {
      const cached = cimdCache.get(clientId);
      if (cached && Date.now() - cached.at < 3600_000) return cached.client;
      try {
        const { buffer } = await safeFetch(clientId, { maxBytes: 64 * 1024, timeoutMs: 5000, accept: 'application/json' });
        const doc = JSON.parse(buffer.toString('utf8'));
        if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(validRedirectUri)) {
          return null;
        }
        const client = {
          client_id: clientId,
          client_name: String(doc.client_name || new URL(clientId).hostname).slice(0, 100),
          redirect_uris: doc.redirect_uris,
          auth_method: 'none',
        };
        cimdCache.set(clientId, { at: Date.now(), client });
        return client;
      } catch {
        return null;
      }
    }
    return await db.getClient(clientId);
  }

  /* ---------- dynamic client registration ---------- */
  router.post('/register', express.json({ limit: '20kb' }), async (req, res) => {
    if (!registerLimit(req.ip)) return oauthError(res, 429, 'temporarily_unavailable', 'Too many registrations.');
    const body = req.body || {};
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https (or loopback http) URLs.');
    }
    if ((await db.clientCount()) >= MAX_CLIENTS) {
      return oauthError(res, 400, 'invalid_client_metadata', 'Client registry is full.');
    }
    const method = body.token_endpoint_auth_method || 'none';
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) {
      return oauthError(res, 400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
    }
    const client_id = `c_${randomId(12)}`;
    const client_secret = method === 'none' ? undefined : randomToken(32);
    const record = {
      client_id,
      client_name: String(body.client_name || 'Unnamed client').slice(0, 100),
      redirect_uris: uris,
      auth_method: method,
      secret_hash: client_secret ? sha256(client_secret) : undefined,
      created_at: new Date().toISOString(),
    };
    await db.putClient(record);
    res.status(201).set('Cache-Control', 'no-store').json({
      client_id,
      client_secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: client_secret ? 0 : undefined,
      client_name: record.client_name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    });
  });

  /* ---------- authorization ---------- */
  function consentPage(res, { client, params, error }) {
    const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] ?? '')}">`)
      .join('');
    res
      .status(error ? 401 : 200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:; frame-ancestors 'none'",
      })
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow access</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b}
dl{background:#f4f4f4;padding:1rem;border-radius:8px}dt{font-weight:600}dd{margin:0 0 .6rem;word-break:break-all}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}
button{padding:.6rem 1.2rem;font-size:1rem;margin-right:.5rem;cursor:pointer}.err{color:#b00020}</style></head><body>
<h1>Allow access to this server?</h1>
<p>An application asks to use the tools on this server (memo, upload, transcribe) as its owner.</p>
<dl><dt>Application</dt><dd>${esc(client.client_name)}</dd>
<dt>Returns to</dt><dd>${esc(params.redirect_uri)}</dd>
<dt>Access</dt><dd>Read and write notes, upload files, transcribe audio</dd></dl>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<p><label>Owner passphrase<br><input type="password" name="passphrase" autocomplete="current-password" required></label></p>
<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form>
<p><small>Only the owner of this server has the passphrase. <a href="/plan">What this server does and keeps</a></small></p>
</body></html>`);
  }

  function plainError(res, status, message) {
    res.status(status).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).send(message);
  }

  async function validateAuthRequest(params) {
    const client = await getClient(params.client_id);
    if (!client) return { fatal: 'Unknown client.' };
    if (!redirectMatches(client.redirect_uris, params.redirect_uri)) return { fatal: 'The redirect URI is not registered for this client.' };
    const redirectError = (error, description) => ({ client, redirectError: { error, description } });
    if (params.response_type !== undefined && params.response_type !== 'code') {
      return redirectError('unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (!params.code_challenge || params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
      return redirectError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    if (params.resource && params.resource.replace(/\/$/, '') !== mcpUrl.replace(/\/$/, '')) {
      return redirectError('invalid_target', 'Unknown resource.');
    }
    const scope = params.scope ? params.scope.split(' ').filter(Boolean) : [SCOPE];
    if (!scope.every((s) => s === SCOPE)) return redirectError('invalid_scope', 'Only the "mcp" scope exists.');
    return { client };
  }

  function redirectBack(res, redirectUri, extra) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...extra, iss: issuer })) if (v !== undefined) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  }

  router.get('/authorize', async (req, res) => {
    const params = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    const check = await validateAuthRequest(params);
    if (check.fatal) return plainError(res, 400, check.fatal);
    if (check.redirectError) {
      return redirectBack(res, params.redirect_uri, {
        error: check.redirectError.error,
        error_description: check.redirectError.description,
        state: params.state,
      });
    }
    consentPage(res, { client: check.client, params });
  });

  router.post('/authorize', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const params = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v)]));
    const check = await validateAuthRequest(params);
    if (check.fatal) return plainError(res, 400, check.fatal);
    if (check.redirectError) {
      return redirectBack(res, params.redirect_uri, {
        error: check.redirectError.error,
        error_description: check.redirectError.description,
        state: params.state,
      });
    }
    if (params.decision === 'deny') {
      return redirectBack(res, params.redirect_uri, { error: 'access_denied', state: params.state });
    }
    if (!decisionLimit(req.ip)) {
      return consentPage(res, { client: check.client, params, error: 'Too many attempts. Wait a minute and try again.' });
    }
    const given = crypto.createHash('sha256').update(params.passphrase || '').digest();
    if (!crypto.timingSafeEqual(given, secretHash)) {
      return consentPage(res, { client: check.client, params, error: 'Wrong passphrase.' });
    }
    const code = randomToken(32);
    await db.putCode(sha256(code), {
      client_id: check.client.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope: SCOPE,
      expires_at: Date.now() + CODE_TTL_MS,
    });
    redirectBack(res, params.redirect_uri, { code, state: params.state });
  });

  /* ---------- token endpoint ---------- */
  async function issueTokens(clientId, scope) {
    const access = randomToken(32);
    const refresh = randomToken(32);
    const now = Date.now();
    await db.putToken(sha256(access), { type: 'access', client_id: clientId, scope, expires_at: now + ACCESS_TTL_S * 1000 });
    await db.putToken(sha256(refresh), { type: 'refresh', client_id: clientId, scope, expires_at: now + REFRESH_TTL_S * 1000 });
    await db.pruneTokens(now);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  async function authenticateClient(req) {
    let id = req.body.client_id;
    let secret = req.body.client_secret;
    const basic = req.headers.authorization?.match(/^Basic (.+)$/i);
    if (basic) {
      const [bid, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      id = decodeURIComponent(bid);
      secret = decodeURIComponent(rest.join(':'));
    }
    const client = await getClient(id);
    if (!client) return null;
    if (client.auth_method !== 'none') {
      if (!secret) return null;
      const a = Buffer.from(sha256(secret));
      const b = Buffer.from(client.secret_hash || '');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    }
    return client;
  }

  router.post('/token', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    if (!tokenLimit(req.ip)) return oauthError(res, 429, 'temporarily_unavailable', 'Too many requests.');
    const body = req.body || {};
    const client = await authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed.');
    if (body.resource && body.resource.replace(/\/$/, '') !== mcpUrl.replace(/\/$/, '')) {
      return oauthError(res, 400, 'invalid_target', 'Unknown resource.');
    }

    if (body.grant_type === 'authorization_code') {
      const grant = await db.takeCode(sha256(String(body.code || ''))); // single use, even on failure
      if (!grant || grant.expires_at < Date.now() || grant.client_id !== client.client_id) {
        return oauthError(res, 400, 'invalid_grant', 'The code is invalid or expired.');
      }
      if (body.redirect_uri !== grant.redirect_uri) {
        return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
      }
      const verifier = String(body.code_verifier || '');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || challenge !== grant.code_challenge) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      }
      return res.set('Cache-Control', 'no-store').json(await issueTokens(client.client_id, grant.scope));
    }

    if (body.grant_type === 'refresh_token') {
      const rec = await db.takeRefreshToken(sha256(String(body.refresh_token || ''))); // rotates: removed on use
      if (!rec || rec.expires_at < Date.now() || rec.client_id !== client.client_id) {
        return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired.');
      }
      return res.set('Cache-Control', 'no-store').json(await issueTokens(client.client_id, rec.scope));
    }

    return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  router.post('/revoke', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const client = await authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed.');
    await db.deleteTokenForClient(sha256(String(req.body?.token || '')), client.client_id);
    res.status(200).end();
  });

  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));

  /* ---------- verifier used by /mcp ---------- */
  const verifier = {
    async verifyAccessToken(token) {
      const rec = await db.getToken(sha256(token));
      if (!rec || rec.type !== 'access' || rec.expires_at <= Date.now()) {
        const { OAuthError, OAuthErrorCode } = await import('@modelcontextprotocol/server');
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired token');
      }
      return {
        token,
        clientId: rec.client_id,
        scopes: rec.scope.split(' '),
        expiresAt: Math.floor(rec.expires_at / 1000),
        resource: new URL(mcpUrl),
      };
    },
  };

  return { router, metadata, verifier };
}
