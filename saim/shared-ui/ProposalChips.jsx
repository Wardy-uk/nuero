import React, { useState } from 'react';
import './ProposalChips.css';

/**
 * NEURO's SUGGESTED MoSCoW / estimate / due date for a task, each with a
 * one-tap Confirm (1 Nov 2026). Rendered by the NEURO desktop task card and
 * SAiM's Tasks view, so the two cannot phrase a suggestion differently.
 *
 * ⚠ A suggestion is never a value. It renders with a trailing "?" and does
 * nothing until pressed; Confirm is just setting the real field through the
 * shell's own write (`onConfirm(body)` → PATCH /api/tasks/:id), which drops the
 * suggestion server-side. Ignoring it costs nothing.
 */

const MOSCOW_LABEL = { must: 'Must', should: 'Should', could: 'Could', wont: "Won't" };

function fmtMinutes(m) {
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function fmtDate(d) {
  // Sliced, never parsed into a Date (the BST rule).
  const [y, mo, da] = String(d).slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return y && mo && da ? `${da} ${months[mo - 1]}` : String(d);
}

/** PURE. The chips to draw, in field order, each with the write that confirms it. */
export function proposalChips(proposals) {
  const p = proposals || {};
  const out = [];
  if (p.moscow && p.moscow.value) {
    out.push({ field: 'moscow', label: `${MOSCOW_LABEL[p.moscow.value] || p.moscow.value}?`, why: p.moscow.why, body: { moscow: p.moscow.value } });
  }
  if (p.estimate && p.estimate.minutes > 0) {
    out.push({ field: 'estimate', label: `~${fmtMinutes(p.estimate.minutes)}?`, why: p.estimate.why, body: { estimateMinutes: p.estimate.minutes } });
  }
  if (p.due && p.due.date) {
    out.push({ field: 'due', label: `Due ${fmtDate(p.due.date)}?`, why: p.due.why, body: { due_date: String(p.due.date).slice(0, 10) } });
  }
  return out;
}

export default function ProposalChips({ proposals, onConfirm, readOnly = false }) {
  const chips = proposalChips(proposals);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (!chips.length) return null;
  const confirm = async (chip, e) => {
    if (e) e.stopPropagation();
    if (!onConfirm || busy) return;
    setBusy(chip.field);
    setError(null);
    try {
      await onConfirm(chip.body, chip.field);
    } catch (err) {
      setError(`Not saved — ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="proposal-chips" onClick={(e) => e.stopPropagation()}>
      {chips.map((chip) => (
        <span key={chip.field} className={`proposal-chip proposal-chip--${chip.field}`} title={chip.why ? `NEURO suggests this: ${chip.why}` : 'NEURO suggests this'}>
          <span className="proposal-chip__label">{chip.label}</span>
          {!readOnly && onConfirm && (
            <button
              type="button"
              className="proposal-chip__confirm"
              disabled={Boolean(busy)}
              aria-label={`Confirm ${chip.label.replace(/\?$/, '')}`}
              onClick={(e) => confirm(chip, e)}
            >{busy === chip.field ? '…' : 'Confirm'}</button>
          )}
        </span>
      ))}
      {error && <span className="proposal-chips__error">{error}</span>}
    </span>
  );
}
