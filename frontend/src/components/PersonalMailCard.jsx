import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './PersonalMailCard.css';

/**
 * Personal mailboxes — Settings.
 *
 * Five mailboxes, each with one job. A password goes in and is never shown
 * again. "Check connection" logs in and sends nothing. "Send test" goes ONLY to
 * another of your own mailboxes, and NEURO then reads it back and shows the
 * SPF / DKIM / DMARC verdict the receiving server wrote — so you can see the
 * domain authenticates before anything depends on it.
 *
 * Every sending mailbox shows "Sends as" — the From (and Reply-To) the server
 * will put on the message. That line comes from the backend; this component
 * never composes an address.
 */

async function call(path, method = 'GET', body) {
  const r = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch { d = { ok: false, error: `HTTP ${r.status}` }; }
  return d;
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function CheckLine({ check }) {
  if (!check) return <span className="pm-muted">Not checked yet.</span>;
  const part = (label, r) => (r ? (r.ok ? `${label} ✓` : `${label} ✗ ${r.error}`) : null);
  return (
    <span className={check.ok ? 'pm-good' : 'pm-bad'}>
      {[part('IMAP', check.imap), part('SMTP', check.smtp)].filter(Boolean).join(' · ')}
      {check.imap?.ok && check.imap.inbox ? ` · inbox ${check.imap.inbox.messages ?? '?'} (${check.imap.inbox.unseen ?? '?'} unread)` : ''}
      {check.imap && 'important' in check.imap ? (check.imap.important ? ` · Important folder found` : ' · ⚠ no Important folder seen') : ''}
      <span className="pm-muted"> — {when(check.at)}</span>
    </span>
  );
}

function SendsAs({ sender }) {
  if (!sender) return null;
  return (
    <div className="pm-sends">
      Sends as <strong>{sender.from}</strong>
      {sender.replyTo && <> · replies go to <strong>{sender.replyTo}</strong></>}
    </div>
  );
}

// Gmail → work triage (12 Oct 2026): watching Important from a watermark; nothing older is ever read.
function GmailIntake({ s }) {
  if (!s || !s.configured) return null;
  const wm = s.watermark;
  const last = s.last;
  return (
    <div className="pm-small" data-testid="pm-gmail-intake">
      {wm
        ? <>Personal inbox shows Gmail’s Important mail that arrived after <strong>{when(wm.setAt)}</strong> — nothing older is read.</>
        : <>Personal inbox starts showing Gmail’s Important mail on its next check (it marks that moment; nothing older is read).</>}
      {last && (last.ok
        ? <span className="pm-muted"> Last pass {when(last.at)}: {last.fetched || 0} message{last.fetched === 1 ? '' : 's'}.</span>
        : <span className="pm-bad"> Last pass {when(last.at)} could not read Gmail — {last.why}</span>)}
    </div>
  );
}

function Mailbox({ m, onChange, gmailIntake = null }) {
  const [password, setPassword] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [to, setTo] = useState('');
  const [sent, setSent] = useState(null);

  const act = async (label, fn) => {
    setBusy(label); setError(null);
    try { const d = await fn(); if (d && d.ok === false) setError(d.error || 'That did not work.'); return d; }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(null); onChange(); }
  };

  const save = () => act('save', async () => {
    const d = await call(`/api/mail/accounts/${m.key}/credential`, 'POST', m.provider === 'gmail' ? { address, password } : { password });
    if (d && d.ok) { setPassword(''); setAddress(''); }
    return d;
  });
  const check = () => act('check', () => call(`/api/mail/accounts/${m.key}/check`, 'POST', {}));
  const forget = () => act('forget', () => call(`/api/mail/accounts/${m.key}/credential`, 'DELETE'));
  const target = to || (m.testTargets[0] && m.testTargets[0].key) || '';
  const targetAddress = (m.testTargets.find((t) => t.key === target) || {}).address;
  const test = () => act('test', async () => {
    const d = await call(`/api/mail/accounts/${m.key}/test-send`, 'POST', { to: target });
    setSent(d);
    return d;
  });

  return (
    <div className="pm-box">
      <div className="pm-head">
        <span className="pm-addr">{m.address || 'Gmail'}</span>
        <span className={`pm-state ${m.configured ? 'pm-good' : 'pm-muted'}`}>{m.configured ? `password saved ${when(m.setAt)}` : 'not set up'}</span>
      </div>
      <div className="pm-job">{m.job}</div>
      <SendsAs sender={m.sender} />
      {m.key === 'gmail' && <GmailIntake s={gmailIntake} />}
      <div className="pm-hosts">{m.providerLabel}: IMAP {m.hosts.imap}{m.sends ? ` · SMTP ${m.hosts.smtp}` : ''}</div>

      {!m.configured ? (
        <div className="admin-inline-form">
          {m.provider === 'gmail' && (
            <input type="email" value={address} placeholder="you@gmail.com" autoComplete="off" spellCheck="false"
              onChange={(e) => setAddress(e.target.value)} />
          )}
          <input type="password" value={password} autoComplete="new-password" spellCheck="false"
            placeholder={m.provider === 'gmail' ? 'Google app password (16 letters)' : 'Mailbox password'}
            onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && password && save()} />
          <button className="admin-btn" disabled={!password || (m.provider === 'gmail' && !address) || busy} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : (
        <>
          <div className="pm-check"><CheckLine check={m.check} /></div>
          <div className="admin-inline-form">
            <button className="admin-btn" disabled={!!busy} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check connection'}</button>
            <button className="admin-btn" disabled={!!busy} onClick={forget}>Remove password</button>
          </div>
          {m.sends && (
            m.testTargets.length === 0 ? (
              <div className="pm-muted">To send a test, save a password for another of your mailboxes (Gmail is best — it shows the full verdict).</div>
            ) : (
              <div className="pm-test">
                <div className="admin-inline-form">
                  <label className="pm-muted" htmlFor={`pm-to-${m.key}`}>Test to</label>
                  <select id={`pm-to-${m.key}`} value={target} onChange={(e) => setTo(e.target.value)}>
                    {m.testTargets.map((t) => <option key={t.key} value={t.key}>{t.address}</option>)}
                  </select>
                  <button className="admin-btn" disabled={!!busy || !target} onClick={test}>{busy === 'test' ? 'Sending…' : 'Send test'}</button>
                </div>
                <div className="pm-sends pm-small">
                  From <strong>{m.sender?.from}</strong>{m.sender?.replyTo && <> · Reply-To <strong>{m.sender.replyTo}</strong></>} → <strong>{targetAddress}</strong>
                </div>
                {sent && sent.ok && <div className="pm-good pm-small">Sent. Reading it back from {sent.test?.to} — the verdict appears below within about a minute.</div>}
              </div>
            )
          )}
        </>
      )}
      {error && <div className="admin-error">{error}</div>}
    </div>
  );
}

function TestResult({ t }) {
  const state = t.sent === false ? <span className="pm-bad">not sent — {t.error}</span>
    : t.readback === 'pending' ? <span className="pm-muted">sent; reading it back…</span>
    : t.readback === 'found' ? (
      <span className={/all pass/.test(t.summary || '') && t.folder !== 'Spam' && t.folder !== 'Junk' ? 'pm-good' : 'pm-bad'}>
        {t.summary} · landed in <strong>{t.folder}</strong>{t.verdict?.receiver ? ` · judged by ${t.verdict.receiver}` : ''}
      </span>
    )
    : <span className="pm-bad">{t.readbackError || t.readback}</span>;
  return (
    <li>
      <span className="pm-muted">{when(t.sentAt)}</span> {t.from} → {t.to}<br />{state}
    </li>
  );
}

export default function PersonalMailCard() {
  const [data, setData] = useState(null);
  const [tests, setTests] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([call('/api/mail/accounts'), call('/api/mail/tests')]);
      if (a && a.ok) setData(a); else setError((a && a.error) || 'Could not read the mailboxes.');
      if (t && t.ok) setTests(t.tests || []);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // While a read-back is pending, look again every 8s.
  const pending = tests.some((t) => t.readback === 'pending');
  useEffect(() => {
    if (!pending) return undefined;
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [pending, load]);

  return (
    <div className="admin-section">
      <div className="admin-section-title">Personal email</div>
      <div className="admin-ms-section">
        <p className="admin-hint">
          Your personal mailboxes. Work mail stays on Microsoft (nickw@nurtur.tech). Passwords are stored on the Pi
          and never shown again. Nothing sends from these yet except the test below — it goes only to another of
          your own mailboxes, and NEURO reads it back to show whether SPF, DKIM and DMARC passed.
        </p>
        {error && <div className="admin-error">{error}</div>}
        {!data && !error && <div className="pm-muted">Loading…</div>}
        {data && data.mailboxes.map((m) => <Mailbox key={m.key} m={m} onChange={load} gmailIntake={data.gmailIntake} />)}
        {tests.length > 0 && (
          <div className="pm-tests">
            <div className="pm-sub">Test emails</div>
            <ul>{tests.map((t) => <TestResult key={t.id} t={t} />)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

export { SendsAs, TestResult, Mailbox };
