import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { declarePlatform } from '../../shared-ui/presentation/platform.mjs';

// Build 12: this build is only ever a wall or tablet screen read from across the
// room. Declared here, once — the shared views never guess it.
declarePlatform('kiosk');
import './App.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
