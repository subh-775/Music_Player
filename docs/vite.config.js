import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

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
export default defineConfig({
  base: process.env.DOCS_BASE || '/',
  plugins: [react()],
  build: {outDir: 'dist', emptyOutDir: true},
});
