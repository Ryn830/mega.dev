import crypto from 'node:crypto';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (e) => console.error('postgres pool error:', e.message));

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      seq        BIGSERIAL PRIMARY KEY,
      id         TEXT NOT NULL UNIQUE,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size         INTEGER NOT NULL,
      data         BYTEA NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      data      JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      hash       TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      hash       TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);
}

export const pingDb = () => pool.query('SELECT 1');
export const closeDb = () => pool.end();

/* ---------- notes ---------- */
const noteRow = (r) => ({ id: r.id, text: r.text, created_at: r.created_at.toISOString() });

export async function addNote(text) {
  const id = randomId(8);
  const { rows } = await pool.query('INSERT INTO notes (id, text) VALUES ($1, $2) RETURNING id, text, created_at', [id, text]);
  return noteRow(rows[0]);
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchNotes(query, limit = 20) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) {
    const { rows } = await pool.query('SELECT id, text, created_at FROM notes ORDER BY seq DESC LIMIT $1', [limit]);
    return rows.map(noteRow);
  }
  const tokens = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 10);
  const params = [`%${likeEscape(q)}%`];
  const parts = [`(CASE WHEN text ILIKE $1 THEN ${tokens.length + 1} ELSE 0 END)`];
  for (const t of tokens) {
    params.push(`%${likeEscape(t)}%`);
    parts.push(`(CASE WHEN text ILIKE $${params.length} THEN 1 ELSE 0 END)`);
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, text, created_at, ${parts.join(' + ')} AS score
       FROM notes
      WHERE ${parts.join(' + ')} > 0
      ORDER BY score DESC, seq DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(noteRow);
}

export async function noteCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM notes');
  return rows[0].n;
}

/* ---------- uploaded files ---------- */
const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_UPLOAD_BYTES || 500 * 1024 * 1024);

export async function saveFile(buffer, { name, contentType }) {
  const { rows } = await pool.query('SELECT COALESCE(sum(size), 0)::bigint AS total FROM files');
  if (Number(rows[0].total) + buffer.length > MAX_TOTAL_BYTES) throw new Error('Storage quota reached on this server.');
  const id = randomId(16);
  await pool.query('INSERT INTO files (id, name, content_type, size, data) VALUES ($1, $2, $3, $4, $5)', [
    id, name, contentType, buffer.length, buffer,
  ]);
  return id;
}

export async function loadFile(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const { rows } = await pool.query('SELECT name, content_type, size, data FROM files WHERE id = $1', [id]);
  if (!rows[0]) return null;
  return { name: rows[0].name, contentType: rows[0].content_type, size: rows[0].size, data: rows[0].data };
}

/* ---------- OAuth state ---------- */
export async function getClient(clientId) {
  const { rows } = await pool.query('SELECT data FROM oauth_clients WHERE client_id = $1', [clientId]);
  return rows[0]?.data ?? null;
}

export async function clientCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM oauth_clients');
  return rows[0].n;
}

export async function putClient(client) {
  await pool.query('INSERT INTO oauth_clients (client_id, data) VALUES ($1, $2)', [client.client_id, client]);
}

export async function putCode(hash, grant) {
  await pool.query('DELETE FROM oauth_codes WHERE expires_at < $1', [Date.now()]);
  await pool.query('INSERT INTO oauth_codes (hash, data, expires_at) VALUES ($1, $2, $3)', [hash, grant, grant.expires_at]);
}

/** Atomically reads and removes a code, so it can be used once. */
export async function takeCode(hash) {
  const { rows } = await pool.query('DELETE FROM oauth_codes WHERE hash = $1 RETURNING data', [hash]);
  return rows[0]?.data ?? null;
}

export async function putToken(hash, rec) {
  await pool.query('INSERT INTO oauth_tokens (hash, data, expires_at) VALUES ($1, $2, $3)', [hash, rec, rec.expires_at]);
}

export async function pruneTokens(now = Date.now()) {
  await pool.query('DELETE FROM oauth_tokens WHERE expires_at < $1', [now]);
}

export async function getToken(hash) {
  const { rows } = await pool.query('SELECT data FROM oauth_tokens WHERE hash = $1', [hash]);
  return rows[0]?.data ?? null;
}

/** Atomically reads and removes a refresh token (rotation). */
export async function takeRefreshToken(hash) {
  const { rows } = await pool.query(
    `DELETE FROM oauth_tokens WHERE hash = $1 AND data->>'type' = 'refresh' RETURNING data`,
    [hash],
  );
  return rows[0]?.data ?? null;
}

export async function deleteTokenForClient(hash, clientId) {
  await pool.query(`DELETE FROM oauth_tokens WHERE hash = $1 AND data->>'client_id' = $2`, [hash, clientId]);
}
