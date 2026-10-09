'use strict';

/**
 * Tally's own HTTP API — the ONLY way NEURO changes anything in Tally.
 *
 * Nick, 9 Oct 2026: "I only want to update/store financial data in one place."
 * Tally is that place. NEURO reads Tally's database read-only over ssh (finance.js)
 * and WRITES only through the endpoints Tally's own UI uses, so Tally's rules
 * (merchant identity, rule safety, "apply to similar") decide what a change
 * means — never a second copy of that logic in NEURO.
 *
 * Login: TALLY_API_URL / TALLY_API_USERNAME / TALLY_API_PASSWORD (backend/.env,
 * the same `tally-api` user the Tally MCP server uses). The token is kept in
 * memory and renewed on a 401; it is never logged or returned.
 */

let _token = null;
let _fetch = null;
/** Tests inject a fake `fetch`; production uses the global one. */
function useFetch(fn) { _fetch = typeof fn === 'function' ? fn : null; _token = null; }
const f = (...a) => (_fetch || global.fetch)(...a);

function config() {
  return {
    url: String(process.env.TALLY_API_URL || '').replace(/\/+$/, ''),
    username: process.env.TALLY_API_USERNAME || '',
    password: process.env.TALLY_API_PASSWORD || '',
  };
}
function configured() { const c = config(); return !!(c.url && c.username && c.password); }

async function _login() {
  const c = config();
  const res = await f(`${c.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: c.username, password: c.password }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok || !j.data || !j.data.token) throw new Error(`Tally login refused (HTTP ${res.status})`);
  _token = j.data.token;
  return _token;
}

/** One authenticated call. A 401 renews the token once. Throws "Tally HTTP <status>: <error>". */
async function call(method, path, body = undefined) {
  if (!configured()) throw new Error('Tally API is not configured (TALLY_API_URL / TALLY_API_USERNAME / TALLY_API_PASSWORD)');
  const c = config();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = _token || await _login();
    const res = await f(`${c.url}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) { _token = null; continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) { const e = new Error(`Tally HTTP ${res.status}: ${j.error || 'no reason given'}`); e.status = res.status; e.body = j; throw e; }
    return j.data;
  }
  throw new Error('Tally HTTP 401: login did not stick');
}

const categories = () => call('GET', '/categories');
const transaction = (id) => call('GET', `/transactions/${Number(id)}`);
/**
 * Re-categorise one transaction the way Tally's own UI does.
 *   remember=false → this transaction only (no rule, nothing else touched)
 *   remember=true  → Tally creates/updates its merchant rule and applies it to
 *                    that merchant's other uncategorised transactions.
 * Tally may answer `needsConfirmation` (an ambiguous merchant): no rule is made
 * until `confirmRule` is sent.
 */
const categoriseTransaction = (id, { categoryId, remember = false, confirmRule = false }) =>
  call('PATCH', `/transactions/${Number(id)}`, { categoryId, createRule: !!remember, applyToSimilar: !!remember, ...(confirmRule ? { confirmRule: true } : {}) });

module.exports = { config, configured, useFetch, call, categories, transaction, categoriseTransaction };
