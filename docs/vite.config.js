import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import mdx from '@mdx-js/rollup';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {ROUTES} from './src/nav.js';

/**
 * GitHub Pages serves a project repo from /<repo>/, everything else from /.
 *
 * DOCS_BASE lets the same source target both without editing this file:
 *   GitHub Pages → DOCS_BASE=/Music_Player/  (set in .github/workflows/docs.yml)
 *   local dev    → unset, defaults to /
 *
 * Getting this wrong is silent: the page loads, every asset 404s, and you get a
 * white screen with no error anyone would recognise.
 */
const base = process.env.DOCS_BASE || '/';

/**
 * A real HTML file for every route.
 *
 * This is a single-page app, so without this only `/` exists as a file and
 * every deep link — the ones people actually bookmark and share — falls to
 * GitHub Pages' 404 handler. The usual workaround is to make 404.html a copy of
 * index.html, which works but serves a 404 status to crawlers for every real
 * page on the site.
 *
 * Copying index.html into each route directory instead means the server has
 * something to return with a 200. The router reads location.pathname and
 * renders the right page, exactly as it does on a client-side navigation.
 */
function emitRoutes() {
  return {
    name: 'emit-route-html',
    apply: 'build',
    closeBundle() {
      const out = join(process.cwd(), 'dist');
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      for (const route of ROUTES) {
        if (route === '/') {
          continue;
        }
        const file = join(out, route.replace(/^\//, ''), 'index.html');
        mkdirSync(dirname(file), {recursive: true});
        writeFileSync(file, html);
      }
      // GitHub Pages serves this for anything not matched above — a mistyped
      // URL still lands in the app, which renders its own not-found page rather
      // than GitHub's.
      writeFileSync(join(out, '404.html'), html);
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    // MDX must run before the React plugin: it turns .mdx into JSX, and the
    // React plugin is what compiles JSX. The other order sees files it cannot
    // parse.
    {enforce: 'pre', ...mdx({remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug]})},
    react({include: /\.(jsx|js|mdx|tsx|ts)$/}),
    emitRoutes(),
  ],
  build: {outDir: 'dist', emptyOutDir: true},
});
