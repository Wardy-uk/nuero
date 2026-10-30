'use strict';

/**
 * The single way in (30 Oct 2026). Nick: "rebuild the capture box to be able
 * to capture everything that NEURO captures everywhere — single way in".
 *
 * Three jobs, and deliberately no fourth:
 *
 * 1. KINDS — the closed list of chips the box offers, with the fields each
 *    needs. Most kinds are filed by the route that ALREADY owns that record
 *    (the box adds no second writer — a second writer is how two screens come
 *    to disagree about one thing). `door` names where the client sends it.
 * 2. classify() — guesses a chip. Rules first (instant, free, offline); the
 *    model only when the rules are unsure. It only GUESSES: the client shows
 *    the chip and Nick confirms. Nothing is filed on a guess he has not seen.
 * 3. file() — the doors that did not exist for a PIN client: waiting-on,
 *    decision and memory had no way in at all, and household job / tea / wall
 *    note / shopping were reachable only with a VESTA family login.
 */

const crypto = require('crypto');

const T = (name, label, extra = {}) => ({ name, label, type: 'text', ...extra });

// ── The chips ────────────────────────────────────────────────────────────────
// `door` is the endpoint the client posts to; `hub` means POST /api/capture-hub/file.
const KINDS = [
  // Quick — one line of text, maybe one small extra.
  { id: 'task', label: 'Task', group: 'quick', door: '/api/capture/todo', hint: 'Onto your task list' },
  { id: 'done', label: 'Done', group: 'quick', door: '/api/tasks/quick-log', hint: 'Something you already did — logged as a finished task and a win' },
  { id: 'note', label: 'Note', group: 'quick', door: '/api/capture/note', hint: 'A note in the vault' },
  { id: 'chris', label: 'For Chris', group: 'quick', door: '/api/weekly-risk/chris-agenda', hint: 'Into the Weekly Risk report until you tick it off' },
  { id: 'waiting', label: 'Waiting on', group: 'quick', door: 'hub', hint: 'Someone owes you this',
    fields: [T('person', 'Who owes it', { required: true, optionsFrom: 'people', free: true })] },
  { id: 'decision', label: 'Decision', group: 'quick', door: 'hub', hint: 'Into the Decision Log' },
  { id: 'feature', label: 'Feature idea', group: 'quick', door: '/api/capture/feature', hint: 'Into the feature tracker',
    fields: [T('system', 'System', { type: 'select', options: ['NEURO', 'SAiM', 'NOVA', 'VANTAGE'] })] },
  { id: 'memory', label: 'Remember', group: 'quick', door: 'hub', hint: 'A fact about you for NEURO to keep (MCP Memories)' },
  { id: 'journal', label: 'Journal', group: 'quick', door: '/api/journal/save', hint: "Into today's journal" },
  { id: 'household', label: 'Household job', group: 'quick', door: 'hub', hint: 'On the family wall and VESTA' },
  { id: 'shopping', label: 'Shopping', group: 'quick', door: 'hub', hint: 'On the shared shopping list' },
  { id: 'tea', label: "Tea", group: 'quick', door: 'hub', hint: "What's for tea, on the family wall",
    fields: [T('date', 'Day', { type: 'date', required: true, default: 'today' })] },
  { id: 'wall-note', label: 'Wall note', group: 'quick', door: 'hub', hint: 'A note on the family wall (140 characters, gone after 2 days)' },
  { id: 'catalogue', label: 'Catalogue', group: 'quick', door: 'catalogue', hint: 'Add to one of your catalogues',
    fields: [T('slug', 'Catalogue', { type: 'select', required: true, optionsFrom: 'catalogues' }),
      T('section', 'Section', { type: 'select', required: true, optionsFrom: 'catalogueSections' })] },

  // Forms — a record of something that happened, with the fields it needs.
  { id: 'mgmt-log', label: 'Management log', group: 'form', door: '/api/weekly-risk/log', hint: 'A conversation, concern or action with a named person',
    fields: [T('type', 'Type', { type: 'select', options: ['conversation', 'concern', 'action'], default: 'action' }),
      T('person', 'With', { optionsFrom: 'people', free: true }),
      T('dueDate', 'Due', { type: 'date' })] },
  { id: 'report-fix', label: 'Report fix', group: 'form', door: '/api/report-fixes/manual', hint: 'Into the fixes log for SOAP and Weekly Risk (you include it there)',
    fields: [T('system', 'System', { type: 'select', required: true, options: ['nova', 'vantage', 'neuro', 'n8n', 'other'] }),
      T('problem', 'What was wrong', { type: 'textarea', required: true }),
      T('impact', 'Impact', { type: 'multi', required: true, options: ['figures', 'team', 'customers'] }),
      T('measure', 'Figure affected (if figures)'), T('from', 'Affected from', { type: 'date' }), T('to', 'Affected to', { type: 'date' }),
      T('deployedOn', 'Deployed on', { type: 'date', required: true, default: 'today' })] },
  { id: 'blocker', label: 'Project blocker', group: 'form', door: 'blocker', hint: 'Something blocking a personal project',
    fields: [T('projectId', 'Project', { type: 'select', required: true, optionsFrom: 'projects' }), T('unblock', 'What would unblock it')] },
  { id: 'date', label: 'Birthday / anniversary', group: 'form', door: '/api/loops/personal-dates/declared', hint: "Written into the person's note",
    fields: [T('entity', 'Whose', { type: 'select', required: true, optionsFrom: 'dateEntities' }),
      T('kind', 'Kind', { type: 'select', required: true, options: ['birthday', 'anniversary'], default: 'birthday' }),
      T('date', 'Date', { type: 'date', required: true })] },
  { id: 'care', label: 'Ember care', group: 'form', door: 'care', hint: "A care item for a companion",
    fields: [T('companionId', 'Who', { type: 'select', required: true, optionsFrom: 'companions' }),
      T('kind', 'Kind', { type: 'select', required: true, options: ['walk', 'vet', 'vaccination', 'flea', 'worm', 'medication', 'grooming', 'insurance', 'other'] }),
      T('dueDate', 'Due', { type: 'date' })] },
  { id: 'finance', label: 'Bill / renewal', group: 'form', door: '/api/finance/obligations', hint: 'A money obligation that needs you',
    fields: [T('kind', 'Kind', { type: 'select', required: true, options: ['renewal', 'bill', 'annual_fee', 'subscription_renewal', 'household_charge', 'other'] }),
      T('dueDate', 'Due', { type: 'date', required: true }), T('amount', 'Expected £', { type: 'number' })] },
  { id: 'mileage', label: 'Mileage', group: 'form', door: 'mileage', hint: 'An odometer reading',
    fields: [T('vehicleId', 'Vehicle', { type: 'select', required: true, optionsFrom: 'vehicles' }),
      T('value', 'Miles', { type: 'number', required: true }), T('observedOn', 'On', { type: 'date', required: true, default: 'today' })] },
  { id: 'fuel', label: 'Fuel fill', group: 'form', door: 'fuel', hint: 'A fuel fill',
    fields: [T('vehicleId', 'Vehicle', { type: 'select', required: true, optionsFrom: 'vehicles' }),
      T('litres', 'Litres', { type: 'number', required: true }), T('odometer', 'Odometer', { type: 'number', required: true }),
      T('fullTank', 'Brim full', { type: 'checkbox', default: true }), T('filledOn', 'On', { type: 'date', required: true, default: 'today' })] },
  { id: 'leisure', label: 'Leisure', group: 'form', door: '/api/leisure/items', hint: 'Something to watch, read, play or listen to',
    fields: [T('kind', 'Kind', { type: 'select', required: true, options: ['tv_series', 'film', 'book', 'game', 'album', 'artist', 'podcast', 'audiobook', 'hobby', 'other'] }),
      T('creator', 'By'), T('state', 'State', { type: 'select', options: ['saved', 'active', 'completed'], default: 'saved' })] },
  { id: 'goal', label: 'Goal', group: 'form', door: '/api/canonical/goals', hint: 'A goal on Life → Goals',
    fields: [T('reviewDate', 'Review by', { type: 'date' })] },
];

const KIND_IDS = new Set(KINDS.map((k) => k.id));

// ── Rules ────────────────────────────────────────────────────────────────────
// Each rule: a pattern, the kind, and an optional prefix to strip / prefill.
// An EXPLICIT prefix ("chris:", "done:") is SURE; a phrase match is LIKELY;
// anything the rules cannot place goes to the model, then falls back to Note.
const PREFIXES = [
  [/^(todo|task|action|reminder)\s*:\s*/i, 'task'],
  [/^(done|did)\s*:\s*/i, 'done'],
  [/^note\s*:\s*/i, 'note'],
  [/^chris\s*:\s*/i, 'chris'],
  [/^(wait(ing)?(\s+on)?|owes?)\s*:\s*/i, 'waiting'],
  [/^(decision|decided)\s*:\s*/i, 'decision'],
  [/^(feature|idea)\s*:\s*/i, 'feature', {}],
  [/^(neuro|saim|sara|nova|vantage)\s*:\s*/i, 'feature', null],
  [/^(remember|memory)\s*:\s*/i, 'memory'],
  [/^journal\s*:\s*/i, 'journal'],
  [/^(house|household|home job)\s*:\s*/i, 'household'],
  [/^(shop|shopping|buy)\s*:\s*/i, 'shopping'],
  [/^tea\s*:\s*/i, 'tea'],
  [/^(wall|wall note)\s*:\s*/i, 'wall-note'],
  [/^(log|mgmt)\s*:\s*/i, 'mgmt-log'],
  [/^fix\s*:\s*/i, 'report-fix'],
  [/^blocked?\s*:\s*/i, 'blocker'],
  [/^(fuel|filled)\s*:\s*/i, 'fuel'],
  [/^(miles|mileage|odometer)\s*:\s*/i, 'mileage'],
  [/^goal\s*:\s*/i, 'goal'],
];
const FEATURE_SYSTEM = { neuro: 'NEURO', saim: 'SAiM', sara: 'SAiM', nova: 'NOVA', vantage: 'VANTAGE' };

const PHRASES = [
  [/\b(ask|tell|raise with|speak to|talk to|mention to|check with)\s+chris\b/i, 'chris'],
  [/\bfor chris\b/i, 'chris'],
  [/^(i\s+)?(just\s+)?(did|done|finished|completed|sorted|fixed|sent|called|replied to|booked)\b/i, 'done'],
  [/\b(owes me|waiting (on|for)|chasing|to (get|send) (me|back to me))\b/i, 'waiting'],
  [/^(we|i)\s+(decided|agreed)\b|\bdecision\b/i, 'decision'],
  [/\b(filled up|litres?|ltrs?)\b.*\d|\d.*\b(litres?|ltrs?)\b/i, 'fuel'],
  [/\b(odometer|mileage)\b.*\d/i, 'mileage'],
  [/\b(birthday|anniversary)\b/i, 'date'],
  [/\b(we need|we're out of|run out of|need to buy)\b/i, 'shopping'],
  [/\b(for tea|tea tonight|dinner tonight)\b/i, 'tea'],
  [/\b(ember)\b.*\b(vet|flea|worm|vaccin|groom|insurance)|\b(vet|flea|worm|vaccin)\w*\b.*\bember\b/i, 'care'],
  [/\b(renewal|renews|direct debit|bill due|subscription)\b/i, 'finance'],
  [/\b(watch|read|listen to|play)\b.*\b(series|film|movie|book|album|podcast|game)\b/i, 'leisure'],
  [/^(remember that|note to self: i)\b/i, 'memory'],
  [/^(buy|call|email|book|send|fix|update|check|schedule|remind|chase)\s/i, 'task'],
  [/^-?\s*\[.\]/, 'task'],
];

/** PURE. The rule-based guess. */
function classifyByRules(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: null, confidence: 'none', text: '', prefill: {}, by: 'rules' };
  for (const [re, kind] of PREFIXES) {
    const m = text.match(re);
    if (!m) continue;
    const rest = text.slice(m[0].length).trim();
    const prefill = {};
    if (kind === 'feature') {
      const sys = FEATURE_SYSTEM[m[1].toLowerCase()];
      if (sys) prefill.system = sys;
    }
    return { kind, confidence: 'sure', text: rest || text, prefill, by: 'prefix' };
  }
  for (const [re, kind] of PHRASES) {
    if (re.test(text)) return { kind, confidence: 'likely', text: cleanFor(kind, text), prefill: prefillFor(kind, text), by: 'rules' };
  }
  return { kind: null, confidence: 'none', text, prefill: {}, by: 'rules' };
}

/** PURE. The words worth keeping once the phrase that placed them is gone. */
function cleanFor(kind, text) {
  if (kind === 'shopping') return text.replace(/^(we need( to buy)?|we're out of|we are out of|run out of|need to buy)\s+/i, '').trim() || text;
  return text;
}

/** PURE. Numbers and names the rules can lift out of the words. */
function prefillFor(kind, text) {
  const out = {};
  if (kind === 'fuel') {
    const l = text.match(/(\d+(?:\.\d+)?)\s*(?:l\b|litres?|ltrs?)/i);
    if (l) out.litres = Number(l[1]);
    const o = text.match(/(?:at|odometer|odo)\s*([\d,]{3,})/i);
    if (o) out.odometer = Number(o[1].replace(/,/g, ''));
  }
  if (kind === 'mileage') {
    const o = text.match(/([\d,]{3,})/);
    if (o) out.value = Number(o[1].replace(/,/g, ''));
  }
  if (kind === 'waiting') {
    const p = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:owes|is sending|will send|to send|to get)/);
    if (p) out.person = p[1];
  }
  if (kind === 'date') out.kind = /anniversary/i.test(text) ? 'anniversary' : 'birthday';
  return out;
}

const AI_PROMPT = (text) => `Classify this note Nick typed into his capture box into ONE destination.
Destinations:
task (something he must do), done (something he already did), note (a thought to keep), chris (to raise with his manager Chris),
waiting (someone else owes him something), decision (a decision made), feature (an idea for his NEURO/SAiM/NOVA/VANTAGE software),
memory (a lasting fact about himself), journal (how he feels / reflection), household (a household job), shopping (an item to buy),
tea (what's for dinner), wall-note (a message for the family), mgmt-log (a management conversation or action with a staff member),
report-fix (a bug fix that changed a reported figure), blocker (something blocking a personal project), date (birthday/anniversary),
care (care for Ember the dog), finance (a bill or renewal), mileage, fuel, leisure (something to watch/read/play), goal.
Answer with ONLY the destination word.

Text: """${String(text).slice(0, 600)}"""`;

/** Rules, then the model when the rules are unsure. Never throws; Note is the floor. */
async function classify(raw, { ai = true } = {}) {
  const r = classifyByRules(raw);
  if (r.confidence !== 'none' || !r.text) return r;
  if (!ai) return { ...r, kind: 'note', confidence: 'default', by: 'default' };
  try {
    const res = await require('./ai-routing').runTask('capture_classify', { prompt: AI_PROMPT(r.text), maxTokens: 10 }, { forceCloud: true, timeout: 8000 });
    const word = String(res && res.text || '').trim().toLowerCase().replace(/[^a-z-]/g, '');
    if (KIND_IDS.has(word)) return { kind: word, confidence: 'likely', text: r.text, prefill: prefillFor(word, r.text), by: 'ai' };
  } catch { /* the floor below */ }
  return { ...r, kind: 'note', confidence: 'default', by: 'default' };
}

// ── Picker lists ─────────────────────────────────────────────────────────────
// One read for every select the forms need. Each list says whether it was read:
// an unreadable list is `null`, never [] (an empty picker reads as "you have none").
function options() {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const fs = require('fs');
  const path = require('path');
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  const notes = (dir) => safe(() => fs.readdirSync(path.join(vault, dir))
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
    .map((f) => f.slice(0, -3)).sort());
  const people = vault ? notes('People') : null;
  const companionsNotes = vault ? notes('Companions') : null;
  const catalogues = safe(() => {
    const r = require('./catalogue').list();
    return r && r.ok ? r.catalogues.filter((c) => !c.error) : null;
  });
  return {
    people: people,
    dateEntities: people || companionsNotes ? [
      ...(people || []).map((n) => ({ value: `People/${n}`, label: n })),
      ...(companionsNotes || []).map((n) => ({ value: `Companions/${n}`, label: n })),
    ] : null,
    vehicles: safe(() => require('./vehicle').listVehicles()
      .filter((v) => v.ownership_state === 'current')
      .map((v) => ({ value: v.vehicle_id, label: [v.make, v.model].filter(Boolean).join(' ') || v.vehicle_id }))),
    companions: safe(() => require('./personal-world').listCompanions().map((c) => ({ value: c.id, label: c.name }))),
    projects: safe(() => require('../db/database').all('SELECT project_id, name FROM projects ORDER BY name')
      .map((p) => ({ value: p.project_id, label: p.name }))),
    catalogues: catalogues ? catalogues.filter((c) => c.slug !== 'shopping').map((c) => ({ value: c.slug, label: c.title || c.slug, sections: c.sections || [] })) : null,
  };
}

// ── The new doors ────────────────────────────────────────────────────────────
function bad(msg, status = 400) { return { ok: false, status, error: msg }; }

function _memoryWrite(text) {
  const fs = require('fs');
  const path = require('path');
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault || !path.isAbsolute(vault) || !fs.existsSync(vault)) return bad('the vault is not reachable — nothing was saved', 503);
  // Same folder and shape the MCP memory_create tool writes, so both read alike.
  const dir = path.join(vault, process.env.MCP_MEMORY_DIR || 'MCP Memories');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const title = text.split('\n')[0].slice(0, 80);
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, `# ${title}\n\n${text}\n`, { flag: 'wx' });
  try { require('./vault-hooks').onVaultWrite(file, 'capture-hub'); } catch { /* indexing is not worth failing a capture for */ }
  return { ok: true, saved: `${process.env.MCP_MEMORY_DIR || 'MCP Memories'}/${id}.md` };
}

/** File one of the kinds whose door is `hub`. Returns { ok, ... } or { ok:false, status, error }. */
function file(kind, rawText, fields = {}, { by = 'nick' } = {}) {
  const text = String(rawText || '').trim();
  if (!text) return bad('nothing to capture — the text is empty');
  const label = by === 'nick' ? 'Nick' : by;
  switch (kind) {
    case 'waiting': {
      const person = String(fields.person || '').trim();
      if (!person) return bad('who owes it? A name is needed');
      const item = require('./waiting-on').record({ person, text, sourcePath: 'capture:neuro', sourceDate: null });
      if (!item) return bad('could not record that');
      return { ok: true, saved: `Waiting on ${item.personFull || item.person}`, key: item.key };
    }
    case 'decision': {
      const db = require('../db/database');
      db.saveDecision(null, text);
      let vault = true;
      try { require('./obsidian').appendDecision(text); } catch { vault = false; }
      return { ok: true, saved: vault ? 'Decision Log' : 'Decision recorded in NEURO — NOT written to the vault Decision Log' , partial: !vault };
    }
    case 'memory':
      return _memoryWrite(text);
    case 'household': {
      const ts = require('./task-store');
      const r = ts.createTask({ text, domain: 'personal', household: true, source: 'neuro-capture' });
      // A wording that folded into an existing task of his keeps that task — put
      // it on the household list rather than leaving it private and saying it is shared.
      if (r.created === false && r.task && r.task.household !== 1) ts.updateTask(r.id, { household: true });
      return { ok: true, saved: r.created === false ? 'Already a task — now on the household list too' : 'On the household list', taskId: r.id };
    }
    case 'shopping': {
      const r = require('./household-board').shoppingAdd({ name: text });
      return r && r.ok === false ? bad(r.error || r.why || 'not added') : { ok: true, saved: 'On the shopping list' };
    }
    case 'tea': {
      const r = require('./household-board').setTea({ date: fields.date, text }, { by: label });
      return r && r.ok === false ? bad(r.error || r.why || 'not saved') : { ok: true, saved: `Tea for ${fields.date}` };
    }
    case 'wall-note': {
      const r = require('./household-board').addNote({ text }, { by: label });
      return r && r.ok === false ? bad(r.error || r.why || 'not saved') : { ok: true, saved: 'On the family wall' };
    }
    default:
      return bad(`"${kind}" is not filed here`);
  }
}

/** The registry as the client needs it — data only. */
function kinds() { return KINDS; }

module.exports = { KINDS, kinds, classify, classifyByRules, prefillFor, options, file };
