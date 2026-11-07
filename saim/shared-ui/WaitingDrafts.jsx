import { useCallback, useEffect, useState } from 'react';
import PreparedSend from './PreparedSend.jsx';

/**
 * The drafts waiting on Nick's press, each with Send in place (7 Nov 2026).
 *
 * SAiM's home said "N drafted emails wait for your approval" and offered no way
 * to send them — by a Build 7 rule (approval code at the desk) retired on
 * 24 Oct 2026: one press approves on any attended screen. This lists exactly
 * what `/api/prepared-actions` holds as waiting (`needsApproval`), with the
 * version and payload hash each Send is bound to.
 *
 * ⚠ An unreadable queue SAYS so; it never renders as "nothing waiting".
 * ⚠ `call` null (the kiosk) renders nothing — the sentence above stands alone.
 */
export default function WaitingDrafts({ call = null, surface = 'neuro-web', onChanged = null, max = 5 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!call) return;
    try {
      const r = await call('/api/prepared-actions?limit=1');
      if (!(r && r.status === 200 && r.body && r.body.ok)) throw new Error((r && r.body && r.body.error) || `HTTP ${r && r.status}`);
      setData(r.body); setError(null);
    } catch (e) { setError(e.message || 'could not read'); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  if (!call) return null;
  if (error) return <p className="waitdrafts__err">Couldn’t read the drafts ({error}) — open Actions in NEURO to see them.</p>;
  if (!data) return null;
  const byId = new Map((data.actions || []).map((a) => [a.actionId, a]));
  const waiting = ((data.buckets && data.buckets.needsApproval) || []).map((id) => byId.get(id)).filter((a) => a && a.status === 'prepared');
  if (!waiting.length) return null;
  return (
    <div className="waitdrafts" role="list" aria-label="Drafts waiting to send">
      {waiting.slice(0, max).map((a) => (
        <div role="listitem" key={a.actionId}>
          <PreparedSend action={a} call={call} sending={data.sending || null} surface={surface} compact
            onChanged={(r) => { if (onChanged) onChanged(r); }} />
        </div>
      ))}
      {waiting.length > max && <p className="waitdrafts__err">and {waiting.length - max} more in Actions.</p>}
    </div>
  );
}
