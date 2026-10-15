import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildVersionPlugin, resolveBuildLabel } from '../../shared/build-version.mjs';

// SAiM Alt v3 — the policy-driven desktop A/B build (saim-alt.nickward.co.uk; v1 is kept at saim-alt-v1).
//
//   npm run build:alt3  →   dist-alt3/  (deployed MANUALLY to its own Netlify
//                                        site; never the control's autodeploy)
//
// ⚠ Isolation: its own root (`alt-v3/`), its own env file (`.env.alt3`, loaded by
//   `--mode alt3` — `.env.production` is NOT read), its own output folder, and
//   no PWA plugin, so no service worker can ever claim this origin. The control
//   config (`vite.config.js`) is untouched and never sees `alt-v2/` or `alt-v3/`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_LABEL = `alt3-${resolveBuildLabel()}`;

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
  root: path.join(HERE, 'alt-v3'),
  envDir: HERE,
  publicDir: path.join(HERE, 'public'),
  define: {
    'import.meta.env.VITE_BUILD_LABEL': JSON.stringify(BUILD_LABEL),
  },
  plugins: [buildVersionPlugin(BUILD_LABEL), react(), netlifyFiles()],
  build: {
    outDir: path.join(HERE, 'dist-alt3'),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5187, // clear of NEURO (5173), kiosk (5174), control (5175), VESTA (5176), Alt v1 (5186)
    proxy: {
      '/api': { target: process.env.NEURO_BACKEND_URL || 'http://localhost:3001', changeOrigin: true },
    },
  },
});
