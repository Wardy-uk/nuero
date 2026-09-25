'use strict';

/**
 * Does the surface still have spacing on an engine WITHOUT container queries?
 *
 * Nick's Galaxy Tab in the study rendered the shelf as one unreadable bar —
 * `17.1°CCLOUDYBROWSERVS CODEMUSICTERMINAL` — and the fact cards with their
 * text sitting on the border. Not a stale build and not a refresh problem: that
 * engine does not support container query units, so every declaration valued in
 * `cqw` is discarded, and the properties whose ONLY declaration was a `cqw`
 * clamp computed to zero.
 *
 * ⚠ THE EVIDENCE WAS THE 6px. `.approach--quiet .approach__row` sets its gap in
 * cqw while the base `.approach__row` sets a plain `gap: 6px`. That 6px was
 * visible on the tablet, which can only happen if the cqw override was thrown
 * away. In the same shelf rule the px `border` and `border-radius` rendered
 * while the cqw `padding` and `gap` did not.
 *
 * ⚠ THIS IS NOT A BAN ON cqw. Most cqw declarations here are overrides sitting
 * on a plain-px base, and those degrade correctly on their own — a rule
 * demanding every one be wrapped would be wrong and would get switched off.
 * What is pinned is the narrow set that had NO non-container value anywhere in
 * the cascade, so the property fell to its initial value.
 *
 * ⚠ AND `var()` IS WHY IT MUST BE `@supports` RATHER THAN TWO DECLARATIONS.
 * A custom property is substituted at COMPUTED-VALUE time, so
 * `padding: var(--shelf-pad-y) …` parses fine on an old engine, WINS the
 * cascade, and only then fails — and invalid-at-computed-value-time resets the
 * property to its initial value rather than falling back to the declaration
 * above it. The two-declaration trick reads correctly in the file and still
 * ships zero padding, which is the worst of both.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UI = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');
const SHELF = fs.readFileSync(path.join(UI, 'Shelf.css'), 'utf8');
const APPROACH = fs.readFileSync(path.join(UI, 'Approach.css'), 'utf8');

// ⚠ Comments are stripped before anything is matched. Three separate scans in
// this repo have been fooled by a name inside a comment — including one written
// this same week, whose comment explaining a rule then failed that rule.
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Parse a stylesheet into flat rules. Each entry records its selector, its body
 * and whether it sits inside an at-rule — which is the distinction the whole
 * file turns on: a declaration that exists ONLY inside `@supports` is not a
 * fallback, it is the thing the fallback is for.
 */
function parseRules(css) {
  const src = strip(css);
  const out = [];
  let i = 0;
  const walk = (start, end, inAtRule, atPrelude) => {
    let j = start;
    let sel = '';
    while (j < end) {
      const ch = src[j];
      if (ch === '{') {
        let depth = 1;
        let k = j + 1;
        while (depth > 0 && k < end) {
          if (src[k] === '{') depth += 1;
          else if (src[k] === '}') depth -= 1;
          k += 1;
        }
        const body = src.slice(j + 1, k - 1);
        const selector = sel.trim();
        if (selector.startsWith('@')) {
          walk(j + 1, k - 1, true, selector);
          out.push({ selector, body, inAtRule, atPrelude, isAtRule: true });
        } else {
          out.push({ selector, body, inAtRule, atPrelude, isAtRule: false });
        }
        sel = '';
        j = k;
        continue;
      }
      if (ch === '}') { sel = ''; j += 1; continue; }
      sel += ch;
      j += 1;
    }
  };
  walk(i, src.length, false, null);
  return out;
}

// The declarations of a rule, ignoring anything nested inside it.
//
// ⚠ A DECLARATION IS A PROPERTY NAME AND A COLON, not merely non-empty text.
// Stripping the nested rules out of an `@supports` body leaves the bare
// SELECTORS behind, and counting those as declarations made the stranded-
// declaration scan below report every healthy guard block as broken. A key
// like `.shelf__btn:focus-visible` would slip through a colon test alone, so
// the key must look like a CSS property.
function decls(body) {
  return body.replace(/\{[^{}]*\}/g, '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => /^[-a-z]+\s*:/i.test(d));
}

const CONTAINER_UNIT = /\d(cqw|cqi|cqh|cqb|cqmin|cqmax)\b/;

// Does this rule give `prop` a value that does NOT depend on container units?
function hasPlainValue(rule, prop) {
  return decls(rule.body).some((d) => {
    const at = d.indexOf(':');
    if (at < 0) return false;
    if (d.slice(0, at).trim() !== prop) return false;
    return !CONTAINER_UNIT.test(d.slice(at + 1));
  });
}

// The BASE rules — the ones outside any at-rule — matching a selector exactly.
function baseRules(css, selector) {
  const found = parseRules(css).filter((r) => !r.isAtRule && !r.inAtRule
    && r.selector.replace(/\s+/g, ' ') === selector);
  assert.ok(found.length > 0, `no base rule for "${selector}"`); // positive control
  return found;
}

const SHELF_PILL = '.shelf__btn, .shelf__wx';

test('⚠ the shelf pills keep a padding an old engine can use', () => {
  const rules = baseRules(SHELF, SHELF_PILL);
  assert.ok(rules.some((r) => hasPlainValue(r, 'padding')),
    'the only padding is container-unit valued — it computes to ZERO where cqw is unknown');
});

test('⚠ the shelf pills keep their FILL outside the @supports block', () => {
  // The first cut of the fallback closed the base rule after the padding line
  // and stranded these inside `@supports`, so on the very engine the fallback
  // exists for, the pills lost their fill and rendered as white default
  // buttons. Valid CSS either way; only a render of the degraded path showed it.
  const rules = baseRules(SHELF, SHELF_PILL);
  for (const prop of ['background', 'color', 'font']) {
    assert.ok(rules.some((r) => decls(r.body).some((d) => d.startsWith(`${prop}:`))),
      `${prop} must sit in the base rule, or the pills lose it exactly where the fallback is needed`);
  }
});

test('⚠ the shelf row and the shelf column keep a gap an old engine can use', () => {
  for (const sel of ['.shelf__row', '.shelf']) {
    assert.ok(baseRules(SHELF, sel).some((r) => hasPlainValue(r, 'gap')),
      `${sel}: the only gap is container-unit valued — the pills touch where cqw is unknown`);
  }
});

test('⚠ a fact card keeps a padding an old engine can use', () => {
  assert.ok(baseRules(APPROACH, '.approach__fact').some((r) => hasPlainValue(r, 'padding')),
    'the card text sits on its own border where cqw is unknown');
});

test('⚠ the POSITIONED facts row keeps a gap an old engine can use', () => {
  // Deliberately the winning rule, the one carrying `bottom:`. The base
  // `.approach__row { gap: 6px }` is what was visible on the tablet, and a 6px
  // gutter between four full-width cards is the symptom, not the fallback.
  const positioned = baseRules(APPROACH, '.approach--quiet .approach__row')
    .filter((r) => decls(r.body).some((d) => d.startsWith('bottom:')));
  assert.ok(positioned.length > 0, 'the positioned facts-row rule is gone'); // positive control
  assert.ok(positioned.some((r) => hasPlainValue(r, 'gap')),
    'the positioned row gap is container-unit only, so it falls back to the 6px base');
});

test('⚠ every @supports guard tests a container unit, not something else', () => {
  // A guard written against the wrong feature is a block that never runs, or
  // always runs, and either way the fallback stops meaning anything.
  // ⚠ No leading \b in the unit pattern: in `1cqw` the digit and the `c` are
  // both word characters, so there is no boundary between them — the first cut
  // of this assertion could never match its own condition.
  for (const [name, css] of [['Shelf.css', SHELF], ['Approach.css', APPROACH]]) {
    const guards = parseRules(css).filter((r) => r.isAtRule && r.selector.startsWith('@supports'));
    assert.ok(guards.length > 0, `${name}: no @supports guards at all`); // positive control
    for (const g of guards) {
      assert.match(g.selector, /cq(w|i|h|b|min|max)\b/,
        `${name}: "${g.selector}" does not test a container unit`);
    }
  }
});

test('⚠ no declaration is stranded directly inside an @supports block', () => {
  // The fill bug above, as a general rule: an `@supports` body must contain
  // only nested rules. A property sitting loose in it belongs to nothing and is
  // silently dropped from the rule it was meant to be part of.
  for (const [name, css] of [['Shelf.css', SHELF], ['Approach.css', APPROACH]]) {
    const guards = parseRules(css).filter((r) => r.isAtRule && r.selector.startsWith('@supports'));
    assert.ok(guards.length > 0, `${name}: scan found no @supports blocks`); // positive control
    for (const g of guards) {
      assert.deepEqual(decls(g.body), [],
        `${name}: declarations stranded directly inside ${g.selector}`);
    }
  }
});
