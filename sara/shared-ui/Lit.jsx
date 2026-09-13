import './Lit.css';
import { surfaceRgb } from './fieldDrive.mjs';

/**
 * Lit — one card, one chip, one section label, lit by HER.
 *
 * Step 1 of the design build order (`Projects/NEURO/SARA — Design Build Order`
 * in the vault), first because everything after it becomes a five-line change
 * rather than a rewrite.
 *
 * ⚠ THE FINDING THIS EXISTS TO FIX. MANIFESTATION.md, 13 Sep: "the secondary
 * screens are not lit by her at all. The shell field is driven behind them, but
 * their own cards and rows use flat borders and the system accent, so the app
 * looks like two products." One component, so twelve screens cannot each invent
 * a lit card.
 *
 * ⚠ WHAT IT DELIBERATELY IS NOT. The corridor and the centrepiece do NOT
 * export — depth is time, and a task list has no hours; a hero on a list just
 * makes one row arbitrarily loud. These carry the RULES: one light source,
 * hierarchy by light, three light states, and a named gap that is never dressed
 * as an error. A destination screen stays quiet, scannable and utilitarian.
 */

/**
 * Puts HER colour on a subtree. Everything below reads `--sara-rgb`.
 *
 * ⚠ SET ONCE, AT THE SHELL. Both shells already hold the drive (`useFieldDrive`),
 * so this wraps the whole app rather than each screen — a per-screen provider is
 * twelve chances for one of them to be told something different.
 *
 * `drive` is the same four-ish booleans the Field takes, so the canvas and the
 * cards are reading one state through one function. That was the whole bug:
 * `AttentionSurface` had its own stops and its own ladder, and on an ordinary
 * day the field drew orange while the cards on it drew blue.
 */
export function LitScope({ drive, className = '', style, children, ...rest }) {
  return (
    <div
      className={`lit-scope ${className}`.trim()}
      style={{ '--sara-rgb': surfaceRgb(drive || {}), ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * A card she is holding.
 *
 * @param {'lead'|'normal'|'row'|'statement'|'unreachable'} tone
 *   ⚠ A MEANING, never a colour. `lead` is the one brightest thing on the
 *   screen and there is at most one; `row` is one line of a dense list, lit but
 *   with NO glow, because sixty glowing boxes is haze rather than hierarchy;
 *   `statement` is a fact with no affordance; `unreachable` is a route that
 *   does not exist, which renders DASHED rather than missing — a control NEURO
 *   would refuse is worse than no control, and an absent one teaches nothing.
 */
export function Lit({ as: Tag = 'div', tone = 'normal', className = '', children, ...rest }) {
  const mod = tone === 'lead' ? ' lit--lead'
    : tone === 'row' ? ' lit--row'
      : tone === 'statement' ? ' lit--quiet'
        : tone === 'unreachable' ? ' lit--off'
          : '';
  return (
    <Tag className={`lit${mod} ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * A small pill carrying a state word.
 *
 * @param {'normal'|'gap'|'fault'} tone
 *   ⚠ `gap` and `fault` are DIFFERENT FACTS and only one of them is something
 *   failing. "I couldn't read the diary" is her being honest; styling it as an
 *   error is how he learns to ignore both. A gap is also always NAMED — this
 *   renders whatever it is given, and what it must never be given is a count.
 */
export function LitChip({ tone = 'normal', className = '', children, ...rest }) {
  const mod = tone === 'gap' ? ' lit-chip--gap' : tone === 'fault' ? ' lit-chip--fault' : '';
  return (
    <span className={`lit-chip${mod} ${className}`.trim()} {...rest}>
      {children}
    </span>
  );
}

/** A section label, in her colour and deliberately the dimmest thing present. */
export function LitLabel({ as: Tag = 'div', className = '', children, ...rest }) {
  return (
    <Tag className={`lit-label ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}

export default Lit;
