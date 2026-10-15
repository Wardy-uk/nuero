import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../shared-ui/Lit.css';
import '../src/App.css';
import '../alt-v2/v2.css';
import '../alt-v2/working.css';
import './manifest.css';
import ManifestApp from './ManifestApp.jsx';

// SAiM Alt v2 — LOCAL desktop adapter entry (15 Oct 2026). Its own root, config
// and env file: the normal Alt v2 build (`alt-v2/`, `vite.config.alt2.js`) never
// sees this folder, so that build stays byte-identical.
//
// ⚠ It refuses to run unless the flag is on AND the page is on this machine.
const LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const ON = (import.meta.env || {}).VITE_ALT_MANIFEST === '1';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {ON && LOCAL ? <ManifestApp /> : (
      <p style={{ fontFamily: 'system-ui', margin: '20vh auto', maxWidth: 560, color: '#ccc' }}>
        This is a local-only preview. It runs only on localhost with VITE_ALT_MANIFEST=1.
      </p>
    )}
  </React.StrictMode>,
);
