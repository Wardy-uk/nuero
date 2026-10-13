import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildVersionPlugin, resolveBuildLabel } from '../../shared/build-version.mjs';

// SAiM Alt — the A/B treatment build (saim-alt.nickward.co.uk).
//
//   npm run build:alt   →   dist-alt/   (deployed MANUALLY to its own Netlify
//                                        site; never the control's autodeploy)
//
// ⚠ Isolation: its own root (`alt/`), its own env file (`.env.alt`, loaded by
//   `--mode alt` — `.env.production` is NOT read), its own output folder, and
//   no PWA plugin, so no service worker can ever claim this origin. The control
//   config (`vite.config.js`) is untouched and never sees `alt/`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_LABEL = `alt-${resolveBuildLabel()}`;

// SPA fallback for Netlify, emitted into the build so a manual deploy of the
// folder is complete on its own.
function netlifyFiles() {
  return {
    name: 'saim-alt-netlify-files',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_redirects', source: '/*  /index.html  200\n' });
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          '  X-Robots-Tag: noindex, nofollow',
          '  Referrer-Policy: no-referrer',
          '/index.html',
          '  Cache-Control: no-cache',
          '/version.json',
          '  Cache-Control: no-cache',
          '',
        ].join('\n'),
      });
    },
  };
}

export default defineConfig({
  root: path.join(HERE, 'alt'),
  envDir: HERE,
  publicDir: path.join(HERE, 'public'),
  define: {
    'import.meta.env.VITE_BUILD_LABEL': JSON.stringify(BUILD_LABEL),
  },
  plugins: [buildVersionPlugin(BUILD_LABEL), react(), netlifyFiles()],
  build: {
    outDir: path.join(HERE, 'dist-alt'),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5176 + 10, // 5186 — clear of NEURO (5173), kiosk (5174), control (5175), VESTA (5176)
    proxy: {
      '/api': { target: process.env.NEURO_BACKEND_URL || 'http://localhost:3001', changeOrigin: true },
    },
  },
});
