const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function planPage({ publicUrl }) {
  const base = publicUrl.replace(/\/$/, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plan: schema-first MCP server</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1rem;color:#1b1b1b}
code{background:#f1f1f1;padding:.1rem .3rem;border-radius:4px}h2{margin-top:2rem}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}</style></head><body>
<h1>Schema-first MCP server</h1>
<p>A small remote MCP server with four tools. Endpoint: <code>${esc(base)}/mcp</code> (Streamable HTTP, MCP revision 2026-07-28; 2025-era clients are served statelessly).</p>

<h2>Tools</h2>
<table>
<tr><th>Tool</th><th>Input</th><th>Result</th></tr>
<tr><td><code>memo_write</code></td><td><code>{ text }</code></td><td><code>{ id }</code>. Saves a note.</td></tr>
<tr><td><code>memo_search</code></td><td><code>{ query, limit? }</code></td><td><code>{ notes: [{ id, text, created_at }] }</code>. Matches words in the note text.</td></tr>
<tr><td><code>upload</code></td><td><code>{ filename?, contentType?, data | text | url }</code></td><td><code>{ url }</code>. The link is served by this server and opens without sign-in. Limit 20 MB per file.</td></tr>
<tr><td><code>transcribe</code></td><td><code>{ url }</code></td><td><code>{ segments: [{ start, end, text }], duration? }</code>, times in seconds. Limit 25 MB and 15 minutes of audio. A Whisper model (<code>onnx-community/whisper-base</code> from Hugging Face) runs on this server; the audio is not sent to any other service.</td></tr>
</table>
<p>Every result is structured content that matches the output schema the tool declares in <code>tools/list</code>.</p>

<h2>Sign-in</h2>
<p>The <code>/mcp</code> endpoint needs an OAuth 2.1 access token. This server is its own authorization server (metadata at <code>/.well-known/oauth-authorization-server</code>; resource metadata at <code>/.well-known/oauth-protected-resource/mcp</code>).
Clients register with dynamic client registration or a client ID metadata document, then use the authorization code flow with PKCE (S256) and the <code>resource</code> parameter.
Access is granted only when the owner opens the authorization page and enters the owner passphrase. Tokens last one hour; refresh tokens rotate and last 30 days. Tokens are stored only as SHA-256 hashes.</p>

<h2>Data this server keeps</h2>
<ul>
<li><b>Notes</b>: the text you save and a timestamp, in a Postgres database. Every signed-in client shares one note store. Notes stay until the owner removes them.</li>
<li><b>Uploaded files</b>: the bytes, the file name and type, in the same database. Anyone who has a file's link can open it. The link contains a random 128-bit id.</li>
<li><b>Client registrations and tokens</b>: client name and redirect URIs; token hashes with expiry.</li>
<li><b>Audio for transcription</b>: fetched into memory, decoded and transcribed on this server, and not kept afterwards. Only the resulting text goes back to the caller.</li>
<li>No analytics and no third-party trackers. Standard request logs may hold IP addresses and paths, never tokens or note text.</li>
</ul>

<h2>Limits</h2>
<p>The server fetches only public https addresses (no private ranges, redirects re-checked). Requests are rate limited on sign-in endpoints.</p>
</body></html>`;
}
