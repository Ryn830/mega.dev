<script lang="ts">
  import reports from '#lib/data/reports-4471.json';
  import notes from '#lib/data/desk-notes.json';
  import tickets from '#lib/data/tickets-4471.json';
  import { groupByCause, readAs, uniqueById, type Report } from '#lib/kb/causes';
  import { tenantOf } from '#lib/kb/locales';

  // One row per problem, counted the desk's way (causes.ts): a report is counted under the cause it
  // is filed by. Reports the desk read as a one-day move stay counted there and get their own row.
  let { ticket }: { ticket: number } = $props();

  const WHAT: Record<string, string> = {
    parser: 'month and day swapped: the shared parser reads a day-first date month first',
    hint: 'month and day swapped: booking-v3 prints MM/DD/YYYY under the date, day-first tenants read it their way',
    'one-day': 'the date moves by one day, not month for day',
    unplaced: 'no tenant on file, or the tenant writes month first',
  };

  const merged = $derived(uniqueById(reports as Report[]).filter((r) => r.mergedInto === ticket));
  const groups = $derived(groupByCause(merged, tenantOf));
  const oneDay = $derived(
    groups.flatMap((g) => {
      const n = readAs(g, notes.oneDayMove);
      return n ? [{ n, within: g.cause, rs: g.reports.filter((r) => notes.oneDayMove.includes(r.id)) }] : [];
    }),
  );
  const link = (p: string) => (tickets as Record<string, string>)[p];
  const days = (rs: Report[]) => rs.map((r) => r.receivedAt.slice(0, 10)).sort();
  const tags = (t: Record<string, number>) =>
    Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, n]) => `${tag} ×${n}`)
      .join(' · ');
</script>

{#snippet ticketCell(p: string)}
  {#if link(p)}<a href={link(p)}>{link(p).replace(/^.*\/issues\//, '#')}</a>{:else}<span class="none">none yet</span>{/if}
{/snippet}

<p class="sum">
  <strong>{merged.length}</strong> reports merged into #{ticket} ·
  <strong>{groups.length + oneDay.length}</strong> problems ·
  {groups.map((g) => g.reports.length).join(' + ')} = {merged.length}
</p>

<table>
  <thead>
    <tr><th>problem</th><th>what happens</th><th>reports</th><th>tenants</th><th>seen</th><th>intake tagged as</th><th>ticket</th></tr>
  </thead>
  <tbody>
    {#each groups as g (g.cause)}
      <tr>
        <td><code>{g.cause}</code></td>
        <td>{WHAT[g.cause]}</td>
        <td><strong>{g.reports.length}</strong></td>
        <td>{g.tenants}</td>
        <td>{g.firstSeen} → {g.lastSeen}</td>
        <td class="tags">{tags(g.taggedAs)}</td>
        <td>{@render ticketCell(g.cause)}</td>
      </tr>
    {/each}
    {#each oneDay as o (o.within)}
      <tr class="within">
        <td><code>one-day</code></td>
        <td>{WHAT['one-day']}</td>
        <td><strong>{o.n}</strong> <span class="tags">of the {o.within} {groups.find((g) => g.cause === o.within)?.reports.length}</span></td>
        <td>{new Set(o.rs.map((r) => r.tenant)).size}</td>
        <td>{days(o.rs)[0]} → {days(o.rs)[o.rs.length - 1]}</td>
        <td class="tags">{tags(o.rs.reduce<Record<string, number>>((n, r) => ({ ...n, [r.meta.intakeTag]: (n[r.meta.intakeTag] ?? 0) + 1 }), {}))}</td>
        <td>{@render ticketCell('one-day')}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .sum { font-size: 1.1rem; }
  .tags { color: var(--muted); font-size: 0.85em; }
  .none { color: var(--warn); font-weight: 600; }
  .within td:first-child { padding-left: 1.25rem; }
</style>
