import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import { duePresets } from '../../../shared/due-dates.cjs';
import { SIZES } from '../../../shared/task-size.cjs';
import { ORIGINS, SHORT_LABELS, DESCRIPTIONS } from '../../../shared/task-origin.cjs';
import { msPlanBadge } from '../../../shared/ms-task.cjs';
import './TaskTriage.css';

/**
 * Run through every task that still needs a decision, one card at a time
 * (20 Oct 2026). Replaces the MoSCoW-only review.
 *
 * Nick's calls: the fields are MoSCoW (a guess counts as missing), priority,
 * estimate, due date and origin; Microsoft tasks are included for EVERY field
 * (estimate/origin/priority/MoSCoW held privately in NEURO, the due date
 * written to the Planner / To Do card); and every field but MoSCoW can be
 * answered "none", which is a decision and takes the task out of the queue
 * for that field.
 *
 * ⚠ Which fields are missing is the SERVER's answer (`todo.triage.missing`,
 * shared/task-triage.cjs), stamped before decorateTask overwrites `moscow`.
 * This component never works it out, or the button count and the run could
 * disagree.
 *
 * ⚠ The queue is a SNAPSHOT taken on open. Saving refreshes the list behind
 * the run, and a queue rebuilt from it on every save would re-rank under the
 * card he is looking at — the same reason the task cards draft until Save.
 *
 * A field left unanswered is simply not sent: the task stays in the queue for
 * that field next time. Nothing is guessed on his behalf.
 */

export const NONE = '__none__';

const MOSCOW = [
  { key: 'must', label: 'Must', color: '#ef4444', hotkey: '1' },
  { key: 'should', label: 'Should', color: '#f59e0b', hotkey: '2' },
  { key: 'could', label: 'Could', color: '#3b82f6', hotkey: '3' },
  { key: 'wont', label: "Won't", color: '#6b7280', hotkey: '4' },
];
const PRIORITY = [
  { key: 3, label: 'P3', desc: 'Most pressing' },
  { key: 2, label: 'P2', desc: 'Middle' },
  { key: 1, label: 'P1', desc: 'Least pressing' },
];
const NONE_LABEL = { priority: 'No priority', estimate: 'No estimate', due: 'No date', origin: 'Neither' };
const FIELD_TITLE = { moscow: 'MoSCoW', priority: 'Priority', estimate: 'Estimate', due: 'Due date', origin: 'Origin' };

/**
 * PURE. Turn a card's answers into the writes, by owner. Exported for tests.
 * Returns { kind: 'neuro', body } or { kind: 'ms', local, due } — `due` is the
 * Graph write and is null when no date was chosen.
 */
export function buildWrites(todo, answers) {
  const answered = Object.entries(answers).filter(([, v]) => v !== undefined);
  const value = (f) => (answers[f] === NONE || answers[f] === undefined ? undefined : answers[f]);
  const noneNew = answered.filter(([, v]) => v === NONE).map(([f]) => f);
  const none = [...new Set([...(todo.triageNone || []), ...noneNew])];

  if (todo.task_id) {
    const body = {};
    if (value('moscow') !== undefined) body.moscow = value('moscow');
    if (value('priority') !== undefined) body.priority = value('priority');
    if (value('estimate') !== undefined) body.estimateMinutes = value('estimate');
    if (value('due') !== undefined) body.due_date = value('due');
    if (value('origin') !== undefined) body.origin = value('origin');
    if (noneNew.length) body.triageNone = none;
    return { kind: 'neuro', body };
  }
  const local = {};
  if (value('moscow') !== undefined) local.moscow = value('moscow');
  if (value('priority') !== undefined) local.priority = value('priority');
  if (value('estimate') !== undefined) local.estimateMinutes = value('estimate');
  if (value('origin') !== undefined) local.origin = value('origin');
  if (noneNew.length) local.none = none;
  return { kind: 'ms', local, due: value('due') !== undefined ? value('due') : null };
}

async function send(url, method, body) {
  const res = await fetch(apiUrl(url), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `Not saved (${res.status})`);
  return json;
}

function Choice({ active, onClick, children, title, color, disabled }) {
  return (
    <button
      type="button"
      className={`triage-choice${active ? ' active' : ''}`}
      style={color ? { '--triage-color': color } : undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function TaskTriage({ todos, onClose, onSaved }) {
  // Snapshot on open — see the header.
  const [queue] = useState(() => (todos || []).filter((t) => !t.done && t.triage && t.triage.missing.length));
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [customDue, setCustomDue] = useState('');

  const current = queue[index] || null;
  const missing = current ? current.triage.missing : [];
  const isMs = current && !current.task_id;
  const answeredCount = missing.filter((f) => answers[f] !== undefined).length;

  const next = useCallback(() => {
    setAnswers({});
    setCustomDue('');
    setError(null);
    setIndex((i) => i + 1);
  }, []);

  const set = (field, v) => setAnswers((prev) => ({ ...prev, [field]: prev[field] === v ? undefined : v }));

  const save = useCallback(async () => {
    if (!current || saving || answeredCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      const w = buildWrites(current, answers);
      if (w.kind === 'neuro') {
        await send(`/api/tasks/${current.task_id}`, 'PATCH', w.body);
      } else {
        if (Object.keys(w.local).length) {
          await send(`/api/todos/ms/${encodeURIComponent(current.ms_id)}/local`, 'PATCH', w.local);
        }
        if (w.due) {
          // Microsoft's own field: this one reaches the card his team reads.
          await send(`/api/todos/ms/${encodeURIComponent(current.ms_id)}`, 'PATCH', {
            dueDate: w.due,
            source: current.source || null,
            filePath: current.filePath || null,
            lineNumber: current.lineNumber != null ? current.lineNumber : null,
          });
        }
      }
      setSaved((n) => n + 1);
      if (onSaved) onSaved();
      next();
    } catch (e) {
      // The answers stay on the card: a failed write must not cost the decision.
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [current, saving, answeredCount, answers, onSaved, next]);

  const skip = useCallback(() => { setSkipped((n) => n + 1); next(); }, [next]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Escape') { onClose?.(); return; }
      if (!current) return;
      const m = MOSCOW.find((o) => o.hotkey === e.key);
      if (m && missing.includes('moscow')) { set('moscow', m.key); return; }
      if (e.key === 'Enter') { e.preventDefault(); save(); return; }
      if (e.key === 's' || e.key === 'S') { skip(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!current) {
    return (
      <div className="triage">
        <div className="triage-done">
          <div className="triage-done-icon">✓</div>
          <div className="triage-done-title">
            {queue.length === 0 ? 'Nothing needs triage' : 'End of the run'}
          </div>
          {queue.length > 0 && (
            <div className="triage-done-stats">
              {saved} saved · {skipped} skipped{skipped ? ' — those stay in the queue for next time' : ''}
            </div>
          )}
          <button className="btn btn-primary" onClick={onClose}>Back to tasks</button>
        </div>
      </div>
    );
  }

  // A mirror's source chip already says "MS Planner"; only a linked NEURO row needs the system named.
  const plan = msPlanBadge(current, { withSystem: Boolean(current.task_id) });
  const presets = duePresets();
  const todayStr = new Date().toLocaleDateString('en-CA');

  return (
    <div className="triage">
      <div className="triage-header">
        <h2 className="triage-title">Triage</h2>
        <span className="triage-count">{index + 1} of {queue.length}</span>
        <button className="triage-close" onClick={onClose} title="Stop (Esc) — anything saved stays saved">✕</button>
      </div>
      <div className="triage-track">
        <div className="triage-fill" style={{ width: `${Math.round((index / queue.length) * 100)}%` }} />
      </div>

      <div className="triage-card">
        <div className="triage-text">{current.text}</div>
        <div className="triage-meta">
          {current.task_id ? <span className="triage-chip">#{current.task_id}</span> : null}
          {current.source && <span className="triage-chip">{current.source}</span>}
          {plan && <span className="triage-chip">{plan}</span>}
          {current.due_date && <span className="triage-chip">Due {String(current.due_date).slice(0, 10)}</span>}
          {isMs && (
            <span className="triage-chip triage-chip--note" title="Microsoft cannot hold these fields">
              MoSCoW, priority, estimate and origin stay in NEURO · the due date goes to {/planner/i.test(current.source || '') ? 'Planner' : 'To Do'}
            </span>
          )}
        </div>
      </div>

      <div className="triage-fields">
        {missing.includes('moscow') && (
          <div className="triage-field">
            <div className="triage-label">
              {FIELD_TITLE.moscow}
              {current.moscowProposed && current.meta?.moscow && (
                <span className="triage-hint"> — NEURO guessed {current.meta.moscow}; confirm or change</span>
              )}
            </div>
            <div className="triage-options">
              {MOSCOW.map((o) => (
                <Choice key={o.key} color={o.color} active={answers.moscow === o.key} onClick={() => set('moscow', o.key)} title={`Key ${o.hotkey}`}>
                  {o.label} <kbd>{o.hotkey}</kbd>
                </Choice>
              ))}
            </div>
          </div>
        )}

        {missing.includes('priority') && (
          <div className="triage-field">
            <div className="triage-label">{FIELD_TITLE.priority}</div>
            <div className="triage-options">
              {PRIORITY.map((o) => (
                <Choice key={o.key} active={answers.priority === o.key} title={o.desc} onClick={() => set('priority', o.key)}>{o.label}</Choice>
              ))}
              <Choice active={answers.priority === NONE} onClick={() => set('priority', NONE)}>{NONE_LABEL.priority}</Choice>
            </div>
          </div>
        )}

        {missing.includes('estimate') && (
          <div className="triage-field">
            <div className="triage-label">{FIELD_TITLE.estimate}</div>
            <div className="triage-options">
              {SIZES.map((s) => (
                <Choice key={s.id} active={answers.estimate === s.minutes} title={s.desc} onClick={() => set('estimate', s.minutes)}>{s.label}</Choice>
              ))}
              <Choice active={answers.estimate === NONE} onClick={() => set('estimate', NONE)}>{NONE_LABEL.estimate}</Choice>
            </div>
          </div>
        )}

        {missing.includes('due') && (
          <div className="triage-field">
            <div className="triage-label">{FIELD_TITLE.due}</div>
            <div className="triage-options">
              <Choice active={answers.due === todayStr} onClick={() => set('due', todayStr)}>Today</Choice>
              {presets.map((p) => (
                <Choice key={p.id} active={answers.due === p.date} title={p.date} onClick={() => set('due', p.date)}>{p.label}</Choice>
              ))}
              <input
                type="date"
                className="triage-date"
                value={customDue}
                onChange={(e) => {
                  setCustomDue(e.target.value);
                  setAnswers((prev) => ({ ...prev, due: e.target.value || undefined }));
                }}
              />
              <Choice active={answers.due === NONE} onClick={() => set('due', NONE)}>{NONE_LABEL.due}</Choice>
            </div>
          </div>
        )}

        {missing.includes('origin') && (
          <div className="triage-field">
            <div className="triage-label">
              {FIELD_TITLE.origin}
              {current.originProposed && current.origin && (
                <span className="triage-hint"> — NEURO guessed {SHORT_LABELS[current.origin] || current.origin}; confirm or change</span>
              )}
            </div>
            <div className="triage-options">
              {ORIGINS.map((key) => (
                <Choice key={key} active={answers.origin === key} title={DESCRIPTIONS[key]} onClick={() => set('origin', key)}>{SHORT_LABELS[key]}</Choice>
              ))}
              <Choice active={answers.origin === NONE} onClick={() => set('origin', NONE)}>{NONE_LABEL.origin}</Choice>
            </div>
          </div>
        )}
      </div>

      {error && <div className="triage-error">Not saved — {error}</div>}

      <div className="triage-actions">
        <button className="btn btn-primary" disabled={saving || answeredCount === 0} onClick={save}>
          {saving ? 'Saving…' : 'Save & next'} <kbd>Enter</kbd>
        </button>
        <button className="btn btn-secondary" disabled={saving} onClick={skip}>
          Skip <kbd>S</kbd>
        </button>
        <span className="triage-note">
          {answeredCount === 0
            ? 'Pick at least one — anything left blank stays in the queue.'
            : answeredCount < missing.length
              ? `${missing.length - answeredCount} left blank — it stays in the queue for those.`
              : 'All answered.'}
        </span>
      </div>
    </div>
  );
}
