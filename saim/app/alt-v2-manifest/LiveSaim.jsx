import { useState } from 'react';
import { apiFetch } from '../src/api';
import Dock from '../alt-v2/Dock';
import ManifestView from './ManifestView.jsx';
import { manifest, linkHref } from './manifest.mjs';
import PreparedMove from '../src/components/PreparedMove';
import { preparedPlacement } from './prepared.mjs';

// The SAiM page of the Alt A/B release (alt-v3, 16 Oct 2026): the adapter's
// view-model over the live /api/canonical/now, with every control routed through
// the Alt shell's existing write paths (App.onAct, the laptop open, Ask/Capture).
//
// The one write this page adds is Nick's own answer to "What will you use?" —
// POST /api/task-activity/:taskId, sent only when he presses an option, and said
// saved only when NEURO says so. Nothing here infers an activity.

/** A failed refresh in plain words: what is still showing, and from when. Never the raw error. */
export function staleLine(at) {
  const d = at ? new Date(at) : null;
  const hhmm = d && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
  return hhmm ? `I couldn’t refresh just now — this is what I saw at ${hhmm}.` : 'I couldn’t refresh just now — this is the last thing I saw.';
}

export function choiceError(res) {
  if (!res) return 'NEURO didn’t answer — nothing was saved.';
  if (res.ok === false) return `Not saved — ${res.error || 'NEURO refused it'}.`;
  return null;
}

export default function LiveSaim({ canonical, error, at = null, busy, onAct, run, onDeskOpen, deskStates, neuroUrl, debug = false, onOpenAuthority = null }) {
  const [choiceNote, setChoiceNote] = useState(null);
  // What kind of prepared moment the shared component is showing (its onMoment).
  const [moment, setMoment] = useState(null);

  if (!canonical) {
    return (
      <div className="wk mf mf--blind">
        <p className="wk__presence">SAiM</p>
        <p className="mf__err">{error ? `I can’t reach NEURO right now, so I can’t see your day. This isn’t an all-clear.${debug ? ` (${error})` : ''}` : 'Reading the day…'}</p>
      </div>
    );
  }

  // SAiM's prepared move: the SHARED component (its own read, request, confirm
  // and receipt over the existing APIs); this page decides only where it sits.
  const place = preparedPlacement(manifest(canonical), moment);
  const vm = place.vm;
  // "Open what SAiM may do" on the boundary goes to Alt's own Controls → What SAiM may do.
  const prepared = place.show ? <PreparedMove onMoment={setMoment} onOpenAuthority={onOpenAuthority} heldFolded /> : null;
  // Folded behind its entry whenever it does not lead (and once its moment is known).
  const preparedFold = Boolean(moment) && !place.leads;
  const onChoose = (taskId, choice) => run(async () => {
    setChoiceNote(null);
    const res = await apiFetch(`/api/task-activity/${encodeURIComponent(taskId)}`, { method: 'POST', body: JSON.stringify({ choice, via: 'saim' }) });
    const bad = choiceError(res);
    if (bad) throw new Error(bad);
    setChoiceNote(choice === 'unsure' ? 'Saved — you’re not sure yet, so SAiM points you at the task in NEURO.' : 'Saved — SAiM will use that for this task.');
  });

  return (
    <>
      {error && <p className="wk__stale" role="status">{staleLine(at)}{debug ? ` (${error})` : ''}</p>}
      <ManifestView
        v={vm}
        live={{
          onAct, onDeskOpen, deskStates, busy, onChoose, choiceNote, debug,
          prepared, preparedLeads: place.leads, preparedFold, preparedEntry: (moment && moment.entry) || null,
          linkFor: (href) => linkHref(neuroUrl, href),
          dock: <Dock variant="wk" utterances={canonical.utterances} onSay={onAct} />,
        }}
      />
    </>
  );
}

/** The field drive the adapter approved, per SAiM's rule — or blind before the first read. */
export const driveFor = (canonical) => (canonical ? manifest(canonical).drive : { degraded: true });
