import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Dev: Vite serves the frontend and proxies the defined runtime path (/api)
// to the SARA backend. Prod: `vite build` emits dist/, which the backend serves.
const BACKEND = process.env.SARA_BACKEND_URL || 'http://localhost:3005';

export default defineConfig({
  plugins: [
    react(),
    // PWA: makes SARA installable on iPad / iPhone (and any device). autoUpdate keeps a
    // freshly-deployed build from getting stuck behind a stale service-worker cache.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/], // never serve the SPA shell for API calls
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'SARA',
        short_name: 'SARA',
        description: 'SARA — presence, work and mission control',
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
