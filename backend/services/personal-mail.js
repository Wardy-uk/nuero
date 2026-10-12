'use strict';

/**
 * Personal mailboxes — the registry, the credentials, and the pure judgements.
 *
 * Five mailboxes, each with ONE job (Nick, 12 Oct 2026). Work mail is not here:
 * it stays on Microsoft Graph as nickw@nurtur.tech.
 *
 *   nick@nickward.co.uk     Nick. Personal mail he wrote or approved.
 *   saim@nickward.co.uk     Mail NEURO generates (hike alerts, all-clears,
 *                           reminders). From "SAiM (for Nick Ward)", Reply-To nick@.
 *   contact@nickward.co.uk  Public-facing: websites, forms, sign-ups.
 *   neuro@nickward.co.uk    Inbound capture — not read until Nick confirms its job.
 *   Gmail                   Nick's Gmail; only its Important mail, only new mail.
 *
 * Hosts were checked against the servers themselves from pi5 on 12 Oct 2026
 * (DNS, TLS certificate names, greeting banner), not assumed:
 *   ⚠ Fasthosts IMAP is mail.livemail.co.uk. imap.livemail.co.uk still RESOLVES
 *     but its port 993 times out — the name in the first handoff was the dead one.
 *   Fasthosts SMTP smtp.livemail.co.uk answers on 465 (TLS) and 587 (STARTTLS).
 *   Gmail imap.gmail.com:993 and smtp.gmail.com:465, per Google's own IMAP page.
 *
 * Credentials follow the WU / RescueTime key idiom: pasted in Settings, stored in
 * agent_state, read at call time, and never returned by any route — not even
 * masked. Only WHETHER one is set, and when.
 */

const PROVIDERS = {
  fasthosts: {
    label: 'Fasthosts',
    imap: { host: 'mail.livemail.co.uk', port: 993, secure: true },
    smtp: { host: 'smtp.livemail.co.uk', port: 465, secure: true },
  },
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  },
};

const DOMAIN = 'nickward.co.uk';

const MAILBOXES = [
  { key: 'nick', address: `nick@${DOMAIN}`, provider: 'fasthosts', displayName: 'Nick Ward', sends: true,
    job: 'You. Personal mail you wrote or approved goes out from here.' },
  { key: 'saim', address: `saim@${DOMAIN}`, provider: 'fasthosts', displayName: 'SAiM (for Nick Ward)', replyTo: `nick@${DOMAIN}`, sends: true,
    job: 'Mail NEURO writes itself (hike alerts, all-clears, reminders). Replies go to nick@.' },
  { key: 'contact', address: `contact@${DOMAIN}`, provider: 'fasthosts', displayName: 'Nick Ward', sends: true,
    job: 'Public-facing: websites, forms, sign-ups. Replies go from here.' },
  { key: 'neuro', address: `neuro@${DOMAIN}`, provider: 'fasthosts', displayName: 'NEURO', sends: false,
    job: 'Capture by email. Nothing reads it yet — its job is still to be confirmed.' },
  { key: 'gmail', address: null, provider: 'gmail', displayName: 'Nick Ward', sends: true,
    job: 'Your Gmail. Only mail Gmail marks Important, only new mail, triaged like work mail.' },
];

const KEYS = MAILBOXES.map((m) => m.key);
const CRED_STATE = 'personal_mail_credentials';
const CHECK_STATE = 'personal_mail_checks';
const TEST_STATE = 'personal_mail_tests';
const MAX_TESTS = 12;

function box(key) {
  return MAILBOXES.find((m) => m.key === key) || null;
}

// ── Storage (agent_state is a raw string store: serialise here) ──────────────

function _read(key, fallback) {
  try {
    const raw = require('../db/database').getState(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch { return fallback; }
}
function _write(key, value) {
  require('../db/database').setState(key, JSON.stringify(value));
}

/** The stored credential for a mailbox, or null. INTERNAL — never put on a response. */
function credentialFor(key) {
  const all = _read(CRED_STATE, {});
  const c = all[key];
  if (!c || typeof c.password !== 'string' || !c.password) return null;
  const b = box(key);
  const address = b && b.address ? b.address : c.address || null;
  if (!address) return null;
  return { address, password: c.password, setAt: c.setAt || null };
}

/** The address a mailbox sends as: fixed for the domain boxes, stored for Gmail. */
function addressFor(key) {
  const b = box(key);
  if (!b) return null;
  if (b.address) return b.address;
  const c = _read(CRED_STATE, {})[key];
  return (c && c.address) || null;
}

// ── Pure judgements ─────────────────────────────────────────────────────────

/**
 * Shape-check what Nick pasted. PURE. A wrong-but-well-formed password is caught
 * by "Check connection", never guessed at here.
 */
function validateCredential(key, input) {
  const b = box(key);
  if (!b) return { ok: false, error: `No mailbox called "${key}".` };
  const body = input && typeof input === 'object' ? input : {};
  let password = typeof body.password === 'string' ? body.password : '';
  if (b.provider === 'gmail') {
    const address = String(body.address || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/.test(address)) {
      return { ok: false, error: 'That does not look like a Gmail address.' };
    }
    // Google shows an app password as four groups of four; the spaces are display only.
    password = password.replace(/\s+/g, '');
    if (!/^[a-z]{16}$/i.test(password)) {
      return { ok: false, error: 'A Google app password is 16 letters (Google shows it in four groups). Your normal Gmail password will not work here.' };
    }
    return { ok: true, value: { address, password } };
  }
  if (!password) return { ok: false, error: 'No password given.' };
  if (password.length > 256 || /[\r\n]/.test(password)) return { ok: false, error: 'That password cannot be right (too long, or it has a line break in it).' };
  return { ok: true, value: { password } };
}

/** "Display Name" <address>, with the name quoted. PURE. */
function formatAddress(name, address) {
  if (!address) return null;
  if (!name) return address;
  return `"${String(name).replace(/["\\]/g, '')}" <${address}>`;
}

/**
 * What a message from this mailbox will carry in From / Reply-To. PURE given
 * the address. Every screen that shows "sends from" reads this, never restates it.
 */
function senderFor(key, address = addressFor(key)) {
  const b = box(key);
  if (!b || !b.sends || !address) return null;
  return {
    mailbox: key,
    address,
    from: formatAddress(b.displayName, address),
    replyTo: b.replyTo || null,
  };
}

/**
 * Who a TEST email may go to: Nick's own mailboxes only, never the one sending,
 * never neuro@ (it is a capture box). Gmail is preferred, because Gmail stamps a
 * full Authentication-Results verdict. PURE.
 */
function testTargets(fromKey, configured) {
  const set = new Set(configured || []);
  return ['gmail', 'nick', 'contact', 'saim'].filter((k) => k !== fromKey && set.has(k));
}

/**
 * Pull SPF / DKIM / DMARC out of a received message's headers. PURE.
 * Reads the FIRST Authentication-Results (the receiving server's own; later ones
 * can be forged by the sender) and DKIM-Signature d=.
 */
function parseAuthResults(headerText) {
  const text = String(headerText || '').replace(/\r?\n[ \t]+/g, ' ');
  const lines = text.split(/\r?\n/);
  const ar = lines.find((l) => /^authentication-results:/i.test(l)) || null;
  const sig = lines.find((l) => /^dkim-signature:/i.test(l)) || null;
  const pick = (re) => { const m = ar && ar.match(re); return m ? m[1].toLowerCase() : null; };
  const signedDomain = (() => { const m = sig && sig.match(/\bd=([^;\s]+)/i); return m ? m[1].toLowerCase() : null; })();
  const dkimDomain = (() => { const m = ar && ar.match(/\bdkim=\w+[^;]*?header\.(?:i|d)=@?([^;\s]+)/i); return m ? m[1].toLowerCase() : null; })();
  return {
    receiver: ar ? (ar.match(/^authentication-results:\s*([^;\s]+)/i) || [])[1] || null : null,
    spf: pick(/\bspf=(\w+)/i),
    dkim: pick(/\bdkim=(\w+)/i),
    dkimDomain,
    dmarc: pick(/\bdmarc=(\w+)/i),
    signedDomain,
    present: Boolean(ar),
  };
}

/** One verdict a person can read. PURE. */
function verdictSummary(v) {
  if (!v || !v.present) return 'The receiving server added no verdict — check the headers by hand.';
  const bits = [`SPF ${v.spf || '?'}`, `DKIM ${v.dkim || '?'}${v.dkimDomain ? ` (${v.dkimDomain})` : ''}`, `DMARC ${v.dmarc || '?'}`];
  const allPass = v.spf === 'pass' && v.dkim === 'pass' && v.dmarc === 'pass';
  return `${bits.join(' · ')}${allPass ? ' — all pass' : ''}`;
}

/** Turn a library error into a short, credential-free reason. PURE. */
function classifyError(err) {
  const msg = String((err && (err.responseText || err.response || err.message)) || err || 'unknown error');
  const code = err && (err.code || err.serverResponseCode);
  let kind = 'other';
  if (err && (err.authenticationFailed || /auth|login|credential|535|534|password/i.test(msg) || code === 'EAUTH')) kind = 'auth';
  else if (/timed? ?out|ETIMEDOUT/i.test(msg) || code === 'ETIMEDOUT') kind = 'timeout';
  else if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(`${code} ${msg}`)) kind = 'network';
  else if (/certificate|TLS|SSL/i.test(msg)) kind = 'tls';
  const plain = {
    auth: 'The server refused the login — wrong password, or (Gmail) not an app password.',
    timeout: 'The server did not answer in time.',
    network: 'Could not reach the server.',
    tls: 'The secure connection failed.',
    other: 'The server said no.',
  }[kind];
  return { kind, error: `${plain} (${msg.replace(/\s+/g, ' ').slice(0, 160)})` };
}

// ── Stored state ────────────────────────────────────────────────────────────

function setCredential(key, input, now = Date.now()) {
  const v = validateCredential(key, input);
  if (!v.ok) return v;
  const all = _read(CRED_STATE, {});
  all[key] = { ...v.value, setAt: new Date(now).toISOString() };
  _write(CRED_STATE, all);
  // A new password makes the last connection check meaningless.
  const checks = _read(CHECK_STATE, {});
  delete checks[key];
  _write(CHECK_STATE, checks);
  return { ok: true };
}

function clearCredential(key) {
  if (!box(key)) return { ok: false, error: `No mailbox called "${key}".` };
  const all = _read(CRED_STATE, {});
  delete all[key];
  _write(CRED_STATE, all);
  const checks = _read(CHECK_STATE, {});
  delete checks[key];
  _write(CHECK_STATE, checks);
  return { ok: true };
}

function recordCheck(key, result) {
  const checks = _read(CHECK_STATE, {});
  checks[key] = result;
  _write(CHECK_STATE, checks);
}

function configuredKeys() {
  return KEYS.filter((k) => credentialFor(k));
}

/** Everything Settings shows. Never a password. */
function status() {
  const checks = _read(CHECK_STATE, {});
  const configured = configuredKeys();
  return {
    mailboxes: MAILBOXES.map((b) => {
      const c = credentialFor(b.key);
      const address = addressFor(b.key);
      const p = PROVIDERS[b.provider];
      return {
        key: b.key,
        address,
        provider: b.provider,
        providerLabel: p.label,
        hosts: { imap: `${p.imap.host}:${p.imap.port}`, smtp: `${p.smtp.host}:${p.smtp.port}` },
        job: b.job,
        sends: b.sends,
        sender: senderFor(b.key, address),
        configured: Boolean(c),
        setAt: c ? c.setAt : null,
        check: checks[b.key] || null,
        testTargets: b.sends ? testTargets(b.key, configured).map((k) => ({ key: k, address: addressFor(k) })) : [],
      };
    }),
  };
}

function recordTest(entry) {
  const list = _read(TEST_STATE, { tests: [] }).tests || [];
  const i = list.findIndex((t) => t.id === entry.id);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.unshift(entry);
  _write(TEST_STATE, { tests: list.slice(0, MAX_TESTS) });
}

function tests() {
  return _read(TEST_STATE, { tests: [] }).tests || [];
}

module.exports = {
  PROVIDERS, MAILBOXES, KEYS, DOMAIN,
  box, credentialFor, addressFor, senderFor, configuredKeys,
  validateCredential, formatAddress, testTargets, parseAuthResults, verdictSummary, classifyError,
  setCredential, clearCredential, recordCheck, status, recordTest, tests,
  _internals: { CRED_STATE, CHECK_STATE, TEST_STATE },
};
