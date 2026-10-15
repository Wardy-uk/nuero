import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SAiM Alt v2 — LOCAL desktop adapter (read-only). Dev server only:
//
//   npm run dev:alt2-manifest   →  http://127.0.0.1:5188
//
// ⚠ Isolation: its own root (`alt-v2-manifest/`), its own env file
//   (`.env.alt2-manifest`, `--mode alt2-manifest`), bound to 127.0.0.1 only
//   (never `host: true`), and NO build target is wired to any deploy. The
//   normal Alt v2 config and its output are untouched.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.join(HERE, '..', '..', 'shared').replace(/\\/g, '/');

// The dev server serves `shared/*.cjs` (outside node_modules) as-is, and a
// browser cannot import CommonJS — the production build converts it with
// Rollup's commonjs plugin, the dev server does not. This wraps those files as
// ESM in DEV only: each static `require('./x.cjs')` becomes a hoisted import and
// `module.exports` the default export. Only this preview's config uses it.
function sharedCjsAsEsm() {
  return {
    name: 'alt-manifest-shared-cjs',
    apply: 'serve',
    transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.startsWith(SHARED) || !file.endsWith('.cjs')) return null;
      const imports = [];
      const body = code.replace(/require\((['"])(\.\/[^'"]+\.cjs)\1\)/g, (_m, _q, spec) => {
        const name = `__cjs${imports.length}`;
        imports.push(`import ${name} from '${spec}';`);
        return name;
      });
      return { code: `${imports.join('\n')}\nconst module = { exports: {} }; const exports = module.exports;\n${body}\nexport default module.exports;\n`, map: null };
    },
  };
}

export default defineConfig({
  root: path.join(HERE, 'alt-v2-manifest'),
  envDir: HERE,
  publicDir: path.join(HERE, 'alt-v2-manifest', 'public'),
  plugins: [sharedCjsAsEsm(), react()],
  build: { outDir: path.join(HERE, 'dist-alt2-manifest'), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    fs: { allow: [path.join(HERE, '..', '..')] },
    proxy: {
      // The local read-only harness (backend/scripts/local-readonly-server.js), never the Pi.
      '/api': { target: 'http://127.0.0.1:3011', changeOrigin: true },
    },
  },
});
