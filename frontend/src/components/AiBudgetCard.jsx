import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';

// The shared AI budget gate's profile (22 Oct 2026) — Settings, read-only.
// Shadow mode: it shows what NEURO and VANTAGE spent today (London day) on paid
// model, embedding and TTS calls, which call classes spent it, Radar's share,
// and every reason the gate WOULD have refused a call. It sets nothing: there is
// no daily cap until Nick chooses one, and the card says so.

const usd = (v) => (v == null ? 'unknown' : `$${Number(v).toFixed(v < 0.01 && v > 0 ? 4 : 2)}`);
const REASON_SAY = {
  'unknown-class': 'the call did not name a registered class',
  'unknown-model': 'the call did not name its model',
  'unknown-price': 'the model has no known price',
  'model-not-allowed': 'the model is not allow-listed for that class',
  'provider-not-allowed': 'the provider is not allowed for that class',
  'unbounded-input': 'the input had no bound',
  'unbounded-output': 'the output had no bound (no max tokens)',
  'input-over-bound': 'the input was over the class bound',
  'output-over-bound': 'the output bound was over the class bound',
  concurrency: 'too many calls were already running',
  volume: 'the class volume limit was reached',
  'daily-cap': 'it would have taken today past the daily cap',
};

const PEER_SAY = {
  match: null,
  mismatch: 'NEURO and VANTAGE are writing DIFFERENT ledgers',
  unreachable: 'VANTAGE could not be asked which ledger it writes',
  'not-configured': 'VANTAGE is not configured here, so its ledger could not be compared',
  unknown: 'Not yet checked whether VANTAGE writes the same ledger',
};

/** Where the shared ledger is, whether it is configured properly, and whether VANTAGE writes the same one. */
export function LedgerLine({ profile }) {
  const cfg = profile.config || {};
  const led = profile.ledger;
  const peer = profile.peer;
  const peerSay = peer ? (PEER_SAY[peer.state] === undefined ? peer.say : PEER_SAY[peer.state]) : null;
  return (
    <div className="aib__ledger" data-testid="aib-ledger">
      {cfg.ok === false && (
        <p className="aib__note" role="alert">The shared ledger is misconfigured: {(cfg.problems || []).join(' ')}</p>
      )}
      {peer && peer.state === 'mismatch' && <p className="aib__note" role="alert">{peer.say}</p>}
      <p className="aib__muted">
        Shared ledger: {led ? <><code>{led.path}</code>{led.id ? ` · id ${String(led.id).slice(0, 8)}` : ''}{led.apps ? ` · registered: ${led.apps.map((a) => a.app).join(', ') || 'none'}` : ''}</> : 'not open'}
        {peer && peer.state === 'match' ? ' · VANTAGE writes the same ledger ✓' : ''}
        {peer && peer.state !== 'match' && peer.state !== 'mismatch' && peerSay ? ` · ${peerSay}.` : ''}
      </p>
    </div>
  );
}

export function AiBudgetView({ profile, error = null }) {
  if (!profile) return <p className="admin-card-detail">{error || 'Loading the AI budget…'}</p>;
  if (!profile.known) {
    return (
      <div className="aib">
        <p className="admin-card-detail" role="alert">The shared AI ledger couldn’t be read — this is not “nothing spent”. {profile.degraded || ''}</p>
        <LedgerLine profile={profile} />
      </div>
    );
  }
  const share = profile.share || {};
  const classes = (profile.byClass || []).slice(0, 14);
  return (
    <div className="aib">
      <p className="aib__mode"><strong>Shadow mode.</strong> {profile.capSay}</p>
      <div className="aib__tiles">
        <div className="aib__tile"><span className="aib__num">{usd(profile.spendUsd)}</span><span className="aib__lbl">spent today ({profile.day}, London)</span></div>
        <div className="aib__tile"><span className="aib__num">{profile.calls}</span><span className="aib__lbl">calls admitted</span></div>
        <div className="aib__tile"><span className="aib__num">{share.usd == null ? '—' : usd(share.usd)}</span><span className="aib__lbl">Radar{share.fraction != null ? ` — ${Math.round(share.fraction * 100)}% of today` : ''}</span></div>
        <div className="aib__tile"><span className="aib__num">{profile.wouldRefuse}</span><span className="aib__lbl">would have been refused</span></div>
      </div>
      {(profile.unknownCostCalls > 0 || profile.pessimisticCalls > 0 || profile.openReservedUsd > 0) && (
        <p className="aib__note">
          {profile.unknownCostCalls > 0 ? `${profile.unknownCostCalls} call(s) could not be priced, so today’s total is a floor. ` : ''}
          {profile.pessimisticCalls > 0 ? `${profile.pessimisticCalls} call(s) are counted at their worst case because no usage came back. ` : ''}
          {profile.openReservedUsd > 0 ? `${usd(profile.openReservedUsd)} is reserved by calls still running.` : ''}
        </p>
      )}
      {classes.length > 0 ? (
        <table className="aib__table">
          <thead><tr><th>Call class</th><th>App</th><th>Calls</th><th>Spent</th><th>Would refuse</th></tr></thead>
          <tbody>
            {classes.map((c) => (
              <tr key={`${c.app}:${c.callClass}`}>
                <td>{c.callClass}</td><td>{c.app}</td><td>{c.calls}</td>
                <td>{c.unknownCost ? `${usd(c.usd)} + ${c.unknownCost} unpriced` : usd(c.usd)}</td>
                <td>{c.wouldRefuse || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="aib__note">No model, embedding or TTS calls have gone through the gate today.</p>}
      {(profile.refusals || []).length > 0 && (
        <div className="aib__refusals">
          <div className="aib__h">Why the gate would have refused</div>
          <ul>
            {profile.refusals.map((r) => (
              <li key={r.reason}><strong>{r.count}×</strong> {REASON_SAY[r.reason] || r.reason} <span className="aib__muted">({r.classes.join(', ')})</span></li>
            ))}
          </ul>
        </div>
      )}
      {(profile.unpricedModels || []).length > 0 && (
        <p className="aib__note">No known price for: {profile.unpricedModels.join(', ')}. Prices last checked {profile.pricesCheckedOn}.</p>
      )}
      {(profile.history || []).length > 1 && (
        <p className="aib__muted">Last {profile.history.length} days: {profile.history.map((h) => `${h.day.slice(5)} ${usd(h.usd)}`).join(' · ')}</p>
      )}
      {profile.degraded && <p className="aib__note" role="alert">{profile.degraded}</p>}
      <LedgerLine profile={profile} />
    </div>
  );
}

export default function AiBudgetCard() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    apiFetch('/api/ai-gate/profile').then((r) => r.json()).then((b) => { if (live) setProfile(b); })
      .catch(() => { if (live) setError('NEURO didn’t answer — the AI budget is unknown, not zero.'); });
    return () => { live = false; };
  }, []);
  return <AiBudgetView profile={profile} error={error} />;
}
