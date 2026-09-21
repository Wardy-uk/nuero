#!/usr/bin/env node
'use strict';

/**
 * The PWA's look, exported into Swift.
 *
 * ⚠ `frontend/src/index.css` IS THE SOURCE. NEURO's visual language is twenty
 * custom properties in one `:root` block, and iOS had none of them — every
 * screen was stock SwiftUI, which is why the native app reads as Settings while
 * the PWA reads as NEURO. Measured 13 Sep 2026: 35 of 40 SwiftUI view files used
 * no colour or type of their own.
 *
 * ⚠ GENERATED, NOT COPIED BY HAND. A second palette maintained in Swift is the
 * `voiceUtils.js` drift with a compiler in front of it: the two would agree on
 * the day they were written and never again. This is the same shape as
 * `export-widget-to-vault.js` — one source, one generator, re-run on change.
 *
 * ⚠ THE TWO REPOS CANNOT SHARE CODE (`Wardy-uk/nuero` and `Wardy-uk/nuero-ios`
 * are separate checkouts), which is the `PRICES_PER_MTOK` situation exactly. So
 * the generated file carries the SOURCE HASH, and `design-tokens.test.js` fails
 * when the CSS moves without the exporter being re-run — the drift is made
 * visible on the side that owns the truth, because the other side cannot see it.
 *
 *   node backend/scripts/export-design-tokens.js            # write it
 *   node backend/scripts/export-design-tokens.js --check    # is it current?
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const CSS = path.join(REPO, 'frontend', 'src', 'index.css');
/**
 * Sibling checkout. Absent on the Pi and on CI, which is not an error: the
 * exporter is a developer tool, and it says so rather than failing a deploy.
 *
 * ⚠⚠ BOTH SPELLINGS, AND THAT IS NOT TIDINESS — IT IS WHY THIS GUARD WAS DEAD.
 * The GitHub repo is `nuero-ios` (the historical typo) and the checkout on the
 * Mac is `neuro-ios`, so a literal `'nuero-ios'` found nothing and
 * `design-tokens.test.js` SKIPPED with *"no nuero-ios checkout beside this
 * repo"* — on the one machine that has the iOS app and is the only place the
 * comparison can ever be made. The test documents itself as the thing standing
 * between two palettes and silent divergence, and it had not run once here.
 * Measured on 20 Sep 2026: nothing had drifted (both sides at 6bf36d36dee6), so
 * this cost nothing YET, which is exactly why it could have run for months.
 *
 * ⚠ `export-desktop-agent.js` in this directory already tried both names. Two
 * cross-repo tools in one repo disagreeing about where the sibling lives is how
 * one of them ends up inert while the other looks like proof it works.
 */
function findIOSCheckout() {
  for (const name of ['neuro-ios', 'nuero-ios']) {
    const dir = path.resolve(REPO, '..', name);
    // ⚠ A `.git` or the NeuroKit tree, never the bare name — a stale empty
    // folder left beside the repo must not be mistaken for the checkout and
    // silently become the thing we compare against.
    if (!fs.existsSync(dir)) continue;
    if (fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, 'NeuroKit'))) return dir;
  }
  return null;
}

const IOS = findIOSCheckout();
const OUT = IOS ? path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'Theme.swift') : null;

/**
 * The `:root` block, and only that. A token declared inside a media query or a
 * component file is deliberately NOT exported — those are overrides for a
 * context iOS does not have, and exporting one would hand Swift a value that is
 * conditional on a screen width.
 */
function readTokens(css) {
  const root = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!root) throw new Error('no :root block in index.css — has the token block moved?');
  const tokens = {};
  for (const line of root[1].split('\n')) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (!m) continue;
    const [, name, value] = m;
    // `env(safe-area-inset-*)` is a browser viewport fact with no Swift
    // equivalent — SwiftUI has its own safe area and reading ours would fight it.
    if (/^sa[tblr]$/.test(name)) continue;
    tokens[name] = value.trim();
  }
  return tokens;
}

const HEX = /^#([0-9a-f]{6})$/i;

function swiftColour(hex) {
  const m = hex.match(HEX);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const f = (v) => v.toFixed(4);
  return `Color(.sRGB, red: ${f(r)}, green: ${f(g)}, blue: ${f(b)}, opacity: 1)`;
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function px(value) {
  const m = String(value).match(/^(-?[\d.]+)px$/);
  return m ? Number(m[1]) : null;
}

function build(tokens, sourceHash) {
  const colours = [];
  const metrics = [];
  const fonts = [];

  for (const [name, value] of Object.entries(tokens)) {
    const hex = swiftColour(value);
    if (hex) { colours.push([name, hex, value]); continue; }
    const size = px(value);
    if (size !== null) { metrics.push([name, size, value]); continue; }
    const font = value.match(/^'([^']+)'/);
    if (font) { fonts.push([name, font[1], value]); continue; }
    // Anything else — a shadow, a gradient — is left out rather than guessed
    // at. SwiftUI shadows take separate arguments and a CSS string is not one.
  }

  const lines = [];
  lines.push('// GENERATED by backend/scripts/export-design-tokens.js — DO NOT EDIT.');
  lines.push('//');
  lines.push('// Source: frontend/src/index.css  (sha256 ' + sourceHash.slice(0, 12) + ')');
  lines.push('// Re-run the exporter after changing the CSS; `--check` fails when this');
  lines.push('// file is behind.');
  lines.push('');
  lines.push('import SwiftUI');
  lines.push('');
  lines.push('/// NEURO\'s look, from the PWA\'s own token block.');
  lines.push('///');
  lines.push('/// ⚠ ONE SOURCE. These twenty values are what makes the web app read as');
  lines.push('/// NEURO, and iOS had none of them — 35 of 40 view files were stock SwiftUI');
  lines.push('/// on 13 Sep 2026, which is why the native app looked like Settings.');
  lines.push('///');
  lines.push('/// ⚠ Do not hand-edit: a second palette maintained in Swift agrees with the');
  lines.push('/// CSS on the day it is written and never again.');
  lines.push('public enum Theme {');
  lines.push('');
  lines.push('    // MARK: Colour');
  for (const [name, swift, raw] of colours) {
    lines.push(`    /// \`--${name}\`: ${raw}`);
    lines.push(`    public static let ${camel(name)} = ${swift}`);
  }
  lines.push('');
  lines.push('    // MARK: Metrics');
  for (const [name, size, raw] of metrics) {
    lines.push(`    /// \`--${name}\`: ${raw}`);
    lines.push(`    public static let ${camel(name)}: CGFloat = ${size}`);
  }
  lines.push('');
  lines.push('    // MARK: Type');
  lines.push('    //');
  lines.push('    // ⚠ NAMES ONLY. The PWA loads these from Google Fonts; an iOS app needs');
  lines.push('    // the TTFs in its bundle and a `UIAppFonts` entry. Until they are added,');
  lines.push('    // `font(_:size:)` falls back to the system face at the same size rather');
  lines.push('    // than failing — a missing font must not be a blank screen.');
  for (const [name, family, raw] of fonts) {
    lines.push(`    /// \`--${name}\`: ${raw}`);
    lines.push(`    public static let ${camel(name)} = "${family}"`);
  }
  lines.push('');
  lines.push('    /// The named face at a size, falling back to the system one.');
  lines.push('    public static func font(_ family: String, size: CGFloat,');
  lines.push('                           relativeTo style: Font.TextStyle = .body) -> Font {');
  lines.push('        #if canImport(UIKit)');
  lines.push('        if UIFont(name: family, size: size) == nil {');
  lines.push('            return .system(size: size)');
  lines.push('        }');
  lines.push('        #endif');
  lines.push('        return .custom(family, size: size, relativeTo: style)');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * Same text, whatever git did to the newlines on the way through.
 *
 * ⚠ NEWLINES ARE NOT DRIFT. The iOS checkout is on Windows with git normalising
 * to CRLF, and this writes LF — so a byte comparison reports the file stale on
 * EVERY run, for ever. A check that fails for a reason unrelated to what it is
 * checking is one that gets switched off, and it takes the real catch with it.
 *
 * ⚠ Built with `String.split`/`join` rather than a regex literal: this function
 * was first written through a shell heredoc, which ate the backslashes and left
 * raw newlines inside `/\r\n/g` — a syntax error that took the whole file down.
 * Third time that pipeline has bitten in this repo.
 */
function sameIgnoringNewlines(a, b) {
  if (a == null || b == null) return false;
  const lf = (s) => s.split(String.fromCharCode(13) + String.fromCharCode(10))
    .join(String.fromCharCode(10));
  return lf(a) === lf(b);
}

function generate() {
  const css = fs.readFileSync(CSS, 'utf8');
  const tokens = readTokens(css);
  const hash = crypto.createHash('sha256').update(css).digest('hex');
  return { source: build(tokens, hash), tokens, hash };
}

function main() {
  const check = process.argv.includes('--check');
  const { source, tokens } = generate();

  // ⚠ A NULL CHECK, not `existsSync(IOS)`. `findIOSCheckout` answers null when
  // there is none, and `fs.existsSync(null)` happens to return false rather
  // than throwing — so the old shape would keep working by accident and stop
  // the day that coercion changes.
  if (!IOS) {
    // Not a failure: the iOS checkout is a developer's sibling directory.
    console.log('[design-tokens] no iOS checkout beside this repo — nothing to write');
    console.log(`[design-tokens] read ${Object.keys(tokens).length} tokens from index.css`);
    return;
  }

  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  // ⚠ LINE ENDINGS ARE NOT DRIFT. The iOS checkout is on Windows with git
  // normalising to CRLF, and this writes LF — so a byte comparison reports the
  // file as stale on every single run, for ever. That is the email-triage time
  // bomb wearing different clothes: a check that fails for a reason unrelated to
  // what it is checking gets switched off, and takes the real catch with it.
  if (sameIgnoringNewlines(current, source)) {
    console.log('[design-tokens] Theme.swift is current');
    return;
  }
  if (check) {
    console.error('[design-tokens] Theme.swift is BEHIND index.css — re-run the exporter');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, source, 'utf8');
  console.log(`[design-tokens] wrote ${path.relative(REPO, OUT)} (${Object.keys(tokens).length} tokens)`);
}

if (require.main === module) main();

module.exports = { readTokens, swiftColour, camel, px, build, generate,
                   sameIgnoringNewlines, CSS, OUT };
