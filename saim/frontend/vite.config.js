import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Dev: Vite serves the frontend and proxies the defined runtime path (/api)
// to the SAiM backend. Prod: `vite build` emits dist/, which the backend serves.
const BACKEND = process.env.SAIM_BACKEND_URL || 'http://localhost:3005';

// Which build is this screen running? (14 Sep 2026)
//
// The phone has answered this since #110 and the kiosks never could — which is
// the surface where it matters MORE, because a tablet is opened once and left
// for days, so "is this the new deploy?" is a question about a page that may
// have been loaded last week. `RefreshButton` renders it, and it is what turns
// a press from a flicker into something with a before and an after.
//
// Derived per build, never a constant: the same label on every build cannot
// answer the question it exists for (the `.env.production` mistake, one app
// along). Built on the Pi, so the git SHA is the useful value.
function resolveBuildLabel() {
  if (process.env.VITE_BUILD_LABEL) return process.env.VITE_BUILD_LABEL;
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_LABEL': JSON.stringify(resolveBuildLabel()),
  },
  plugins: [
    react(),
    // PWA: makes SAiM installable on iPad / iPhone (and any device). autoUpdate keeps a
    // freshly-deployed build from getting stuck behind a stale service-worker cache.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // ⚠ NAVIGATION IS NETWORK-FIRST, NOT PRECACHE-FIRST, and that is a
        // deployment fix rather than a preference. This app's primary home is a
        // kiosk that never closes, six feet from Nick, against a server on the
        // same tailnet. With the precached shell answering navigations, every
        // deploy painted the PREVIOUS build first and only swapped once the new
        // service worker had installed and claimed the page — so a screenshot of
        // the panel taken minutes after a successful deploy showed a UI from
        // before 30 August, three times running, over a server that was serving
        // the new bundle correctly.
        //
        // A screen that shows last week's app and looks completely fine is the
        // exact failure this codebase refuses everywhere else, and here it was
        // being introduced by the cache rather than by the data.
        //
        // The server is local and up ~always, so the network arm is the normal
        // one; the 4s timeout is what keeps the offline promise. `navigateFallback`
        // is removed because it is what preferred the cache.
        navigateFallbackDenylist: [/^\/api/], // never serve the SPA shell for API calls
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'saim-shell',
              // Falls back to the cached shell when the Pi is genuinely
              // unreachable — a kiosk showing chromium's own error page is
              // worse than one showing SAiM saying she cannot reach the brain.
              networkTimeoutSeconds: 4,
            },
          },
        ],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'SAiM',
        short_name: 'SAiM',
        description: 'SAiM — presence, work and mission control',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any', // iPad landscape + iPhone portrait
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true, // reachable over Tailscale on the Pi
    port: 5174,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
});
