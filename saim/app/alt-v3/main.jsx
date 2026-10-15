import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../alt-v2/App.jsx';
import LiveSaim, { driveFor } from '../alt-v2-manifest/LiveSaim.jsx';
import '../alt-v2/working.css';
import '../alt-v2-manifest/manifest.css';

// SAiM Alt v3 — the policy-driven desktop A/B release (16 Oct 2026). The Alt v2
// shell (PIN, the one canonical read, Ask/Capture, lifecycle writes, laptop open,
// Now / Briefing / Review / Capture / Controls) with SAiM's page rendered by the
// adapter over neuro-candidates-v2, saim-attention-v2 and saim-handoff-v1.
//
// ⚠ Isolation, as v2: the control never imports this folder, no service worker
//   is registered (push stays on the control during the A/B run), and the host
//   guard (.env.alt3) refuses to run anywhere but the treatment's hosts.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App renderSaim={(p) => <LiveSaim {...p} />} driveFor={driveFor} footer="SAiM Alt · policy-driven desktop (A/B)" />
  </React.StrictMode>
);
