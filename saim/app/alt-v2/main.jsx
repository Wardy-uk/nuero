import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// SAiM Alt v2 entry. Separate from `src/main.jsx` and from `alt/` on purpose:
// the control build never imports anything under `alt-v2/`, and no service
// worker is registered here (push stays on the control during the A/B run).
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
