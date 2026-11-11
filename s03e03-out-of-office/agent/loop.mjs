// Out-of-office agent: polls the course tracker every minute and hands each issue that needs work to
// a headless Claude (`claude -p`) running the repo's triage skill, one issue at a time (one deploy at a time).
// The runner itself posts the pickup comment, so every issue is picked up within a minute.
// Config in agent/.env: TRACKER_URL TRACKER_TOKEN LIVE_URL REPO_DIR
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const env = { ...process.env };
for (const l of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const { TRACKER_URL, TRACKER_TOKEN, REPO_DIR } = env;
const LOG = new URL('./agent.log', import.meta.url);
const log = (s) => {
  const t = `${new Date().toISOString()} ${s}`;
  console.log(t);
  appendFileSync(LOG, t + '\n');
};

const api = async (path, init = {}) => {
  const r = await fetch(TRACKER_URL.replace(/\/$/, '') + path, {
    ...init,
    headers: { authorization: `Bearer ${TRACKER_TOKEN}`, 'content-type': 'application/json' },
  });
  return r.json();
};
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body ?? {}) });

const isAnswer = (e) => e.by === 'owner' && /\/answer\s+\d+/.test(e.body || '');
const lastAt = (list) => Math.max(0, ...list.map((e) => +new Date(e.at)));
const ownerWaiting = (i) =>
  lastAt(i.thread.filter(isAnswer)) > lastAt(i.thread.filter((e) => e.by === 'agent'));

const ALLOWED = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(curl:*)', 'Bash(node:*)', 'Bash(gh pr:*)', 'Bash(git:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(jq:*)', 'Bash(date:*)',
].join(',');

const running = new Set();
const lastTry = new Map();
const tries = new Map();
const picked = new Set();

function work(i, why) {
  running.add(i.n);
  lastTry.set(i.n, Date.now());
  tries.set(i.n, (tries.get(i.n) || 0) + 1);
  const prompt =
    `Use the triage skill on issue #${i.n} of the course tracker (${why}). ` +
    `Env TRACKER_URL, TRACKER_TOKEN and LIVE_URL are set. Work only this issue, finish it, end with one report line.`;
  log(`#${i.n} start (${why}, try ${tries.get(i.n)})`);
  const p = spawn(
    'claude',
    ['-p', prompt, '--allowedTools', ALLOWED, '--disallowedTools', 'WebFetch,WebSearch', '--max-turns', '60'],
    { cwd: REPO_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const kill = setTimeout(() => p.kill('SIGKILL'), 25 * 60 * 1000);
  p.on('close', (code) => {
    clearTimeout(kill);
    running.delete(i.n);
    log(`#${i.n} done code=${code}: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 500)}`);
  });
}

async function tick() {
  let data;
  try {
    data = await api('/issues');
  } catch (e) {
    return log('poll error ' + e.message);
  }
  const issues = (data.issues || []).sort((a, b) => a.n - b.n);
  for (const i of issues) {
    if (i.closed || picked.has(i.n) || i.thread.some((e) => e.by === 'agent')) continue;
    picked.add(i.n);
    await post(`/issues/${i.n}/comments`, {
      body: `Picked up #${i.n}. Reading the contract, decision records and research first.`,
    }).catch((e) => log('pickup error ' + e.message));
    log(`#${i.n} picked up`);
  }
  if (running.size === 0) {
    const shiplog = ((await api('/shiplog').catch(() => ({}))).text || '').split('\n');
    const lineFor = (n) => shiplog.filter((l) => l.startsWith(`#${n} ·`)).pop() || '';
    for (const i of issues) {
      if (i.closed) continue;
      const line = lineFor(i.n);
      const finished = /· (shipped|declined|closed) ·/.test(line);
      const cooled = Date.now() - (lastTry.get(i.n) || 0) > 90_000;
      let why = null;
      if (ownerWaiting(i) && cooled) why = 'owner answered';
      else if (!finished && !/· (asked|waiting) ·/.test(line) && cooled && (tries.get(i.n) || 0) < 4) why = 'new or unfinished';
      if (why) {
        work(i, why);
        break;
      }
    }
  }
  log(`poll: ${issues.length} issues, ${issues.filter((i) => i.closed).length} closed, running=[${[...running]}]`);
}

log('agent loop up');
await tick();
setInterval(() => tick().catch((e) => log('tick error ' + e.message)), 60_000);
