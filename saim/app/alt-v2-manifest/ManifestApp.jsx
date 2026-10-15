import { useEffect, useState } from 'react';
import Shell from '../alt-v2/Shell.jsx';
import ManifestView from './ManifestView.jsx';
import { manifest } from './manifest.mjs';

// Local-only, read-only desktop adapter. It READS /api/canonical/now (three
// contracts) and renders the adapter's view-model in the approved frame. It
// writes nothing, launches nothing and approves nothing.
//
//   ?fixture=<name>  render a generated payload from ./fixtures/<name>.json
//                    (the golden states) instead of the live local backend.

const ENV = import.meta.env || {};
const POLL_MS = 60000;
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

async function readPayload(fixture) {
  if (fixture) {
    if (!/^[a-z0-9-]{1,60}$/.test(fixture)) throw new Error('not a fixture name');
    const r = await fetch(`/fixtures/${fixture}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`fixture ${fixture} not found`);
    return r.json();
  }
  const r = await fetch('/api/canonical/now?surface=work-desktop', { headers: { 'X-NEURO-PIN': ENV.VITE_LOCAL_PIN || '' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`the local backend answered ${r.status}`);
  return r.json();
}

export default function ManifestApp() {
  const fixture = new URLSearchParams(window.location.search).get('fixture');
  const [state, setState] = useState({ vm: null, error: null, at: null });
  useEffect(() => {
    let live = true;
    const load = () => readPayload(fixture)
      .then((payload) => { if (live) setState({ vm: manifest(payload), error: null, at: new Date() }); })
      .catch((e) => { if (live) setState((s) => ({ ...s, error: e.message || 'unreachable' })); });
    load();
    const t = fixture ? null : setInterval(load, POLL_MS);
    return () => { live = false; if (t) clearInterval(t); };
  }, [fixture]);

  const vm = state.vm;
  const drive = vm ? vm.drive : { degraded: true };
  const updated = state.at ? `${fixture ? `Fixture ${fixture}` : 'Read'} ${hhmm(state.at)}` : 'Not read yet';
  return (
    <Shell active="saim" drive={drive} footer="SAiM Alt · local adapter (read-only)" updated={updated} onGo={() => {}} onLock={null}
      marker={<span className="mf__local" title="Local-only build — not deployed anywhere">Local · read-only</span>}>
      {state.error && !vm && <p className="mf__err">Couldn’t read the local backend ({state.error}). This isn’t an all-clear.</p>}
      {state.error && vm && <p className="wk__stale" role="status">Couldn’t refresh — {state.error}. Showing the last read.</p>}
      {vm && <ManifestView v={vm} />}
    </Shell>
  );
}
