'use strict';

/**
 * What a held attention item IS, in words (SAiM quality pass, 25 Oct 2026).
 *
 * The attention gate's `dropped` entries carry an id, a type and a reason but no
 * title, so SAiM's held list fell back to the raw type — `ticket_commitment`,
 * `capacity`, `todo` on the desktop Why strip. This is the one place a pool type
 * becomes a label. It names the KIND of thing, never its content: held work is
 * held so it stays off the screen, and a kind is enough to say what is waiting.
 *
 * PURE. Shared by neuro-candidates (the SAiM held list) and any later reader.
 */

const TYPE_LABELS = Object.freeze({
  capacity: 'Capacity warning',
  ticket_commitment: 'Promised ticket update',
  watched_reply: 'Customer reply on a watched ticket',
  escalation: 'Escalation',
  nova_flag: 'Flag from NOVA',
  meeting: 'Meeting',
  email: 'Urgent email',
  nudge: 'Reminder',
  weekly_risk: 'Weekly risk report',
  plan_closure: 'Plan close-out',
  imports: 'Imports to review',
  'source-blind': 'A sense has gone quiet',
  ambient: 'Something SAiM noticed',
});

/**
 * @param {string|null} type  decision-engine pool type
 * @param {string|null} [id]  the pool item id (todo cards are told apart by it)
 * @returns {string} a human label — never the raw id
 */
function itemTypeLabel(type, id = null) {
  const t = String(type || '').trim();
  if (t === 'todo') {
    const i = String(id || '');
    if (/^todo-overdue-summary/.test(i)) return 'Overdue tasks';
    if (/^todo-overdue/.test(i)) return 'An overdue task';
    return 'A task';
  }
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  if (!t) return 'An item from NEURO';
  // An unmapped type is humanised rather than shown raw: "foo_bar-baz" → "Foo bar baz".
  const words = t.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

module.exports = { itemTypeLabel, TYPE_LABELS };
