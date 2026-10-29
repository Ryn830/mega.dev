<script lang="ts">
  import reports from '#lib/data/reports-4471.json';
  import notes from '#lib/data/desk-notes.json';
  import tickets from '#lib/data/tickets-4471.json';
  import { problemsIn } from '#lib/kb/problems';
  import { tenantOf } from '#lib/kb/locales';
  import type { Report } from '#lib/kb/causes';

  let { ticket }: { ticket: number } = $props();

  const WHAT: Record<string, string> = {
    parser: 'month and day swapped: the shared parser reads a day-first date month first',
    hint: 'month and day swapped: booking-v3 prints MM/DD/YYYY under the date, day-first tenants read it their way',
    'one-day': 'the date moves by one day, not month for day',
    unplaced: 'no tenant on file, or the tenant writes month first',
  };

  const result = $derived(problemsIn(ticket, reports as Report[], tenantOf, notes.oneDayMove));
  const link = (p: string) => (tickets as Record<string, string>)[p];
  const tags = (t: Record<string, number>) =>
    Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, n]) => `${tag} ×${n}`)
      .join(' · ');
</script>

<p class="sum">
  <strong>{result.merged.length}</strong> reports merged into #{ticket} ·
  <strong>{result.groups.length}</strong>
  {result.groups.length === 1 ? 'problem' : 'problems'} ·
  {result.groups.map((g) => g.reports.length).join(' + ')} = {result.merged.length}
</p>

<table>
  <thead>
    <tr><th>problem</th><th>what happens</th><th>reports</th><th>tenants</th><th>seen</th><th>intake tagged as</th><th>ticket</th></tr>
  </thead>
  <tbody>
    {#each result.groups as g (g.problem)}
      <tr>
        <td><code>{g.problem}</code></td>
        <td>{WHAT[g.problem]}</td>
        <td><strong>{g.reports.length}</strong></td>
        <td>{g.tenants}</td>
        <td>{g.firstSeen} → {g.lastSeen}</td>
        <td class="tags">{tags(g.taggedAs)}</td>
        <td>{#if link(g.problem)}<a href={link(g.problem)}>{link(g.problem).replace(/^.*\/issues\//, '#')}</a>{:else}<span class="none">none yet</span>{/if}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .sum { font-size: 1.1rem; }
  .tags { color: var(--muted); font-size: 0.85em; }
  .none { color: var(--warn); font-weight: 600; }
</style>
