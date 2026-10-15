import { useState } from 'react';
import { apiFetch } from '../src/api';
import Dock from '../alt-v2/Dock';
import ManifestView from './ManifestView.jsx';
import { manifest, linkHref } from './manifest.mjs';

// The SAiM page of the Alt A/B release (alt-v3, 16 Oct 2026): the adapter's
// view-model over the live /api/canonical/now, with every control routed through
// the Alt shell's existing write paths (App.onAct, the laptop open, Ask/Capture).
//
// The one write this page adds is Nick's own answer to "What will you use?" —
// POST /api/task-activity/:taskId, sent only when he presses an option, and said
// saved only when NEURO says so. Nothing here infers an activity.

export function choiceError(res) {
  if (!res) return 'NEURO didn’t answer — nothing was saved.';
  if (res.ok === false) return `Not saved — ${res.error || 'NEURO refused it'}.`;
  return null;
}

export default function LiveSaim({ canonical, error, busy, onAct, run, onDeskOpen, deskStates, neuroUrl }) {
  const [choiceNote, setChoiceNote] = useState(null);

  if (!canonical) {
    return (
      <div className="wk mf mf--blind">
        <p className="wk__presence">SAiM</p>
        <p className="mf__err">{error ? `I can’t reach NEURO — ${error}. This isn’t an all-clear.` : 'Reading the day…'}</p>
      </div>
    );
  }

  const vm = manifest(canonical);
  const onChoose = (taskId, choice) => run(async () => {
    setChoiceNote(null);
    const res = await apiFetch(`/api/task-activity/${encodeURIComponent(taskId)}`, { method: 'POST', body: JSON.stringify({ choice, via: 'saim' }) });
    const bad = choiceError(res);
    if (bad) throw new Error(bad);
    setChoiceNote(choice === 'unsure' ? 'Saved — you’re not sure yet, so SAiM points you at the task in NEURO.' : 'Saved — SAiM will use that for this task.');
  });

  return (
    <>
      {error && <p className="wk__stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}
      <ManifestView
        v={vm}
        live={{
          onAct, onDeskOpen, deskStates, busy, onChoose, choiceNote,
          linkFor: (href) => linkHref(neuroUrl, href),
          dock: <Dock variant="wk" utterances={canonical.utterances} onSay={onAct} />,
        }}
      />
    </>
  );
}

/** The field drive the adapter approved, per SAiM's rule — or blind before the first read. */
export const driveFor = (canonical) => (canonical ? manifest(canonical).drive : { degraded: true });
