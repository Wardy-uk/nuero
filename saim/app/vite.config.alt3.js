// ⛔ RETIRED (21 Oct 2026). SAiM Alt and the legacy control desktop are retired as
// product variants: sara.nickward.co.uk is the only SAiM. Its build command refuses
// to run (scripts/retired-build.cjs); the old hostnames redirect (saim/retired-alt/).
// Kept for rollback only — a rollback is a Netlify deploy restore, not a rebuild.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildVersionPlugin, resolveBuildLabel } from '../../shared/build-version.mjs';

// SAiM Alt v3 — the policy-driven desktop, PROMOTED to saim.nickward.co.uk on 16 Oct 2026
// (Netlify site saim-alt-nickward). The legacy control desktop moved to saim-alt; v1 is kept at saim-alt-v1.
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
//
// ⚠ `sw.js` is a KILL-SWITCH, not a worker for this app. Until 16 Oct 2026
// saim.nickward.co.uk served the control, whose service worker answers a slow
// navigation (3 s) from its cached shell. A browser that kept it would show the
// OLD app at saim. on a bad connection. The browser re-fetches /sw.js on every
// navigation; this one clears the old caches, unregisters itself and reloads the
// tab onto the live page. Without a real /sw.js the SPA fallback answers it with
// HTML, the update fails silently, and the old worker stays for ever.
const KILL_SWITCH_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.navigate(c.url);
  })());
});
`;
function netlifyFiles() {
  return {
    name: 'saim-alt-netlify-files',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_redirects', source: '/*  /index.html  200\n' });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: KILL_SWITCH_SW });
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
          '/sw.js',
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
