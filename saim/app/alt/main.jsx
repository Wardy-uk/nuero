import React from 'react';
import { createRoot } from 'react-dom/client';
import AltApp from './AltApp.jsx';

// SAiM Alt entry. Separate from `src/main.jsx` on purpose: the control build
// never imports anything under `alt/`, so this treatment cannot change it.
// No service worker is registered here — see AltApp.jsx.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AltApp />
  </React.StrictMode>
);
