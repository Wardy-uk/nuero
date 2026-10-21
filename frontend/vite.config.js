import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveBuildLabel, buildVersionPlugin } from '../shared/build-version.mjs';

export default defineConfig({
  // Build id baked in + version.json beside the app: the status bar turns
  // amber when the Pi is serving a newer build than the open tab.
  plugins: [react(), buildVersionPlugin(resolveBuildLabel())],
  // The Keep my word card mounts SAiM's own governed save step (saim/app's
  // PreparedMove + Authority). saim/app carries its own React 19; ONE React for
  // the page, or its hooks throw "invalid hook call".
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
