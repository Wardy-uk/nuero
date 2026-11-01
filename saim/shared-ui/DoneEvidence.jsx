import { useEffect, useState } from 'react';
import './DoneEvidence.css';

// "Looks done" (1 Nov 2026) — NEURO has evidence an OPEN task is already done
// (a sent email, a ticked daily-note line, the linked Planner task complete, a
// named Jira ticket resolved) and OFFERS to close it. It never closes one itself.
//
// Every word comes from GET /api/tasks/done-evidence (`say` names the subject,
// who, and when — never a message id). `call(path, {method, body}) → {status, body}`
// is the shell's authenticated fetch. Close is the ordinary completion; Not yet
// stops offering THAT evidence (newer evidence is offered again).
//
// One fetch per bundle is shared by every row (a list of 70 tasks must not ask
// 70 times), refreshed at most once a minute or after a press.

const store = { data: null, at: 0, inflight: null, subs: new Set() };
const FRESH_MS = 60 * 1000;

function notify() { for (const f of store.subs) f(); }

function load(call, force = false) {
  if (!call) return;
  if (!force && store.data && Date.now() - store.at < FRESH_MS) return;
  if (store.inflight) return;
  store.inflight = Promise.resolve()
    .then(() => call('/api/tasks/done-evidence'))
    .then((r) => {
      store.data = r && r.status === 200 && r.body ? r.body : { ok: false, error: (r && r.body && r.body.error) || `HTTP ${r && r.status}` };
    })
    .catch((e) => { store.data = { ok: false, error: e.message }; })
    .finally(() => { store.at = Date.now(); store.inflight = null; notify(); });
}

export function useDoneEvidence(call) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    store.subs.add(f);
    load(call);
    return () => { store.subs.delete(f); };
  }, [call]);
  return { data: store.data, reload: () => load(call, true) };
}

/** PURE: the offer for one task, or null. */
export function offerFor(data, taskId) {
  if (!data || !Array.isArray(data.items) || taskId == null) return null;
  return data.items.find((i) => Number(i.taskId) === Number(taskId)) || null;
}

function drop(taskId) {
  if (store.data && Array.isArray(store.data.items)) {
    store.data = { ...store.data, items: store.data.items.filter((i) => Number(i.taskId) !== Number(taskId)) };
    store.data.count = store.data.items.length;
    notify();
  }
}

/** The offer line with its two answers. Renders nothing when there is no offer. */
export function DoneEvidenceLine({ item, call, onClosed = null, readOnly = false, showTask = false }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (!item) return null;
  const act = async (verb, e) => {
    if (e) e.stopPropagation();
    setBusy(verb); setError(null);
    try {
      const r = await call(`/api/tasks/${item.taskId}/done-evidence/${verb}`, { method: 'POST', body: {} });
      if (r.status !== 200 || !r.body || r.body.ok === false) { setError((r.body && r.body.error) || `Not saved (HTTP ${r.status})`); return; }
      drop(item.taskId);
      load(call, true);
      if (verb === 'close' && onClosed) onClosed(item.taskId, r.body);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(null); }
  };
  return (
    <div className="looksdone" onClick={(e) => e.stopPropagation()} data-task-id={item.taskId}>
      {showTask && <div className="looksdone__task">{item.text}</div>}
      <div className="looksdone__say">
        <span className="looksdone__label">Looks done</span> — {item.say}
        {item.more > 0 && <span className="looksdone__more"> (+{item.more} more)</span>}
      </div>
      {!readOnly && (
        <div className="looksdone__acts">
          <button type="button" className="looksdone__close" disabled={!!busy} onClick={(e) => act('close', e)}>{busy === 'close' ? 'Closing…' : 'Close it'}</button>
          <button type="button" className="looksdone__notyet" disabled={!!busy} onClick={(e) => act('not-yet', e)}>{busy === 'not-yet' ? '…' : 'Not yet'}</button>
        </div>
      )}
      {error && <div className="looksdone__err">Nothing changed — {error}</div>}
    </div>
  );
}

/** One task row's affordance: looks up the shared read. */
export function DoneEvidenceRow({ taskId, call, onClosed = null, readOnly = false }) {
  const { data } = useDoneEvidence(call);
  return <DoneEvidenceLine item={offerFor(data, taskId)} call={call} onClosed={onClosed} readOnly={readOnly} />;
}

/** PURE-ish view: the "Looks done (N)" section. Nothing at all when N is 0. */
export function LooksDoneView({ data, call, onClosed = null, readOnly = false }) {
  if (!data || !data.ok || !Array.isArray(data.items) || data.items.length === 0) return null;
  const gaps = Array.isArray(data.gaps) ? data.gaps : [];
  return (
    <section className="looksdone-section">
      <h3 className="looksdone-section__h">Looks done ({data.items.length})</h3>
      <p className="looksdone-section__note">NEURO saw these happen. Nothing is closed until you say so.</p>
      {data.items.map((item) => (
        <DoneEvidenceLine key={item.taskId} item={item} call={call} onClosed={onClosed} readOnly={readOnly} showTask />
      ))}
      {gaps.length > 0 && (
        <p className="looksdone-section__gap">Couldn't check: {gaps.map((g) => g.why).join('; ')}.</p>
      )}
    </section>
  );
}

export default function LooksDoneSection({ call, onClosed = null, readOnly = false }) {
  const { data } = useDoneEvidence(call);
  return <LooksDoneView data={data} call={call} onClosed={onClosed} readOnly={readOnly} />;
}
