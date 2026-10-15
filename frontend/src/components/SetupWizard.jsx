import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './SetupWizard.css';

// Set up — what has not been set up that NEURO needs, one step at a time.
//
// Every status is EVIDENCE from `/api/setup` (a sense that reported, a key that
// is set), never a box ticked here. The one thing this screen can record is
// "not needed", which skips an item and is reversible. Items NEURO cannot see
// from the Pi (a phone permission, a laptop shortcut) say which device checks
// them: the iOS Setup screen, or desktop-agent/setup.ps1 on Windows.
//
// One next step leads, because the difficulty is starting, not knowing — the
// whole list is below it for when he wants the shape of it.

async function api(path, options = {}) {
  const res = await apiFetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const STATUS_WORD = {
  done: 'Done',
  todo: 'To do',
  attention: 'Needs a look',
  unknown: 'Check on the device',
  skipped: 'Not needed',
};
const WHERE_WORD = {
  desktop: 'here, in NEURO',
  pi: 'in a shell on the Pi',
  windows: 'on the Windows laptop',
  mac: 'on the Mac',
  iphone: 'on the iPhone',
  tablet: 'on the study tablet',
};

function CopyCommand({ command }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup__cmd">
      <code>{command}</code>
      <button
        type="button"
        onClick={async () => {
          try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select it by hand */ }
        }}
      >{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function Fix({ item, onNavigate }) {
  const fix = item.fix || {};
  return (
    <div className="setup__fix">
      {fix.where && <p className="setup__where">Done {WHERE_WORD[fix.where] || fix.where}.</p>}
      {Array.isArray(fix.steps) && fix.steps.length > 0 && (
        <ol className="setup__steps">{fix.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      )}
      {fix.command && <CopyCommand command={fix.command} />}
      {fix.open && onNavigate && (
        <button type="button" className="setup__go" onClick={() => onNavigate(fix.open)}>Take me there</button>
      )}
    </div>
  );
}

export default function SetupWizard({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [surface, setSurface] = useState('all');
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api('/api/setup');
      setState({ loading: false, error: null, data });
    } catch (e) {
      // A failed read is not "everything is set up".
      setState((s) => ({ loading: false, error: e.message, data: s.data }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const skip = async (id, undo = false) => {
    try { await api(`/api/setup/skip/${encodeURIComponent(id)}`, { method: undo ? 'DELETE' : 'POST' }); } catch { /* re-read shows the truth */ }
    load();
  };

  const data = state.data;
  if (!data) {
    return (
      <div className="setup">
        <h2 className="setup__title">Set up</h2>
        <p className="setup__muted">{state.error ? `Couldn’t check: ${state.error}. This is not “all set up”.` : 'Checking…'}</p>
      </div>
    );
  }

  const next = data.items.find((i) => i.id === data.nextStep) || null;
  const needed = data.items.filter((i) => i.need !== 'optional');
  const neededDone = needed.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  const shown = data.items.filter((i) => surface === 'all' || i.surface === surface);

  return (
    <div className="setup">
      <header className="setup__head">
        <div>
          <h2 className="setup__title">Set up</h2>
          <p className="setup__muted">
            {data.complete ? 'Everything NEURO needs is set up.' : `${neededDone} of ${needed.length} needed things done.`}
            {' '}Judged from what NEURO has actually seen, not from ticks.
          </p>
        </div>
        <button type="button" className="setup__again" onClick={load} disabled={state.loading}>
          {state.loading ? 'Checking…' : 'Check again'}
        </button>
      </header>
      {state.error && <p className="setup__warn">That re-check failed — this is the last read.</p>}

      {next && (
        <section className="setup__next" aria-label="Next step">
          <span className="setup__tag">Next step · {data.surfaces.find((s) => s.id === next.surface)?.label}</span>
          <h3 className="setup__nexttitle">{next.title}</h3>
          <p className="setup__why">{next.why}</p>
          <p className="setup__evidence">{next.evidence}</p>
          <Fix item={next} onNavigate={onNavigate} />
          <div className="setup__actions">
            <button type="button" className="setup__again" onClick={load}>I’ve done it — check</button>
            {next.need !== 'required' && (
              <button type="button" className="setup__quiet" onClick={() => skip(next.id)}>Not needed</button>
            )}
          </div>
        </section>
      )}

      <nav className="setup__surfaces" aria-label="Devices">
        <button type="button" className={surface === 'all' ? 'on' : ''} onClick={() => setSurface('all')}>All</button>
        {data.surfaces.map((s) => (
          <button key={s.id} type="button" className={surface === s.id ? 'on' : ''} onClick={() => setSurface(s.id)}>
            {s.label}
            <span className="setup__count">{s.done}/{s.total}</span>
          </button>
        ))}
      </nav>

      <ul className="setup__list">
        {shown.map((i) => (
          <li key={i.id} className={`setup__item setup__item--${i.status}`}>
            <button type="button" className="setup__row" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>
              <span className={`setup__pill setup__pill--${i.status}`}>{STATUS_WORD[i.status] || i.status}</span>
              <span className="setup__rowtitle">{i.title}</span>
              <span className="setup__need">{i.need}</span>
            </button>
            {open === i.id && (
              <div className="setup__detail">
                <p className="setup__why">{i.why}</p>
                <p className="setup__evidence">{i.evidence}</p>
                {i.status !== 'done' && <Fix item={i} onNavigate={onNavigate} />}
                {i.status === 'skipped'
                  ? <button type="button" className="setup__quiet" onClick={() => skip(i.id, true)}>Actually, I need this</button>
                  : (i.status !== 'done' && i.need !== 'required' && (
                    <button type="button" className="setup__quiet" onClick={() => skip(i.id)}>Not needed</button>
                  ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {(data.reports || []).length > 0 && (
        <p className="setup__muted setup__reports">
          Device checks received: {data.reports.map((r) => `${r.host} (${r.platform}${r.app ? ` ${r.app}` : ''}, ${String(r.at).slice(0, 10)})`).join(' · ')}
        </p>
      )}
    </div>
  );
}
