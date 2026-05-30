import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the frontend and proxies the defined runtime path (/api)
// to the SARA backend. Prod: `vite build` emits dist/, which the backend serves.
const BACKEND = process.env.SARA_BACKEND_URL || 'http://localhost:3005';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable over Tailscale on the Pi
    port: 5174,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
});
