import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { moveHostIfNeeded } from './hostMove';

// On the old misspelt host, send any waiting captures and move to the new one
// before rendering; anywhere else this resolves false at once.
moveHostIfNeeded().catch(() => false).then((leaving) => {
  if (leaving) return;
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
