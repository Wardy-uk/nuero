/**
 * Short display titles for household tasks on the family wall (17 Oct 2026).
 *
 * The wall has room for a few words, and a task is often a sentence ("Book my
 * car in for its MOT tomorrow (8 October 2026). Must do tomorrow."). This makes
 * a 2–5 word label for DISPLAY ONLY — the task record is never changed, and the
 * wall shows the full original wording when a task is tapped.
 *
 * Two layers, so there is always an answer:
 *   1. `ruleTitle` (PURE, instant): the first clause, without dates, time words,
 *      brackets or "must do"; "my car" becomes the household's car by model when
 *      NEURO holds exactly one current vehicle.
 *   2. A model rewrite via ai-routing, cached per task and wording. It is used
 *      only if `acceptable` passes: every word must come from the original
 *      task, the car's name, or a short list of plain verbs/nouns — so a model
 *      cannot add a fact (a date, a person, a place) the task does not hold.
 *
 * ⚠ A date in a title is never read as the task's due date (the MOT task's
 * title carries a long-past date); dates are simply dropped from the label.
 */

const crypto = require('crypto');

const CACHE_KEY = 'task_display_titles';
const MAX_WORDS = 5;
const MAX_CHARS = 34;
const TASK_TYPE = 'task_short_title';

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const DATE_RES = [
  new RegExp(`\\b(?:on|by|before|for|from|until)?\\s*\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b(?:on|by|before|for|from|until)?\\s*(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
  /\b(?:on|by|before|for|from|until)?\s*\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b(?:on|by|before|this|next|every)?\\s*(?:${DAYS})\\b`, 'gi'),
  /\b(?:by\s+)?(?:today|tonight|tomorrow|this\s+(?:week|weekend|month)|next\s+(?:week|month)|asap)\b/gi,
  /\bmust\s+do\b/gi,
];
const LEADING = /^(?:i\s+(?:need|have)\s+to|we\s+(?:need|have)\s+to|need\s+to|remember\s+to|don'?t\s+forget\s+to|please|reminder:?|todo:?|to\s+do:?)\s+/i;

// Plain words a short title may use even when the task does not (verbs and a
// few generic nouns). Anything outside this, the task and the car's name is a
// word the model invented.
const PLAIN = new Set(('add apply arrange ask book buy call cancel check choose clean collect complete '
  + 'confirm contact do enter fill finish fix get order organise pay plan post read record register '
  + 'renew reply return review send set sort start submit take update upload write '
  + 'details info form forms bills bill payments renewals appointment loan application list the a an for in of to and')
  .split(' '));

const STOP = new Set(['the', 'a', 'an', 'for', 'in', 'of', 'to', 'and', 'my', 'our', 'its', 'it']);
const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Very light stemming so "fill"/"filling", "detail"/"details" agree.
const stem = (w) => norm(w).replace(/(?:ing|ed|es|s)$/, '');

function hash(text) { return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12); }

/** Words joined until MAX_WORDS / MAX_CHARS, never cutting a word. PURE. */
function fit(words) {
  const out = [];
  for (const w of words) {
    if (out.length >= MAX_WORDS) break;
    if ((out.join(' ') + ' ' + w).trim().length > MAX_CHARS) break;
    out.push(w);
  }
  return out.join(' ');
}

/**
 * The rules title. PURE. `ctx.car` is the household's car name (e.g. "Captur")
 * when NEURO holds exactly one current vehicle, else null.
 */
function ruleTitle(text, ctx = {}) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  // First clause: a sentence end, a colon, a dash between spaces, or a semicolon.
  t = t.split(/(?:[.!?;](?:\s|$)|:\s|\s[—–-]\s)/)[0];
  for (const re of DATE_RES) t = t.replace(re, ' ');
  t = t.replace(LEADING, '');
  if (ctx.car) t = t.replace(/\b(?:my|our|the)\s+car\b/gi, ctx.car);
  // "Book X in for its MOT" → "Book X MOT": the joining words carry nothing.
  t = t.replace(/\s+in\s+for\s+(?:its|it'?s|his|her|their|a|an|the)\s+/gi, ' ');
  t = t.replace(/\s+/g, ' ').trim().replace(/[\s,]+$/, '');
  const words = t.split(' ').filter(Boolean);
  const titled = fit(words);
  return titled ? titled.charAt(0).toUpperCase() + titled.slice(1) : String(text).trim().slice(0, MAX_CHARS);
}

/**
 * Whether a model's title may be shown. PURE. Every word must come from the
 * original task, the car's name, or the PLAIN list; no digits; 1–5 words.
 */
function acceptable(title, text, ctx = {}) {
  const t = String(title || '').trim().replace(/^["'“”]+|["'“”.]+$/g, '');
  if (!t || /\d/.test(t) || t.length > MAX_CHARS + 6) return null;
  const words = t.split(/\s+/);
  if (words.length < 1 || words.length > MAX_WORDS) return null;
  const allowed = new Set(String(text || '').split(/[^A-Za-z0-9']+/).map(stem).filter(Boolean));
  if (ctx.car) allowed.add(stem(ctx.car));
  for (const w of words) {
    const s = stem(w);
    if (!s) continue;
    if (allowed.has(s) || PLAIN.has(norm(w)) || PLAIN.has(s)) continue;
    return null;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function prompt(text, ctx) {
  return [
    'Write a short label (2 to 5 words) for this household to-do, for a wall display.',
    'Rules: use only words from the task itself or plain verbs (book, complete, renew, pay, apply, record, fix).',
    'No dates, no times, no names that are not in the task. Start with a verb. Reply with the label only.',
    ctx.car ? `The household's car is a ${ctx.car}; "my car" means the ${ctx.car}.` : '',
    `Task: ${String(text).slice(0, 300)}`,
  ].filter(Boolean).join('\n');
}

/** The household car's name when NEURO holds exactly one current vehicle. */
function carName() {
  try {
    const db = require('../db/database');
    const rows = db.getDb().prepare("SELECT model FROM vehicles WHERE ownership_state = 'current'").all();
    return rows.length === 1 && rows[0].model ? String(rows[0].model) : null;
  } catch { return null; }
}

function readCache() {
  try { return JSON.parse(require('../db/database').getState(CACHE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeCache(c) {
  try { require('../db/database').setState(CACHE_KEY, JSON.stringify(c)); } catch { /* next call retries */ }
}

const inFlight = new Set();

/**
 * Short titles for a list of tasks ({id, text}). Synchronous: a cached model
 * title when it matches the current wording, else the rules title. Missing ones
 * are asked for in the background (`refresh`), never on the request's time.
 */
function titlesFor(tasks = []) {
  const cache = readCache();
  const ctx = { car: carName() };
  const out = {};
  const missing = [];
  for (const t of tasks) {
    const h = hash(t.text);
    const hit = cache[t.id];
    if (hit && hit.hash === h && hit.title) out[t.id] = hit.title;
    else { out[t.id] = ruleTitle(t.text, ctx); if (!(hit && hit.hash === h)) missing.push(t); }
  }
  // Never from a test run: the background request would reach a real model.
  if (missing.length && !process.env.NODE_TEST_CONTEXT) refresh(missing, ctx).catch(() => {});
  return out;
}

/** Ask the model for titles it does not have yet; cache each answer (or its refusal). */
async function refresh(tasks, ctx = { car: carName() }) {
  const aiRouting = require('./ai-routing');
  for (const t of tasks.slice(0, 5)) {
    const key = `${t.id}:${hash(t.text)}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      const res = await aiRouting.runTask(TASK_TYPE, { prompt: prompt(t.text, ctx), maxTokens: 24 });
      const ok = acceptable(String((res && res.text) || '').split('\n')[0], t.text, ctx);
      const cache = readCache();
      // A refused answer is cached too (title null), so a bad rewrite is not
      // re-bought on every poll; the rules title is shown instead.
      cache[t.id] = { hash: hash(t.text), title: ok, by: ok ? 'model' : 'rules', at: new Date().toISOString() };
      writeCache(cache);
    } catch { /* AI off or failing: the rules title stands; try again next time */ } finally { inFlight.delete(key); }
  }
}

module.exports = { ruleTitle, acceptable, titlesFor, refresh, carName, TASK_TYPE, MAX_WORDS };
