import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api';
import './PlaudTranscriptsPanel.css';

/**
 * PLAUD transcripts (14 Oct 2026) — every transcript in the vault, whether it has
 * a summary, and two actions:
 *
 * - Repull: re-fetches the transcript from PLAUD and rewrites the SAME file (a backup
 *   is taken first). This is how speaker names added in PLAUD after the sync reach
 *   the vault. A summary is pulled only when the transcript has none.
 * - Archive: the "delete". Moves the note under Archive/ — nothing is erased, and the
 *   sync will not pull it back.
 */

async function callJson(path, options) {
  const res = await apiFetch(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const post = (path, body) => callJson(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unnamed', label: 'Unnamed speakers' },
  { id: 'none', label: 'No summary' },
  { id: 'archived', label: 'Summary archived' },
  { id: 'problem', label: 'Empty / repeated' },
];

const basename = (p) => String(p || '').split('/').pop().replace(/\.md$/, '');

export function speakerLine(row) {
  if (row.stub) return 'No transcript text';
  if (!row.speakers.length) return 'No speakers found';
  const named = row.speakers.length - row.unnamed.length;
  if (!row.unnamed.length) return `${row.speakers.length} speaker${row.speakers.length === 1 ? '' : 's'}, all named`;
  return `${named} of ${row.speakers.length} named · ${row.unnamed.join(', ')}`;
}

export function summaryLine(row) {
  if (row.summaryStatus === 'present') return row.summaries.length > 1 ? `${row.summaries.length} summaries` : basename(row.summaries[0]);
  if (row.summaryStatus === 'archived') return 'Summary archived';
  return 'No summary';
}

export function matchesFilter(row, filter) {
  if (filter === 'unnamed') return row.unnamed.length > 0;
  if (filter === 'none') return row.summaryStatus === 'none';
  if (filter === 'archived') return row.summaryStatus === 'archived';
  if (filter === 'problem') return row.stub || row.repeated;
  return true;
}

export function TranscriptRow({ row, busy, outcome, onRefresh, onArchive }) {
  const [confirming, setConfirming] = useState(false);
  const [withSummaries, setWithSummaries] = useState(false);
  const [pullArchived, setPullArchived] = useState(false);

  return (
    <li className="pt-row">
      <div className="pt-row__main">
        <div className="pt-row__title">
          <span className="pt-row__date">{row.date || 'undated'}</span>
          <span className="pt-row__name" title={row.path}>{row.title}</span>
        </div>
        <div className="pt-row__meta">
          <span className={`pt-chip ${row.unnamed.length || row.stub ? 'pt-chip--warn' : 'pt-chip--ok'}`}>{speakerLine(row)}</span>
          <span className={`pt-chip ${row.summaryStatus === 'present' ? 'pt-chip--ok' : 'pt-chip--muted'}`} title={row.summaries.join('\n') || row.archivedSummaries.join('\n')}>
            {summaryLine(row)}
          </span>
          {row.repeated && <span className="pt-chip pt-chip--warn">Repeated lines</span>}
          {row.duplicateTranscripts.length > 0 && <span className="pt-chip pt-chip--muted" title={row.duplicateTranscripts.join('\n')}>+{row.duplicateTranscripts.length} other transcript</span>}
        </div>
        {outcome && <div className={`pt-row__outcome ${outcome.error ? 'pt-row__outcome--bad' : ''}`}>{outcome.text}</div>}
      </div>

      <div className="pt-row__actions">
        {!confirming && (
          <>
            {row.summaryStatus === 'archived' && (
              <label className="pt-check" title="Its summary was archived. Tick to pull a fresh one as well.">
                <input type="checkbox" checked={pullArchived} onChange={(e) => setPullArchived(e.target.checked)} /> new summary
              </label>
            )}
            <button className="pt-btn" disabled={Boolean(busy)} onClick={() => onRefresh(row, { pullSummary: pullArchived })}>
              {busy === row.path ? 'Repulling…' : 'Repull'}
            </button>
            <button className="pt-btn pt-btn--quiet" disabled={Boolean(busy)} onClick={() => setConfirming(true)}>Archive</button>
          </>
        )}
        {confirming && (
          <div className="pt-confirm">
            <span>Move to Archive/?</span>
            {row.summaries.length > 0 && (
              <label className="pt-check">
                <input type="checkbox" checked={withSummaries} onChange={(e) => setWithSummaries(e.target.checked)} />
                and its summary
              </label>
            )}
            <button className="pt-btn pt-btn--danger" onClick={() => { setConfirming(false); onArchive(row, { withSummaries }); }}>Archive</button>
            <button className="pt-btn pt-btn--quiet" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        )}
      </div>
    </li>
  );
}

export default function PlaudTranscriptsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);
  const [outcomes, setOutcomes] = useState({});

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await callJson('/api/plaud/transcripts'));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const note = (p, text, isError = false) => setOutcomes((o) => ({ ...o, [p]: { text, error: isError } }));

  const refresh = async (row, opts) => {
    setBusy(row.path);
    note(row.path, 'Asking PLAUD… this can take a minute.');
    try {
      const r = await post('/api/plaud/transcripts/refresh', { path: row.path, pullSummary: opts.pullSummary === true });
      const unnamed = r.after.unnamed.length ? `still unnamed: ${r.after.unnamed.join(', ')}` : 'all speakers named';
      const sum = r.summary.status === 'pulled' ? ` · summary pulled: ${basename(r.summary.path)}`
        : r.summary.status === 'none-in-plaud' ? ' · PLAUD has no summary for it' : '';
      await load();
      note(row.path, `Rewritten (${r.after.segments} lines) — ${unnamed}${sum}. Backup: ${r.backup}`);
    } catch (e) {
      note(row.path, `Not changed — ${e.message}`, true);
    } finally {
      setBusy(null);
    }
  };

  const archive = async (row, opts) => {
    setBusy(row.path);
    try {
      const r = await post('/api/plaud/transcripts/archive', { path: row.path, withSummaries: opts.withSummaries === true });
      await load();
      const left = r.summariesLeft.length ? ` Its summary stays in place: ${r.summariesLeft.map(basename).join(', ')}.` : '';
      setOutcomes((o) => ({ ...o, __archived: { text: `Archived ${r.moved.length} note${r.moved.length === 1 ? '' : 's'} → ${r.moved[0].to}.${left}` } }));
    } catch (e) {
      note(row.path, `Not archived — ${e.message}`, true);
    } finally {
      setBusy(null);
    }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.transcripts.filter((r) => matchesFilter(r, filter)
      && (!q || r.title.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || (r.date || '').includes(q)));
  }, [data, filter, query]);

  return (
    <div className="pt">
      <header className="pt__head">
        <h2 className="pt__title">PLAUD transcripts</h2>
        <p className="pt__lede">
          Every transcript in the vault. <strong>Repull</strong> rewrites the same file from PLAUD (backed up first),
          so speaker names you add in PLAUD later land here; it pulls a summary only if there is none.
          <strong> Archive</strong> moves the note under Archive/ — nothing is erased, and the sync won't pull it back.
        </p>
      </header>

      {error && <div className="pt__error">Couldn't read the transcripts — {error}. This is not an empty list.</div>}
      {!data && !error && <div className="pt__loading">Reading the vault…</div>}

      {data && (
        <>
          <div className="pt__counts">
            <div className="pt-count"><span>{data.counts.transcripts}</span>transcripts</div>
            <div className="pt-count"><span>{data.counts.withSummary}</span>with a summary</div>
            <div className="pt-count"><span>{data.counts.noSummary}</span>no summary</div>
            <div className="pt-count"><span>{data.counts.unnamedSpeakers}</span>unnamed speakers</div>
          </div>
          <p className="pt__aside">
            {data.counts.summaryArchived} with an archived summary · {data.counts.archivedTranscripts} transcripts already archived
            · {data.counts.summariesWithoutTranscript} recordings with a summary and no transcript
            {data.busy && ' · a PLAUD sync is running, so Repull will wait'}
          </p>
          {outcomes.__archived && <div className="pt__notice">{outcomes.__archived.text}</div>}

          <div className="pt__tools">
            <div className="pt__filters">
              {FILTERS.map((f) => (
                <button key={f.id} className={`pt-filter ${filter === f.id ? 'pt-filter--on' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            <input className="pt__search" placeholder="Search title, date or path" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>

          {rows.length === 0
            ? <div className="pt__empty">Nothing matches.</div>
            : (
              <ul className="pt__list">
                {rows.map((row) => (
                  <TranscriptRow key={row.path} row={row} busy={busy} outcome={outcomes[row.path]} onRefresh={refresh} onArchive={archive} />
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  );
}
