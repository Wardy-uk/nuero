import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './SuggestedPeople.css';

/**
 * Names NEURO keeps meeting that have no People note.
 *
 * The nightly scan has found these since the day it shipped, written a report
 * and pushed "Review in Vault Audit" — onto a page with nothing to press.
 * Creating a note needed a curl against `POST /api/people-gap/apply`, and there
 * was no way at all to say a name was not a person, so "The Scrum Room" came
 * back every single night.
 *
 * ⚠ THREE RENDERINGS THAT MUST STAY DISTINCT, because conflating them is how a
 * broken scan comes to look like a settled roster:
 *   - couldn't read it  — the scan or the vault did not answer (amber, says why)
 *   - nothing to add    — it looked, and every name resolves
 *   - names to act on
 * A blank card is two of those facts and only one of them is good news.
 *
 * ⚠ THE VIEW IS SPLIT OUT AND EXPORTED. The container fetches in an effect,
 * which `renderToString` never runs — so a render test over the default export
 * can only ever assert the loading state, and every rule below would be pinned
 * by nothing. `SuggestedPeopleView` takes the payload as a prop and is what the
 * test actually renders.
 */

// ⚠ EVERY NAME WITHHELD IS ACCOUNTED FOR. A card showing three candidates out
// of eleven sightings with no word about the other eight is one nobody can
// check — "the filter ate a real colleague" would be indistinguishable from
// "nobody new turned up".
export function SuggestedPeopleView({
  scan, error, busy, note, roles, confirmAlias,
  onRetry, onRefresh, onRoleChange, onCreate, onIgnore, onUnignore, onProposeAlias, onCommitAlias, onCancelAlias,
  showOnce, onToggleOnce, showIgnored, onToggleIgnored,
}) {
  // ⚠ A SCAN THAT IS NOT `ok` IS AN ERROR, HERE TOO. The container already turns
  // one into `error`, but `status:'error'` arrives carrying `candidates: []` —
  // so a view that trusted its prop would take the empty-day branch and render
  // NOTHING over a vault it could not read. The guard is in the rendered thing
  // as well as in the fetch, because only the rendered thing can be pinned.
  const failed = error || (scan && scan.status !== 'ok' ? (scan.error || 'the scan did not answer') : '');

  if (failed) {
    return (
      <div className="sp sp-error">
        <div className="sp-title">Suggested people</div>
        <p className="sp-gap">
          I couldn&apos;t read the scan — {failed}. That is not a statement that everyone has a note.
        </p>
        <button className="sp-btn" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (!scan) return null; // first read in flight — a spinner here is noise

  const { candidates = [], belowThreshold = [], withheld = {}, ignored = [] } = scan;
  const nothingToDo = !candidates.length && !belowThreshold.length;

  // ⚠ A CLEAN, EMPTY CARD RENDERS NOTHING AT ALL. The roster settles for weeks
  // at a time, so a permanent panel whose only content is that there is nothing
  // in it is furniture on the page Nick opens to look at his team — the call
  // SAiM already makes about her "N noted already" line. The push only fires
  // when somebody NEW turns up, so he never arrives expecting this and finds it
  // missing.
  //
  // ⚠ It still renders whenever there is anything to DECIDE, including an
  // ignore list with nothing beside it: "ignored names never come back" is only
  // safe while Undo is reachable. And a DEGRADED read always renders, because
  // silence would be the third meaning of a blank card this exists to prevent.
  const degraded = scan.rosterKnown === false || scan.ignoreKnown === false;
  if (nothingToDo && !ignored.length && !degraded && !note && !confirmAlias) return null;

  const row = (c, seenOnce) => (
    <li key={c.name} className={`sp-row${seenOnce ? ' sp-row-faint' : ''}`}>
      <div className="sp-row-main">
        <span className="sp-name">{c.name}</span>
        <span className="sp-meta">
          {c.count} {c.count === 1 ? 'sighting' : 'sightings'} · {c.sources.join(', ')}
        </span>
        {/* A near miss is a QUESTION about an existing person, never a claim. */}
        {c.maybeAliasOf && <span className="sp-maybe">maybe {c.maybeAliasOf}</span>}
      </div>
      <div className="sp-row-actions">
        <input
          className="sp-role"
          type="text"
          placeholder="role (optional)"
          aria-label={`Role for ${c.name}`}
          value={roles?.[c.name] || ''}
          onChange={e => onRoleChange(c.name, e.target.value)}
        />
        <button className="sp-btn sp-btn-primary" disabled={busy === c.name} onClick={() => onCreate(c.name)}>
          Create
        </button>
        {c.maybeAliasOf && (
          <button className="sp-btn" disabled={busy === c.name} onClick={() => onProposeAlias(c.name, c.maybeAliasOf)}>
            Alias of {c.maybeAliasOf.split(' ')[0]}
          </button>
        )}
        <button className="sp-btn sp-btn-quiet" disabled={busy === c.name} onClick={() => onIgnore(c.name)}>
          Not a person
        </button>
      </div>
    </li>
  );

  return (
    <div className="sp">
      <div className="sp-head">
        <span className="sp-title">Suggested people</span>
        {candidates.length > 0 && <span className="sp-count">{candidates.length}</span>}
        <button className="sp-btn sp-btn-quiet sp-refresh" onClick={onRefresh}>Refresh</button>
      </div>

      {/* A degraded read must never render as a clean one. */}
      {scan.rosterKnown === false && (
        <p className="sp-gap">
          The alias map couldn&apos;t be read, so someone already mapped to a colleague may be listed below as new.
        </p>
      )}
      {scan.ignoreKnown === false && (
        <p className="sp-gap">
          The ignore list couldn&apos;t be read, so names you have already dismissed may be listed below.
        </p>
      )}

      {note && <p className="sp-note">{note}</p>}

      {/* ⚠ The confirm quotes the SERVER's line verbatim. This edits a note Nick
          maintains by hand and there is no undo from a card, so the formatting
          is never reconstructed here — a second copy is a confirm free to show
          something other than what gets written. */}
      {confirmAlias && (
        <div className="sp-confirm">
          <p className="sp-confirm-lead">
            Add <strong>{confirmAlias.alias}</strong> as an alias of <strong>{confirmAlias.person}</strong>?
          </p>
          <p className="sp-confirm-what">This line goes into <code>{confirmAlias.path}</code>:</p>
          <pre className="sp-confirm-line">{confirmAlias.line}</pre>
          <div className="sp-confirm-actions">
            <button className="sp-btn sp-btn-primary" onClick={onCommitAlias}>Write it</button>
            <button className="sp-btn" onClick={onCancelAlias}>Cancel</button>
          </div>
        </div>
      )}

      {nothingToDo
        ? <p className="sp-empty">Nothing to add — every name NEURO saw resolves to someone.</p>
        : <ul className="sp-list">{candidates.map(c => row(c, false))}</ul>}

      {belowThreshold.length > 0 && (
        <div className="sp-fold">
          <button className="sp-fold-btn" onClick={onToggleOnce}>
            {showOnce ? '▾' : '▸'} Seen once ({belowThreshold.length})
          </button>
          {showOnce && <ul className="sp-list">{belowThreshold.map(c => row(c, true))}</ul>}
        </div>
      )}

      {ignored.length > 0 && (
        <div className="sp-fold">
          <button className="sp-fold-btn" onClick={onToggleIgnored}>
            {showIgnored ? '▾' : '▸'} Ignored ({ignored.length})
          </button>
          {showIgnored && (
            <ul className="sp-list sp-list-ignored">
              {ignored.map(e => (
                <li key={e.name} className="sp-row sp-row-faint">
                  <div className="sp-row-main"><span className="sp-name">{e.name}</span></div>
                  <div className="sp-row-actions">
                    <button className="sp-btn sp-btn-quiet" onClick={() => onUnignore(e.name)}>Undo</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* What was filtered out, and why. A silent filter is one nobody can check. */}
      {withheld.notPeople?.length > 0 && (
        <p className="sp-withheld">
          Not shown, not a person: {withheld.notPeople.map(n => `${n.name} (${n.reason})`).join(', ')}
        </p>
      )}
    </div>
  );
}

export default function SuggestedPeople({ onCreated }) {
  const [scan, setScan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);      // name currently being acted on
  const [roles, setRoles] = useState({});      // name -> optional role typed on the row
  const [confirmAlias, setConfirmAlias] = useState(null); // { person, alias, line, path }
  const [showOnce, setShowOnce] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    setError('');
    fetch(apiUrl('/api/people-gap'))
      .then(r => r.json())
      .then(d => {
        // ⚠ An error payload is an ERROR, never an empty list. `status:'error'`
        // comes back carrying `candidates: []`, which rendered straight would
        // read as "everyone already has a note".
        if (d?.status !== 'ok') { setScan(null); setError(d?.error || 'the scan did not answer'); return; }
        setScan(d);
      })
      .catch(e => { setScan(null); setError(e.message || 'could not reach NEURO'); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (name, fn) => {
    setBusy(name);
    setNote('');
    try { await fn(); } finally { setBusy(null); }
  };

  const post = (path, body) => fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json().catch(() => ({})));

  const create = (name) => act(name, async () => {
    const role = (roles[name] || '').trim();
    // minSightings 1 so a name from the seen-once fold is creatable too —
    // pressing Create on a row you can SEE is a stronger signal than the
    // threshold, which only decides what to offer unprompted.
    const j = await post('/api/people-gap/apply', { names: [name], role: role || undefined, minSightings: 1 });
    if (j.status !== 'ok' || !j.created?.length) {
      setNote(`${name} — not created: ${j.failed?.[0]?.error || j.error || 'nothing was written'}`);
      return;
    }
    setNote(`${name} — note created.`);
    onCreated?.(name);
    load();
  });

  const ignore = (name) => act(name, async () => {
    const j = await post('/api/people-gap/ignore', { name });
    if (j.status !== 'ok') { setNote(`${name} — not ignored: ${j.error || 'unknown reason'}`); return; }
    load();
  });

  const unignore = (name) => act(name, async () => {
    await post('/api/people-gap/unignore', { name });
    load();
  });

  const proposeAlias = (name, person) => act(name, async () => {
    const j = await post('/api/people-gap/alias', { person, alias: name, dryRun: true });
    if (j.status === 'refused') { setNote(`Can't do that — ${j.reason}`); return; }
    if (j.already) { setNote(`${person} already has that alias.`); load(); return; }
    if (j.status !== 'dry-run') { setNote(`Couldn't work out the change: ${j.error || 'unknown reason'}`); return; }
    setConfirmAlias({ person, alias: name, line: j.line, path: j.path });
  });

  const commitAlias = () => act(confirmAlias.alias, async () => {
    const j = await post('/api/people-gap/alias', { person: confirmAlias.person, alias: confirmAlias.alias });
    setConfirmAlias(null);
    if (j.status === 'refused') { setNote(`Can't do that — ${j.reason}`); return; }
    if (j.status !== 'ok') { setNote(`Not written: ${j.error || 'unknown reason'}`); return; }
    setNote(`Added to ${j.person} — ${j.alias}.`);
    load();
  });

  return (
    <SuggestedPeopleView
      scan={scan} error={error} busy={busy} note={note} roles={roles} confirmAlias={confirmAlias}
      onRetry={load} onRefresh={load}
      onRoleChange={(name, value) => setRoles(p => ({ ...p, [name]: value }))}
      onCreate={create} onIgnore={ignore} onUnignore={unignore}
      onProposeAlias={proposeAlias} onCommitAlias={commitAlias} onCancelAlias={() => setConfirmAlias(null)}
      showOnce={showOnce} onToggleOnce={() => setShowOnce(v => !v)}
      showIgnored={showIgnored} onToggleIgnored={() => setShowIgnored(v => !v)}
    />
  );
}
