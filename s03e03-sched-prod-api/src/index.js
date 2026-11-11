// sched-prod API: the incidents the status page and the board read. Contract: contract/api.md.

const json = (body, status = 200) => Response.json(body, { status });

async function feed(env) {
  const res = await fetch(env.FEED_URL);
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const { incidents } = await res.json();
  return incidents;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/incidents') {
      const since = url.searchParams.get('since');
      let incidents = await feed(env);
      if (since !== null) {
        const t = Date.parse(since);
        if (Number.isNaN(t)) return json({ error: 'since must be an ISO 8601 time' }, 400);
        incidents = incidents.filter((i) => Date.parse(i.openedAt) > t);
      }
      return json({ incidents });
    }
    return json({ error: 'not found' }, 404);
  },
};
