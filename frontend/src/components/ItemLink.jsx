import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import PreparedActions from './PreparedActions';
import MeetingPrep from './MeetingPrep';
import './ItemLink.css';

/**
 * An exact-item deep link opened in NEURO: `?item=<kind>:<id>` (the client form
 * of `neuro:?item=…`, shared/neuro-links.cjs). It asks GET /api/links/resolve
 * and shows THAT record — or says plainly why it can't. It never drops you on a
 * broad page or list and lets that pass for the thing you were sent to.
 *
 * Where NEURO has a screen that works on exactly one record, that screen is
 * shown scoped to it: one prepared action (with its real Approve/Edit/Reject),
 * one meeting's prep. Elsewhere the record is shown here, with a way on to the
 * page it lives in labelled as exactly that — "Find it in …", not "Open it".
 */

const KIND_WORD = { task: 'task', action: 'action', email: 'email', hazard: 'hazard', 'meeting-prep': 'meeting' };
const STATUS_HEADING = {
  invalid: 'This link isn’t valid',
  missing: 'NEURO can’t find this',
  stale: 'This is no longer live',
  unreadable: 'NEURO couldn’t check this right now',
  unauthorised: 'NEURO needs your PIN to open this',
  error: 'NEURO couldn’t open this link',
};

/** `neuro:?item=<kind>:<id>` → `<kind>:<id>`, or null. */
export function itemFromNeuroHref(href) {
  const m = /^neuro:\?item=([^&]+)$/.exec(String(href || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

const fmt = (iso) => {
  if (!iso) return null;
  const s = String(iso);
  // Diary times are wall clock — sliced, never parsed (the BST rule).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ+]/.test(s.slice(16))) return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function Facts({ rows }) {
  const shown = rows.filter(([, v]) => v != null && v !== '');
  return <dl className="il-facts">{shown.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>;
}

/** Presentational and pure: the resolver's answer → what is shown. */
export function ItemLinkView({ result, onNavigate = null }) {
  if (!result || result.loading) return <div className="il"><p className="il-muted">Opening the link…</p></div>;
  const word = KIND_WORD[result.kind] || 'item';
  const rec = result.record || {};

  if (result.status !== 'open') {
    const current = result.current ? itemFromNeuroHref(result.current) : null;
    return (
      <div className={`il il--${result.status}`} role="status">
        <p className="il-kind">{word}{result.id ? ` · ${result.id}` : ''}</p>
        <h2 className="il-heading">{STATUS_HEADING[result.status] || STATUS_HEADING.error}</h2>
        <p className="il-why">{result.why || 'No reason was given.'}</p>
        {result.status === 'stale' && result.record && <RecordFacts kind={result.kind} rec={rec} />}
        {current && onNavigate && <button type="button" className="il-btn" onClick={() => onNavigate('item', { item: current })}>Open the current one</button>}
        <p className="il-note">Nothing else was opened in its place.</p>
      </div>
    );
  }

  if (result.kind === 'action') {
    return (
      <div className="il">
        <p className="il-kind">action · {rec.actionId}</p>
        <PreparedActions filter={(a) => a.actionId === rec.actionId} title="This action" showLegacy={false} blurb={false} />
      </div>
    );
  }
  if (result.kind === 'meeting-prep') {
    return (
      <div className="il">
        <p className="il-kind">meeting prep</p>
        <MeetingPrep eventId={rec.eventId} />
      </div>
    );
  }

  const onward = {
    task: ['Show it in Tasks', 'todos', { taskId: rec.taskId, fromLink: true }],
    email: [rec.mailbox ? 'Find it in Personal inbox' : 'Find it in Inbox', rec.mailbox ? 'personal-inbox' : 'inbox', null],
    hazard: ['Find it on Home', 'home', null],
  }[result.kind];
  return (
    <div className="il">
      <p className="il-kind">{word}</p>
      <h2 className="il-heading">{rec.text || rec.subject || rec.name || rec.entityId || 'This record'}</h2>
      <RecordFacts kind={result.kind} rec={rec} />
      {onward && onNavigate && <button type="button" className="il-btn il-btn--quiet" onClick={() => onNavigate(onward[1], onward[2])}>{onward[0]}</button>}
    </div>
  );
}

function RecordFacts({ kind, rec }) {
  if (kind === 'task') return <Facts rows={[['Status', rec.status], ['Due', rec.dueDate], ['MoSCoW', rec.moscow], ['Task', rec.taskId != null ? `#${rec.taskId}` : null]]} />;
  if (kind === 'email') return <Facts rows={[['From', rec.from], ['Received', fmt(rec.receivedAt)], ['Mailbox', rec.mailbox], ['Sorted as', rec.category]]} />;
  if (kind === 'hazard') return <Facts rows={[['Sensor', rec.entityId], ['State', rec.state], ['Kind', rec.deviceClass], ['Since', fmt(rec.since)]]} />;
  if (kind === 'action') return <Facts rows={[['Type', rec.actionType], ['Status', rec.status], ['Version', rec.version]]} />;
  if (kind === 'meeting-prep') return <Facts rows={[['Meeting', rec.subject], ['Start', fmt(rec.start)], ['End', fmt(rec.end)]]} />;
  return null;
}

export default function ItemLink({ item, onNavigate }) {
  const [result, setResult] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    setResult({ loading: true });
    apiFetch(`/api/links/resolve?item=${encodeURIComponent(item || '')}`)
      .then(async (res) => {
        let json = null;
        try { json = await res.json(); } catch { json = null; }
        if (!live) return;
        if (res.status === 401) setResult({ status: 'unauthorised', why: 'Unlock NEURO, then open the link again.' });
        else if (!json || !json.status) setResult({ status: 'error', why: `NEURO answered ${res.status} with nothing it could read.` });
        else setResult(json);
      })
      .catch((e) => { if (live) setResult({ status: 'error', why: e.message || 'the request failed' }); });
    return () => { live = false; };
  }, [item]);
  return <ItemLinkView result={result} onNavigate={onNavigate} />;
}
