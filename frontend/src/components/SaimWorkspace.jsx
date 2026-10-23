import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import useAttention from '../useAttention';
import { useWorkOnly } from '../workOnly';
import NowScene, { hasScene } from './NowScene';
import { focusTaskOf } from './AdhdPanel';
import './AdhdPanel.css';
import './SaimWorkspace.css';

// The SAiM workspace (Build Brief 003, Option B, 23 Oct 2026) — NEURO Desktop's
// primary tab when the `saim_desktop_workspace` switch is on.
//
// ⚠ PRESENTATION ONLY. It reads the SAME /api/canonical/now as Now and renders
//   the SAME scene (NowScene) with the same governed callbacks. Its own code
//   makes no write call: the "Why this" strip renders the server's words
//   verbatim, and the only other read is /api/adhd for the running block (so
//   Next never repeats it). No ranker, no wording of its own about the work.

const STALE_MS = 2 * 60 * 1000; // Now polls every 30 s; two minutes is four missed reads.

/** PURE. How old the read is, in words, and whether it is stale. */
export function ageLine(generatedAt, now = Date.now()) {
  const t = Date.parse(generatedAt || '');
  if (!Number.isFinite(t)) return { text: 'When this was read is unknown.', stale: true };
  const s = Math.max(0, Math.round((now - t) / 1000));
  const text = s < 60 ? `Read ${s} second${s === 1 ? '' : 's'} ago.` : `Read ${Math.round(s / 60)} min ago.`;
  return { text: now - t > STALE_MS ? `${text.slice(0, -1)} — it may be out of date.` : text, stale: now - t > STALE_MS };
}

/**
 * PURE (render only). Why SAiM leads with what she leads with, what she is
 * holding back, and what she cannot see — all in the server's words.
 */
export function SaimWhy({ data, error = null, now = Date.now() }) {
  if (!data) return null;
  const saim = data.saim || null;
  const pres = data.presentation || null;
  const honesty = (pres && pres.situation && pres.situation.honesty) || null;
  const held = (saim && Array.isArray(saim.held) ? saim.held : []);
  const workHeld = data.situation && data.situation.workHeld && data.situation.workHeld.say;
  const reasons = (data.context && Array.isArray(data.context.reasons) ? data.context.reasons : []);
  const contradictions = (data.context && Array.isArray(data.context.contradictions) ? data.context.contradictions : []);
  const gaps = Array.isArray(data.gaps) ? data.gaps : [];
  const age = ageLine(data.generatedAt, now);
  const blind = data.poolAvailable === false;
  const degraded = !blind && pres && pres.mode === 'degraded';

  return (
    <section className="saim-why" aria-label="Why this, and what SAiM can’t see">
      <h3 className="saim-why__title">Why this · what I can’t see</h3>

      {blind && <p className="saim-why__line saim-why__line--warn" data-why="blind">I can’t see your work right now. This is not an all-clear.</p>}
      {degraded && pres.situation && pres.situation.summary && (
        <p className="saim-why__line saim-why__line--warn" data-why="degraded">{pres.situation.summary}</p>
      )}

      <div className="saim-why__row" data-why="lead">
        <span className="saim-why__label">Leading with</span>
        {saim && saim.lead ? (
          <span>
            {saim.lead.why}
            {saim.lead.rule && <span className="saim-why__meta"> · {saim.lead.rule}</span>}
          </span>
        ) : <span>SAiM’s decision wasn’t in this read.</span>}
      </div>

      <div className="saim-why__row" data-why="held">
        <span className="saim-why__label">Held back</span>
        {held.length || workHeld ? (
          <div>
            {workHeld && <p className="saim-why__line">{workHeld}</p>}
            {held.length > 0 && (
              <ul className="saim-why__list">
                {held.slice(0, 6).map((h) => (
                  <li key={h.ref}>{h.title}{h.why ? ` — ${h.why}` : ''}{h.returns ? <span className="saim-why__meta"> · back {h.returns}</span> : null}</li>
                ))}
                {held.length > 6 && <li className="saim-why__meta">and {held.length - 6} more</li>}
              </ul>
            )}
          </div>
        ) : <span>Nothing held back.</span>}
      </div>

      <div className="saim-why__row" data-why="honesty">
        <span className="saim-why__label">Can’t see</span>
        {honesty && honesty.complete === false ? (
          <span className="saim-why__warn">{honesty.say || `Couldn’t read: ${gaps.map((g) => g.input).join(', ')}.`}</span>
        ) : honesty && honesty.complete === true ? (
          <span>Every source NEURO read for this answered.</span>
        ) : <span className="saim-why__warn">Whether everything answered isn’t in this read.</span>}
      </div>

      {(reasons.length > 0 || contradictions.length > 0) && (
        <div className="saim-why__row" data-why="reasons">
          <span className="saim-why__label">The moment</span>
          <ul className="saim-why__list">
            {reasons.map((r, i) => <li key={`r${i}`}>{r}</li>)}
            {contradictions.map((c, i) => <li key={`c${i}`} className="saim-why__warn">{c}</li>)}
          </ul>
        </div>
      )}

      <p className={`saim-why__age${age.stale || error ? ' saim-why__warn' : ''}`} data-why="age">
        {error ? 'Couldn’t refresh — this is the last read. ' : ''}{age.text}
      </p>
    </section>
  );
}

/** PURE (render only). The workspace for a given read; the container supplies it. */
export function SaimWorkspaceView({ attention, onNavigate, onStarted, blockTasks = [], focusTaskId = null, workOnly = false, now = Date.now() }) {
  const data = attention && attention.data;
  return (
    <div className="adhd saim-ws">
      <header className="saim-ws__head">
        <h2 className="saim-ws__title">SAiM</h2>
        {onNavigate && (
          <button type="button" className="saim-ws__now" onClick={() => onNavigate('today')}>Open Now</button>
        )}
      </header>
      {!data ? (
        attention && attention.loading
          ? <p className="saim-ws__status">Looking…</p>
          : <p className="saim-ws__status saim-why__warn">I can’t reach NEURO right now. This is not an all-clear.</p>
      ) : (
        <div className="saim-ws__body">
          {hasScene(data) ? (
            <section className="adhd__now adhd__now--situation">
              {workOnly && <p className="adhd__now-workonly">Work only{data.situation?.personalHeld?.say ? ` — ${data.situation.personalHeld.say}` : ' — personal life is hidden.'}</p>}
              <NowScene attention={attention} onNavigate={onNavigate} onStarted={onStarted} blockTasks={blockTasks} focusTaskId={focusTaskId} />
            </section>
          ) : (
            <p className="saim-ws__status saim-why__warn">This read has no SAiM scene. Now still shows what NEURO has.</p>
          )}
          <SaimWhy data={data} error={attention.error} now={now} />
        </div>
      )}
    </div>
  );
}

export default function SaimWorkspace({ onNavigate }) {
  const [workOnly] = useWorkOnly();
  const attention = useAttention({ interval: 30000, path: workOnly ? '/api/canonical/now?workOnly=1' : '/api/canonical/now' });
  // READ-ONLY: the running block and session, so the scene can leave the block's own
  // tasks out of Next and show context for the one task in focus. Unreadable = none.
  const [adhd, setAdhd] = useState(null);
  const loadAdhd = useCallback(async () => {
    try {
      const res = await apiFetch('/api/adhd');
      setAdhd(res.ok ? await res.json().catch(() => null) : null);
    } catch { setAdhd(null); }
  }, []);
  useEffect(() => { loadAdhd(); }, [loadAdhd]);
  const blockNow = adhd && adhd.blockNow;
  const focusTaskId = focusTaskOf(adhd && adhd.session && !adhd.recovery ? adhd.session : null, blockNow);
  return (
    <SaimWorkspaceView
      attention={attention}
      onNavigate={onNavigate}
      onStarted={loadAdhd}
      blockTasks={(blockNow && blockNow.tasks) || []}
      focusTaskId={focusTaskId}
      workOnly={workOnly}
    />
  );
}
