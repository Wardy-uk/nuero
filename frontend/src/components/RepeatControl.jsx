import React from 'react';
import { describe as describeRule } from '../../../shared/task-recurrence.cjs';

/**
 * The Repeat control for a NEURO task (17 Oct 2026).
 *
 * The value is a rule WITHOUT its anchor, serialised to a string (or null for
 * "doesn't repeat") so a drafted card can compare it with `!==` like every other
 * field. The server anchors a new rule on the task's due date — slots are fixed
 * from there, so the control never asks for one.
 *
 * Words come from shared/task-recurrence.cjs's `describe`, the same function
 * that labels the ↻ chip and the server's `recurrenceLabel`, so the preview and
 * the card cannot disagree.
 */

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_SHORT = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' };
const NTHS = [
  { v: 1, label: 'First' }, { v: 2, label: 'Second' }, { v: 3, label: 'Third' },
  { v: 4, label: 'Fourth' }, { v: -1, label: 'Last' },
];

/** A stored rule → the control's value (anchor dropped). */
export function valueFromRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const { anchor, ...rest } = rule; // eslint-disable-line no-unused-vars
  return JSON.stringify(rest);
}

/** The control's value → the `recurrence` body field (null stops repeating). */
export function ruleFromValue(value) {
  return value ? JSON.parse(value) : null;
}

export function labelForValue(value) {
  if (!value) return null;
  try { return describeRule(JSON.parse(value)); } catch { return null; }
}

const DEFAULTS = {
  interval: { kind: 'interval', every: 1, unit: 'week' },
  weekdays: { kind: 'weekdays', every: 1, days: ['mon'] },
  'nth-weekday': { kind: 'nth-weekday', every: 1, nth: 1, weekday: 'mon' },
  'last-working-day': { kind: 'last-working-day', every: 1 },
};

export default function RepeatControl({ value, onChange, disabled }) {
  const rule = value ? JSON.parse(value) : null;
  const set = (next) => onChange(next ? JSON.stringify(next) : null);
  const every = rule ? rule.every || 1 : 1;
  const setEvery = (raw) => {
    const n = Number(raw);
    // A blank or nonsense box is not a schedule; leave the value until it is a
    // whole number. The server refuses out-of-range values with a reason.
    if (Number.isInteger(n) && n >= 1) set({ ...rule, every: n });
  };

  return (
    <div className="todo-edit-group todo-repeat" onClick={(e) => e.stopPropagation()}>
      <span className="todo-edit-label">Repeat</span>
      <select
        className="todo-edit-date"
        aria-label="Repeat pattern"
        value={rule ? rule.kind : ''}
        disabled={disabled}
        onChange={(e) => set(e.target.value ? DEFAULTS[e.target.value] : null)}
      >
        <option value="">Doesn&rsquo;t repeat</option>
        <option value="interval">Every N days / weeks / months</option>
        <option value="weekdays">On set weekdays</option>
        <option value="nth-weekday">Nth weekday of the month</option>
        <option value="last-working-day">Last working day of the month</option>
      </select>

      {rule && (
        <>
          <span className="todo-edit-note">every</span>
          <input
            type="number"
            min="1"
            className="todo-edit-date todo-repeat-every"
            aria-label="Every"
            value={every}
            disabled={disabled}
            onChange={(e) => setEvery(e.target.value)}
          />
        </>
      )}

      {rule && rule.kind === 'interval' && (
        <select
          className="todo-edit-date"
          aria-label="Unit"
          value={rule.unit}
          disabled={disabled}
          onChange={(e) => set({ ...rule, unit: e.target.value })}
        >
          <option value="day">{every === 1 ? 'day' : 'days'}</option>
          <option value="week">{every === 1 ? 'week' : 'weeks'}</option>
          <option value="month">{every === 1 ? 'month' : 'months'}</option>
        </select>
      )}
      {rule && rule.kind === 'weekdays' && (
        <>
          <span className="todo-edit-note">{every === 1 ? 'week on' : 'weeks on'}</span>
          {DAY_KEYS.map(d => {
            const on = rule.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                className={`todo-edit-btn${on ? ' active' : ''}`}
                disabled={disabled || (on && rule.days.length === 1)}
                title={on && rule.days.length === 1 ? 'At least one day' : undefined}
                onClick={() => set({ ...rule, days: on ? rule.days.filter(x => x !== d) : DAY_KEYS.filter(x => x === d || rule.days.includes(x)) })}
              >{DAY_SHORT[d]}</button>
            );
          })}
        </>
      )}
      {rule && rule.kind === 'nth-weekday' && (
        <>
          <span className="todo-edit-note">{every === 1 ? 'month, on the' : 'months, on the'}</span>
          <select className="todo-edit-date" aria-label="Which" value={rule.nth} disabled={disabled}
            onChange={(e) => set({ ...rule, nth: Number(e.target.value) })}>
            {NTHS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          <select className="todo-edit-date" aria-label="Weekday" value={rule.weekday} disabled={disabled}
            onChange={(e) => set({ ...rule, weekday: e.target.value })}>
            {DAY_KEYS.map(d => <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>)}
          </select>
        </>
      )}
      {rule && rule.kind === 'last-working-day' && (
        <span className="todo-edit-note">{every === 1 ? 'month' : 'months'}</span>
      )}

      {rule && (
        <span className="todo-edit-note">
          &#8635; {labelForValue(value)} &mdash; fixed dates from the due date; ticking it
          late skips to the next date still ahead, never a backlog.
        </span>
      )}
    </div>
  );
}
