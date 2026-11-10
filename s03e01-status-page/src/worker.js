// Night status page for sched-prod. Reads the ops feed live on every request (R-K8L).
// Page and status.json are rendered from the same data, so they say the same thing.

const FEED = 'https://hq.mega.dev/challenges/status-for-the-night/api/incidents/e61181243445';
const NIGHT_START_HOUR = 18; // UTC. "Last night" = from 18:00 UTC the evening before the newest incident (R-H9K).
const NIGHT_HOURS = 18;      // ... to 12:00 UTC.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',                  // R-K4M
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'cache-control': 'public, max-age=60',               // R-L5Z (60 s or less)
};

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const pad = (n) => String(n).padStart(2, '0');
const date = (iso) => { const d = new Date(iso); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`; }; // R-L3K: day first
const time = (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };   // HH:MM, 24 h
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const res = await fetch(FEED, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`ops feed answered ${res.status}`);
  const feed = await res.json();
  const all = Array.isArray(feed.incidents) ? feed.incidents : [];
  const lines = [...new Set(all.map((i) => i.line))];

  // Last night only: the night that holds the newest incident.
  let incidents = [];
  if (all.length) {
    const newest = all.reduce((a, b) => (Date.parse(b.opened) > Date.parse(a.opened) ? b : a));
    const n = new Date(newest.opened);
    let start = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), NIGHT_START_HOUR);
    if (start > n.getTime()) start -= 24 * 3600 * 1000;
    const end = start + NIGHT_HOURS * 3600 * 1000;
    incidents = all
      .filter((i) => { const t = Date.parse(i.opened); return t >= start && t < end; })
      .sort((a, b) => Date.parse(b.opened) - Date.parse(a.opened)); // R-M3H: newest first
  }
  return { updatedAt: feed.updatedAt, incidents, lines, all };
}

function renderPage({ updatedAt, incidents, lines }) {
  const rows = incidents.map((i) => `<tr>
<td>${date(i.opened)}</td><td>${time(i.opened)}</td><td>${i.closed ? time(i.closed) : 'open'}</td>
<td>${esc(i.line)}</td><td>${esc(i.what)}</td><td>${esc(i.author && i.author !== '—' ? i.author : 'not recorded')}</td></tr>`).join('\n');

  // R-Z2K: every line gets its own row, tram 3 included.
  const lineRows = lines.map((l) => {
    const mine = incidents.filter((i) => i.line === l);
    return `<tr><td>${esc(l)}</td><td>${mine.length}</td><td>${mine.length ? esc(mine[0].what) : '–'}</td></tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>status for the night</title>
<link rel="alternate" type="application/json" href="status.json">
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff}
.banner{background:#f5a623;color:#1a1a1a;padding:14px 20px;font-weight:600}
main{max-width:860px;margin:0 auto;padding:0 20px 40px}
h1{font-size:28px;margin:28px 0 8px}h2{font-size:18px;margin:28px 0 8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e5e5}
th{font-weight:600;color:#666;font-size:14px}
footer{margin-top:32px;color:#555;font-size:14px}
</style></head><body>
<div class="banner">Some services had problems overnight.</div>
<main>
<h1>status for the night</h1>
<table><thead><tr><th>date</th><th>opened</th><th>closed</th><th>line</th><th>what</th><th>who ran it</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">No incidents last night.</td></tr>'}
</tbody></table>
<h2>Lines</h2>
<table><thead><tr><th>line</th><th>incidents last night</th><th>latest</th></tr></thead><tbody>
${lineRows}
</tbody></table>
<footer>
<p>All times UTC. Dates are day/month. Updated at ${esc(updatedAt)}. Data: <a href="status.json">status.json</a>.</p>
<p>read by tram 3 boards</p>
</footer>
</main></body></html>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD, OPTIONS' } });
    try {
      const data = await load();
      if (url.pathname === '/status.json') {
        const body = JSON.stringify({ updatedAt: data.updatedAt, incidents: data.incidents }); // R-H8X: feed's UTC Z timestamp
        return new Response(request.method === 'HEAD' ? null : body, { headers: JSON_HEADERS });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(request.method === 'HEAD' ? null : renderPage(data), { headers: HTML_HEADERS });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      const h = url.pathname === '/status.json' ? JSON_HEADERS : HTML_HEADERS;
      return new Response(url.pathname === '/status.json' ? JSON.stringify({ error: 'ops feed unavailable' }) : 'Status is temporarily unavailable.', { status: 502, headers: { ...h, 'cache-control': 'no-store' } });
    }
  },
};
