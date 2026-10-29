import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { mdsvex } from 'mdsvex';

/** @type {import('@sveltejs/kit').Config} */
export default {
  extensions: ['.svelte', '.svx'],
  preprocess: [mdsvex({ extensions: ['.svx'], layout: { runbook: fileURLToPath(new URL('./src/lib/layouts/runbook.svelte', import.meta.url)) } })],
  kit: {
    adapter: adapter(),
    alias: { '#lib': 'src/lib' },
    prerender: { entries: ['*'] },
  },
};
