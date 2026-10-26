'use strict';

/**
 * UAT volunteers — the store and the flow (26 Oct 2026). Rules are in
 * uat-volunteers-model.js; this file reads, writes and prepares.
 *
 *   detect     a triage pass finds a UAT email → one model call checks it asks
 *              for volunteers and reads the session → a round with one pick
 *              per pool ('proposed').
 *   invite     Nick's press: each pick becomes a governed compose_email with a
 *              one-use Confirm/Decline link ('invited'), sent by the same press.
 *   respond    the person opens the link and presses Confirm or Decline (the
 *              public /api/u route). A decline picks the next person in that
 *              pool, who waits for Nick's press.
 *   tick       every 5 min: invites that went → 'sent' (their window runs);
 *              a window that closed with no answer → 'accepted'; when every
 *              pool is confirmed/accepted → Dan's reply is prepared and Nick
 *              is pushed. Nothing is ever sent without his press.
 *
 * ⚠ The rota is derived: someone's turn is the last time an invite to them was
 * SENT and they did not decline. A decline keeps their place.
 * ⚠ The link token is stored here only as a SHA-256; the raw value exists in
 * the invite email (and so in the prepared draft that carries it).
 */

const crypto = require('crypto');
const db = require('../db/database');
const model = require('./uat-volunteers-model');

const SEEN_KEY = 'uat_seen_emails';
const SEEN_MAX = 300;
const MAX_DETECT_PER_PASS = 3;
const STALE_INVITE_MS = 60 * 60 * 1000; // a draft still unsent 1h before its stated deadline is redrafted

const DEFAULT_DEPS = {
  people: () => require('./team-roster').readPeople(),
  leaveSnapshot: () => require('./team-availability').snapshot(),
  daysOffFor: (name, snap) => require('./team-availability').daysOffFor(name, snap),
  holidays: () => { try { return require('./working-days').holidaySet(); } catch { return new Set(); } },
  fetchEmail: (id) => require('./microsoft').fetchEmailById(id),
  selfAddress: async () => { try { return await require('./microsoft').getSignedInAddress(); } catch { return null; } },
  extract: async (prompt) => {
    const r = await require('./ai-routing').runTask('uat_request_extract', { prompt, maxTokens: 400 }, { forceCloud: true, timeout: 60000 });
    return r && r.text ? r.text : null;
  },
  prepareCompose: (a) => require('./prepared-actions').prepareCompose(a),
  prepareReply: (a) => require('./prepared-actions').prepareReply(a),
  getAction: (id) => require('./prepared-actions').get(id),
  rejectAction: (id, opts) => require('./prepared-actions').reject(id, opts),
  push: (title, body, data) => require('./webpush').sendToAll(title, body, { type: 'uat_volunteers', ...(data || {}) }),
  now: () => Date.now(),
  publicBase: () => String(process.env.NEURO_PUBLIC_URL || 'https://pi5.tailecb90f.ts.net').replace(/\/+$/, ''),
};
const deps = (d) => ({ ...DEFAULT_DEPS, ...(d || {}) });

const iso = (ms) => new Date(ms).toISOString();
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ── reads ───────────────────────────────────────────────────────────────────

const _round = (id) => db.get('SELECT * FROM uat_rounds WHERE id = ?', [id]);
const _selections = (roundId) => db.all('SELECT * FROM uat_selections WHERE round_id = ? ORDER BY id', [roundId]);
const _session = (r) => ({ date: r.uat_date, start: r.start_time, end: r.end_time, feature: r.feature, location: r.location, online: r.online });

/** name → last time an invite to them was SENT and not declined (ISO). */
function history() {
  const rows = db.all(`SELECT person, MAX(sent_at) AS last FROM uat_selections
                       WHERE sent_at IS NOT NULL AND status IN ('sent', 'confirmed', 'accepted') GROUP BY person`);
  return new Map(rows.map((r) => [r.person, r.last]));
}

function _seen() {
  try { return new Set(JSON.parse(db.getState(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
function _markSeen(id) {
  const list = [..._seen()].filter((x) => x !== id);
  list.push(id);
  db.setState(SEEN_KEY, JSON.stringify(list.slice(-SEEN_MAX)));
}

/** The newest version of a prepared action (an edit makes a new row). */
function _latestAction(actionId, d) {
  let id = actionId;
  for (let i = 0; i < 10 && id; i++) {
    const child = db.get('SELECT action_id FROM prepared_actions WHERE parent_action_id = ?', [id]);
    if (!child) break;
    id = child.action_id;
  }
  return id ? d.getAction(id) : null;
}

// ── picking ─────────────────────────────────────────────────────────────────

function _leaveFn(d) {
  let snap = null;
  try { snap = d.leaveSnapshot(); } catch { snap = null; }
  return (name) => { try { return d.daysOffFor(name, snap); } catch { return { known: false, reason: 'leave not readable', dates: new Set() }; } };
}

function _pickInto(roundId, poolId, d, nowMs) {
  const r = _round(roundId);
  const asked = _selections(roundId).filter((s) => s.pool === poolId).map((s) => s.person);
  const res = model.pickNext({
    members: model.poolMembers(poolId, d.people()),
    history: history(),
    leave: _leaveFn(d),
    date: r.uat_date,
    exclude: asked,
  });
  if (!res.pick) return { ok: false, pool: poolId, skipped: res.skipped };
  db.run(`INSERT INTO uat_selections (round_id, pool, person, email, status, why, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)`, [roundId, poolId, res.pick.name, res.pick.email, res.why, iso(nowMs), iso(nowMs)]);
  return { ok: true, pool: poolId, pick: res.pick, why: res.why };
}

// ── detect ──────────────────────────────────────────────────────────────────

async function _read(entry, d) {
  const email = await d.fetchEmail(entry.id);
  if (!email || !email.id) return { retry: true };
  const nowMs = d.now();
  const todayKey = require('./promise-score').londonWall(nowMs).date;
  const text = await d.extract(model.extractionPrompt({ ...email, todayKey }));
  if (!text) return { retry: true };
  return { email, parsed: model.parseExtraction(text, { todayKey }) };
}

function _openRound(email, parsed, d) {
  const nowMs = d.now();
  const req = parsed.ok ? parsed.request : null;
  const status = parsed.ok ? 'proposed' : 'unclear';
  const r = db.run(`INSERT INTO uat_rounds (source_email_id, status, uat_date, start_time, end_time, feature, location, online,
                     from_name, from_email, subject, unclear_why, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [email.id, status, req ? req.date : null, req ? req.start : null, req ? req.end : null, req ? req.feature : null,
    req ? req.location : null, req ? req.online : null, email.from || null, (email.fromEmail || '').toLowerCase() || null,
    email.subject || null, parsed.ok ? null : parsed.why, iso(nowMs), iso(nowMs)]);
  return r.lastInsertRowid;
}

async function _picksFor(roundId, d) {
  const nowMs = d.now();
  const picks = model.POOLS.map((p) => _pickInto(roundId, p.id, d, nowMs));
  const names = picks.filter((p) => p.ok).map((p) => p.pick.name);
  const r = _round(roundId);
  const gaps = picks.filter((p) => !p.ok).map((p) => model.POOLS.find((x) => x.id === p.pool).label);
  try {
    await d.push(
      `UAT ${model.dayWords(r.uat_date)}: ${names.length ? names.join(' and ') : 'nobody picked'}`,
      `${gaps.length ? `No one eligible in ${gaps.join(', ')}. ` : ''}Check the picks and send the invites — NEURO → People.`,
      { url: '/?view=people', key: `uat:${roundId}:picked` },
    );
  } catch { /* a missed push never undoes the round */ }
  return picks;
}

/**
 * The triage passenger. Looks only at entries the cheap rule matches, at most
 * MAX_DETECT_PER_PASS a pass, each email once. Never throws.
 */
async function scanTriage(entries, injected) {
  const d = deps(injected);
  const out = { looked: 0, rounds: [], notRequests: 0, retry: 0 };
  let self = null;
  try { self = await d.selfAddress(); } catch { self = null; }
  const seen = _seen();
  for (const e of entries || []) {
    if (out.looked >= MAX_DETECT_PER_PASS) break;
    if (!model.quickMatch(e, self) || seen.has(e.id)) continue;
    if (db.get('SELECT id FROM uat_rounds WHERE source_email_id = ?', [e.id])) continue;
    out.looked += 1;
    try {
      const read = await _read(e, d);
      if (read.retry) { out.retry += 1; continue; }
      const { email, parsed } = read;
      if (parsed.ok && !parsed.request.asksForVolunteers) { _markSeen(e.id); out.notRequests += 1; continue; }
      if (parsed.ok && db.get(`SELECT id FROM uat_rounds WHERE uat_date = ? AND status <> 'dismissed'`, [parsed.request.date])) {
        _markSeen(e.id);
        console.log(`[UAT] ${e.id.slice(0, 12)}… is another request for ${parsed.request.date} — the existing round stands`);
        continue;
      }
      const id = _openRound(email, parsed, d);
      if (parsed.ok) await _picksFor(id, d);
      out.rounds.push(id);
    } catch (err) {
      console.warn('[UAT] detection failed:', err.message);
    }
  }
  if (out.rounds.length) console.log(`[UAT] opened ${out.rounds.length} round(s)`);
  return out;
}

/** An 'unclear' round, read again (Nick pressed Try again). */
async function retry(roundId, injected) {
  const d = deps(injected);
  const r = _round(roundId);
  if (!r) return { ok: false, code: 404, error: 'no such UAT round' };
  if (r.status !== 'unclear') return { ok: false, code: 409, error: 'this round was already read' };
  const read = await _read({ id: r.source_email_id }, d);
  if (read.retry) return { ok: false, code: 503, error: 'could not read the email or ask the model — try again shortly' };
  const { parsed } = read;
  if (!parsed.ok) {
    db.run('UPDATE uat_rounds SET unclear_why = ?, updated_at = ? WHERE id = ?', [parsed.why, iso(d.now()), roundId]);
    return { ok: false, code: 422, error: parsed.why };
  }
  if (!parsed.request.asksForVolunteers) {
    db.run(`UPDATE uat_rounds SET status = 'dismissed', unclear_why = 'not a request for volunteers', closed_at = ?, updated_at = ? WHERE id = ?`, [iso(d.now()), iso(d.now()), roundId]);
    return { ok: true, round: view(roundId, injected), notARequest: true };
  }
  const q = parsed.request;
  try {
    db.run(`UPDATE uat_rounds SET status = 'proposed', uat_date = ?, start_time = ?, end_time = ?, feature = ?, location = ?, online = ?,
              unclear_why = NULL, updated_at = ? WHERE id = ?`, [q.date, q.start, q.end, q.feature, q.location, q.online, iso(d.now()), roundId]);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { ok: false, code: 409, error: `there is already a UAT round for ${q.date}` };
    throw e;
  }
  await _picksFor(roundId, d);
  return { ok: true, round: view(roundId, injected) };
}

// ── Nick's decisions ────────────────────────────────────────────────────────

function _liveRound(roundId) {
  const r = _round(roundId);
  if (!r) return { error: { ok: false, code: 404, error: 'no such UAT round' } };
  if (['dismissed', 'done'].includes(r.status)) return { error: { ok: false, code: 409, error: `this round is ${r.status}` } };
  if (r.status === 'unclear') return { error: { ok: false, code: 409, error: 'this request was not read — try again first' } };
  return { round: r };
}

/**
 * Prepare an invite for every 'proposed' pick. Returns the prepared actions;
 * the screen sends them with the same press (directAction).
 */
function prepareInvites(roundId, injected) {
  const d = deps(injected);
  const { round, error } = _liveRound(roundId);
  if (error) return error;
  const nowMs = d.now();
  const session = _session(round);
  const actions = [];
  const failed = [];
  for (const s of _selections(roundId).filter((x) => x.status === 'proposed')) {
    const token = crypto.randomBytes(24).toString('base64url');
    const deadlineMs = model.deadlineFor(nowMs, session, d.holidays());
    const mail = model.inviteEmail({ name: s.person, session, link: `${d.publicBase()}/api/u/${token}`, deadlineMs });
    const res = d.prepareCompose({
      from: 'work', to: [{ name: s.person, email: s.email }], subject: mail.subject, body: mail.body,
      origin: 'uat-volunteers', generatedBy: 'template (UAT volunteers invite, no model call)',
      evidence: { uatRound: roundId, uatSelection: s.id, uatDate: round.uat_date }, now: nowMs,
    });
    if (!res || !res.ok) { failed.push({ person: s.person, error: (res && res.error) || 'could not prepare' }); continue; }
    db.run(`UPDATE uat_selections SET status = 'invited', token_hash = ?, action_id = ?, deadline_at = ?, updated_at = ? WHERE id = ?`,
      [hash(token), res.action.actionId, iso(deadlineMs), iso(nowMs), s.id]);
    actions.push(res.action);
  }
  // Invites drafted earlier and not yet sent are offered again with the same press.
  for (const s of _selections(roundId).filter((x) => x.status === 'invited' && x.action_id)) {
    const a = _latestAction(s.action_id, d);
    if (a && a.status === 'prepared' && !actions.some((x) => x.actionId === a.actionId)) actions.push(a);
  }
  if (actions.length && round.status === 'proposed') db.run(`UPDATE uat_rounds SET status = 'inviting', updated_at = ? WHERE id = ?`, [iso(nowMs), roundId]);
  return { ok: failed.length === 0 || actions.length > 0, actions, failed, round: view(roundId, injected) };
}

/**
 * Swap a pick before its invite goes. `person` null = the next in the rota.
 * An invite already sent cannot be swapped (that person has been asked).
 */
function swap(roundId, selectionId, person = null, injected) {
  const d = deps(injected);
  const { round, error } = _liveRound(roundId);
  if (error) return error;
  const s = db.get('SELECT * FROM uat_selections WHERE id = ? AND round_id = ?', [selectionId, roundId]);
  if (!s) return { ok: false, code: 404, error: 'no such pick' };
  if (!['proposed', 'invited'].includes(s.status)) return { ok: false, code: 409, error: `${s.person} has already been asked — they can decline from their email` };
  if (s.status === 'invited' && s.action_id) {
    const a = _latestAction(s.action_id, d);
    if (a && !['prepared', 'rejected', 'expired', 'cancelled', 'superseded'].includes(a.status)) {
      return { ok: false, code: 409, error: `the invite to ${s.person} is already ${a.status}` };
    }
    if (a && a.status === 'prepared') d.rejectAction(a.actionId, { note: 'swapped for someone else (UAT volunteers)', actor: 'nick' });
  }
  const nowMs = d.now();
  const members = model.poolMembers(s.pool, d.people());
  if (person) {
    const m = members.find((x) => x.name.toLowerCase() === String(person).toLowerCase());
    if (!m) return { ok: false, code: 400, error: `${person} is not in ${model.POOLS.find((p) => p.id === s.pool).label}` };
    if (!m.email) return { ok: false, code: 409, error: `${m.name} has no email address in their People note` };
    if (_selections(roundId).some((x) => x.person === m.name && model.ACTIVE.has(x.status))) return { ok: false, code: 409, error: `${m.name} is already picked` };
    db.run(`UPDATE uat_selections SET status = 'replaced', updated_at = ? WHERE id = ?`, [iso(nowMs), s.id]);
    db.run(`INSERT INTO uat_selections (round_id, pool, person, email, status, why, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'proposed', 'chosen by Nick', ?, ?)`, [roundId, s.pool, m.name, m.email, iso(nowMs), iso(nowMs)]);
    return { ok: true, round: view(roundId, injected) };
  }
  db.run(`UPDATE uat_selections SET status = 'replaced', updated_at = ? WHERE id = ?`, [iso(nowMs), s.id]);
  const res = _pickInto(roundId, s.pool, d, nowMs);
  return { ok: true, picked: res.ok ? res.pick.name : null, round: view(roundId, injected) };
}

/** "Not a volunteer request" / "I'll do this one myself". */
function dismiss(roundId, injected) {
  const d = deps(injected);
  const r = _round(roundId);
  if (!r) return { ok: false, code: 404, error: 'no such UAT round' };
  if (r.status === 'done' || r.status === 'dismissed') return { ok: false, code: 409, error: `this round is ${r.status}` };
  for (const s of _selections(roundId)) {
    if (s.status === 'invited' && s.action_id) {
      const a = _latestAction(s.action_id, d);
      if (a && a.status === 'prepared') d.rejectAction(a.actionId, { note: 'UAT round dismissed', actor: 'nick' });
    }
  }
  if (r.reply_action_id) {
    const a = _latestAction(r.reply_action_id, d);
    if (a && a.status === 'prepared') d.rejectAction(a.actionId, { note: 'UAT round dismissed', actor: 'nick' });
  }
  const nowIso = iso(d.now());
  db.run(`UPDATE uat_rounds SET status = 'dismissed', closed_at = ?, updated_at = ? WHERE id = ?`, [nowIso, nowIso, roundId]);
  db.run(`UPDATE uat_selections SET status = 'replaced', updated_at = ? WHERE round_id = ? AND status IN ('proposed', 'invited')`, [nowIso, roundId]);
  return { ok: true };
}

// ── the person's answer (public link) ───────────────────────────────────────

function _byToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.get('SELECT * FROM uat_selections WHERE token_hash = ?', [hash(token)]);
}

/** What the link page shows. Never another person's name. */
function lookup(token, injected) {
  const d = deps(injected);
  const s = _byToken(token);
  if (!s) return { ok: false, state: 'unknown' };
  _sync(s.round_id, d);
  return _answerView(db.get('SELECT * FROM uat_selections WHERE id = ?', [s.id]), d);
}

function _answerView(s, d) {
  const r = _round(s.round_id);
  const nowMs = d.now();
  const deadlineMs = s.deadline_at ? Date.parse(s.deadline_at) : null;
  const closed = ['done', 'dismissed'].includes(r.status) || s.status === 'replaced' || (deadlineMs && nowMs > deadlineMs);
  const replacedAfterDecline = s.status === 'declined' && _selections(r.id).some((x) => x.pool === s.pool && x.id !== s.id && model.ACTIVE.has(x.status));
  return {
    ok: true,
    state: s.status === 'replaced' ? 'withdrawn' : closed ? 'closed' : replacedAfterDecline ? 'declined-replaced' : s.status,
    canAnswer: !closed && !replacedAfterDecline && ['invited', 'sent', 'confirmed', 'declined'].includes(s.status),
    first: String(s.person).split(/\s+/)[0],
    session: { ..._session(r), dayWords: model.dayWords(r.uat_date) },
    deadline: deadlineMs ? model.whenWords(deadlineMs) : null,
    answer: s.status === 'confirmed' || s.status === 'accepted' ? 'confirmed' : s.status === 'declined' ? 'declined' : null,
  };
}

async function respond(token, answer, injected) {
  const d = deps(injected);
  if (!['confirm', 'decline'].includes(answer)) return { ok: false, code: 400, error: 'answer must be confirm or decline' };
  const s0 = _byToken(token);
  if (!s0) return { ok: false, code: 404, state: 'unknown' };
  _sync(s0.round_id, d);
  const s = db.get('SELECT * FROM uat_selections WHERE id = ?', [s0.id]);
  const v = _answerView(s, d);
  if (!v.canAnswer) return { ...v, ok: false, code: 409 };
  const nowMs = d.now();
  const status = answer === 'confirm' ? 'confirmed' : 'declined';
  db.run('UPDATE uat_selections SET status = ?, responded_at = ?, updated_at = ? WHERE id = ?', [status, iso(nowMs), iso(nowMs), s.id]);
  const r = _round(s.round_id);
  if (status === 'declined') {
    const res = _pickInto(r.id, s.pool, d, nowMs);
    try {
      await d.push(
        `UAT: ${s.person} can't make it`,
        res.ok ? `${res.pick.name} is next — send their invite in NEURO → People.` : 'Nobody else in that team is free — pick someone in NEURO → People.',
        { url: '/?view=people', key: `uat:${r.id}:decline:${s.id}` },
      );
    } catch { /* never undoes the answer */ }
  }
  await tick(injected, { roundId: r.id });
  return { ..._answerView(db.get('SELECT * FROM uat_selections WHERE id = ?', [s.id]), d), recorded: status };
}

// ── the clock ───────────────────────────────────────────────────────────────

/** Bring one round's selections up to date with what was sent and the clock. Sync. */
function _sync(roundId, d) {
  const nowMs = d.now();
  for (const s of _selections(roundId)) {
    if (s.status === 'invited' && s.action_id) {
      const a = _latestAction(s.action_id, d);
      if (!a) continue;
      if (a.status === 'executed' || a.status === 'verified') {
        db.run(`UPDATE uat_selections SET status = 'sent', sent_at = ?, action_id = ?, updated_at = ? WHERE id = ?`,
          [a.executedAt || iso(nowMs), a.actionId, iso(nowMs), s.id]);
      } else if (['rejected', 'expired', 'cancelled'].includes(a.status) || (a.status === 'failed' && a.retrySafe)) {
        db.run(`UPDATE uat_selections SET status = 'proposed', token_hash = NULL, action_id = NULL, deadline_at = NULL, updated_at = ? WHERE id = ?`, [iso(nowMs), s.id]);
      } else if (a.status === 'prepared' && s.deadline_at && nowMs > Date.parse(s.deadline_at) - STALE_INVITE_MS) {
        // The draft names a deadline that is about to pass — redraft it on the next press.
        d.rejectAction(a.actionId, { note: 'its reply-by time was about to pass unsent; NEURO will redraft it', actor: null });
        db.run(`UPDATE uat_selections SET status = 'proposed', token_hash = NULL, action_id = NULL, deadline_at = NULL, updated_at = ? WHERE id = ?`, [iso(nowMs), s.id]);
      }
    } else if (s.status === 'sent' && s.deadline_at && nowMs > Date.parse(s.deadline_at)) {
      db.run(`UPDATE uat_selections SET status = 'accepted', updated_at = ? WHERE id = ?`, [iso(nowMs), s.id]);
    }
  }
}

async function _advance(r, d) {
  const nowMs = d.now();
  _sync(r.id, d);
  const st = model.roundState(_selections(r.id));
  if (r.reply_action_id) {
    const a = _latestAction(r.reply_action_id, d);
    if (a && (a.status === 'executed' || a.status === 'verified')) {
      db.run(`UPDATE uat_rounds SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?`, [iso(nowMs), iso(nowMs), r.id]);
    } else if (a && a.status === 'rejected') {
      // Nick turned the reply down: he is answering Dan himself.
      db.run(`UPDATE uat_rounds SET status = 'done', closed_at = ?, unclear_why = 'reply to Dan declined in NEURO — answered by hand', updated_at = ? WHERE id = ?`, [iso(nowMs), iso(nowMs), r.id]);
    } else if (a && ['expired', 'cancelled'].includes(a.status)) {
      db.run(`UPDATE uat_rounds SET reply_action_id = NULL, status = 'inviting', updated_at = ? WHERE id = ?`, [iso(nowMs), r.id]);
    }
    return;
  }
  if (!st.ready) return;
  const people = model.POOLS.map((p) => st.byPool[p.id]).filter(Boolean).map((s) => ({ name: s.person }));
  const body = model.danReply({ toName: r.from_name, session: _session(r), people });
  const res = await d.prepareReply({ emailId: r.source_email_id, body, mode: 'reply', origin: 'uat-volunteers', now: nowMs });
  if (!res || !res.ok) {
    console.warn(`[UAT] could not prepare the reply for round ${r.id}: ${(res && res.error) || 'unknown'}`);
    db.run('UPDATE uat_rounds SET unclear_why = ?, updated_at = ? WHERE id = ?', [`reply not prepared: ${(res && res.error) || 'unknown'}`, iso(nowMs), r.id]);
    return;
  }
  db.run(`UPDATE uat_rounds SET status = 'ready', reply_action_id = ?, unclear_why = NULL, updated_at = ? WHERE id = ?`, [res.action.actionId, iso(nowMs), r.id]);
  try {
    await d.push(`UAT: ready to tell ${r.from_name || 'Dan'}`, `${people.map((p) => p.name).join(' and ')} — send the reply in NEURO → People.`,
      { url: '/?view=people', key: `uat:${r.id}:ready` });
  } catch { /* the reply is waiting either way */ }
}

/** Every 5 minutes (and after each answer). Never throws. */
async function tick(injected, { roundId = null } = {}) {
  const d = deps(injected);
  const rows = roundId
    ? [_round(roundId)].filter(Boolean)
    : db.all(`SELECT * FROM uat_rounds WHERE status IN ('proposed', 'inviting', 'ready')`);
  for (const r of rows) {
    if (!['proposed', 'inviting', 'ready'].includes(r.status)) continue;
    try { await _advance(r, d); } catch (e) { console.warn(`[UAT] round ${r.id} tick failed:`, e.message); }
  }
  return { rounds: rows.length };
}

// ── views ───────────────────────────────────────────────────────────────────

function _selView(s, d) {
  const a = s.action_id ? _latestAction(s.action_id, d) : null;
  return {
    id: s.id, pool: s.pool, person: s.person, status: s.status, why: s.why,
    sentAt: s.sent_at, deadlineAt: s.deadline_at, respondedAt: s.responded_at,
    action: a && a.status === 'prepared' ? a : null,
    actionStatus: a ? a.status : null,
  };
}

function view(roundId, injected) {
  const d = deps(injected);
  const r = _round(roundId);
  if (!r) return null;
  const sels = _selections(roundId);
  const st = model.roundState(sels);
  const reply = r.reply_action_id ? _latestAction(r.reply_action_id, d) : null;
  return {
    id: r.id, status: r.status, unclearWhy: r.unclear_why,
    session: r.uat_date ? { ..._session(r), dayWords: model.dayWords(r.uat_date) } : null,
    from: { name: r.from_name, email: r.from_email }, subject: r.subject,
    pools: model.POOLS.map((p) => ({
      id: p.id, label: p.label,
      current: st.byPool[p.id] ? _selView(st.byPool[p.id], d) : null,
      earlier: sels.filter((s) => s.pool === p.id && !model.ACTIVE.has(s.status)).map((s) => ({ person: s.person, status: s.status })),
    })),
    toInvite: st.toInvite.length,
    unfilled: st.unfilled.map((id) => model.POOLS.find((p) => p.id === id).label),
    reply: reply ? { action: reply.status === 'prepared' ? reply : null, status: reply.status } : null,
    createdAt: r.created_at,
  };
}

function rota(injected) {
  const d = deps(injected);
  const hist = history();
  const counts = new Map(db.all(`SELECT person, COUNT(*) AS n FROM uat_selections
                                 WHERE sent_at IS NOT NULL AND status IN ('sent', 'confirmed', 'accepted') GROUP BY person`).map((r) => [r.person, r.n]));
  const people = d.people();
  return model.POOLS.map((p) => ({
    id: p.id, label: p.label,
    members: model.poolMembers(p.id, people).map((m) => ({ name: m.name, last: hist.get(m.name) || null, times: counts.get(m.name) || 0, hasEmail: !!m.email }))
      .sort((a, b) => (!a.last && b.last ? -1 : a.last && !b.last ? 1 : a.last && b.last && a.last !== b.last ? (a.last < b.last ? -1 : 1) : a.name.localeCompare(b.name))),
  }));
}

function list(injected) {
  const rows = db.all(`SELECT id FROM uat_rounds WHERE status <> 'dismissed' ORDER BY COALESCE(uat_date, created_at) DESC, id DESC LIMIT 12`);
  return { rounds: rows.map((r) => view(r.id, injected)), rota: rota(injected) };
}

/** Decision-engine collector: one card per round that needs Nick. */
function nowCards(nowMs = Date.now()) {
  let rows;
  try { rows = db.all(`SELECT * FROM uat_rounds WHERE status IN ('unclear', 'proposed', 'inviting', 'ready')`); } catch { return []; }
  const today = require('./promise-score').londonWall(nowMs).date;
  const out = [];
  for (const r of rows) {
    if (r.uat_date && r.uat_date < today) continue;
    const sels = _selections(r.id);
    const st = model.roundState(sels);
    let title = null;
    let urgency = 'high';
    if (r.status === 'unclear') { title = 'A UAT email NEURO could not read'; urgency = 'medium'; }
    else if (r.status === 'ready') title = `UAT ${model.dayWords(r.uat_date)}: send the names to ${r.from_name || 'Dan'}`;
    else if (st.toInvite.length) title = `UAT ${model.dayWords(r.uat_date)}: invite ${st.toInvite.map((s) => s.person).join(' and ')}`;
    else if (st.unfilled.length) title = `UAT ${model.dayWords(r.uat_date)}: no one free in ${st.unfilled.map((id) => model.POOLS.find((p) => p.id === id).label).join(', ')}`;
    if (!title) continue; // waiting on answers — nothing for Nick to do yet
    out.push({
      type: 'uat_volunteers', id: `uat-${r.id}`, dedupeKey: `uat:${r.id}:${r.status}:${st.toInvite.length}`,
      title, reason: r.status === 'unclear' ? (r.unclear_why || r.subject || '') : (r.feature || r.subject || 'UAT session'),
      score: r.status === 'ready' ? 78 : 72, urgency, source: 'email', actionHint: 'Open People',
      meta: { roundId: r.id, uatDate: r.uat_date },
    });
  }
  return out;
}

module.exports = {
  scanTriage, retry, prepareInvites, swap, dismiss, lookup, respond, tick, view, list, rota, nowCards, history,
  _internals: { hash, DEFAULT_DEPS, SEEN_KEY },
};
