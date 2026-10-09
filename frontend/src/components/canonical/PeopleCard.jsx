import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks } from './canonicalUi';

/**
 * Life → People (Build 31). Who the people in Nick's life are to him — only
 * as he has said. Household, Family, Friends, Other and Unknown are open;
 * Work is folded (the People board is where work people live).
 *
 * NOT a CRM: no contact frequency, no "last spoke", no scores, no social graph,
 * no visit history. Presence is "home now" for the household and nothing else.
 * Every relationship says why NEURO holds it; every correction goes into the
 * person's People note and is audited.
 */

const REL = {
  spouse_partner: 'Partner', child: 'Child', parent: 'Parent', sibling: 'Sibling', extended_family: 'Extended family',
  friend: 'Friend', colleague: 'Colleague', manager: 'Your manager', direct_report: 'Your direct report',
  professional_contact: 'Professional contact', service_contact: 'Service contact', household_member: 'Lives with you',
  acquaintance: 'Acquaintance', other: 'Other', unknown: 'Not said', self: 'You',
};
const REL_ORDER = ['spouse_partner', 'child', 'parent', 'sibling', 'extended_family', 'friend', 'household_member',
  'colleague', 'manager', 'direct_report', 'professional_contact', 'service_contact', 'acquaintance', 'other', 'unknown'];
const SPHERE = { personal: 'Personal', work: 'Work', both: 'Work & personal', unknown: 'Not said' };
const BASIS = { declared: 'you said', 'note-field': 'from the note', configured: 'HA roster', relationship: 'follows', none: '' };
const PRESENCE = { home: 'home now', away: 'out', unknown: 'unknown' };

function RelSelect({ value, onChange, disabled }) {
  return (
    <select value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-label="Relationship">
      <option value="">relationship…</option>
      {REL_ORDER.map((r) => <option key={r} value={r}>{r === 'unknown' ? 'Leave as not said' : REL[r]}</option>)}
    </select>
  );
}

function SphereSelect({ value, onChange, disabled }) {
  return (
    <select value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-label="Work or personal">
      <option value="">work or personal…</option>
      {['personal', 'work', 'both', 'unknown'].map((s) => <option key={s} value={s}>{SPHERE[s]}</option>)}
    </select>
  );
}

/** One editor for "Who is this?" and "Change". Only fields Nick touches are sent. */
function Classify({ person, act, busy, compact = false }) {
  const [draft, setDraft] = useState({});
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0;
  const rel = draft.relationshipType !== undefined ? draft.relationshipType : (person.relationship.basis === 'declared' ? person.relationship.type : null);
  const sph = draft.sphere !== undefined ? draft.sphere : (person.sphere.basis === 'declared' ? person.sphere.value : null);
  const hh = draft.household !== undefined ? draft.household : (person.household.basis === 'declared' ? person.household.value : null);
  return (
    <div className="cn-row-actions" data-testid="people-classify">
      <RelSelect value={rel} disabled={busy} onChange={(v) => set('relationshipType', v)} />
      {!compact && (
        <input type="text" maxLength={60} placeholder="detail (e.g. mother-in-law)" disabled={busy} aria-label="Relationship detail"
          value={draft.relationshipDetail !== undefined ? draft.relationshipDetail || '' : person.relationship.detail || ''}
          onChange={(e) => set('relationshipDetail', e.target.value || null)} />
      )}
      <SphereSelect value={sph} disabled={busy} onChange={(v) => set('sphere', v)} />
      <select value={hh === true ? 'yes' : hh === false ? 'no' : ''} disabled={busy} aria-label="Lives with you"
        onChange={(e) => set('household', e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
        <option value="">lives with you?</option><option value="yes">Lives with you</option><option value="no">Doesn’t live with you</option>
      </select>
      <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !dirty}
        onClick={async () => { if (await act(`/api/people/${encodeURIComponent(person.personId)}/classify`, draft)) setDraft({}); }}>Save</button>
    </div>
  );
}

function PersonRow({ p, act, busy, showWork = false }) {
  const [open, setOpen] = useState(false);
  const c = p.commitments || { open: 0 };
  const next = (p.dates || [])[0];
  return (
    <li data-testid="people-person">
      <strong>{p.name}</strong>
      <span className="cn-chip" title={p.relationship.why}>{p.relationship.detail ? `${REL[p.relationship.type] || p.relationship.type} · ${p.relationship.detail}` : REL[p.relationship.type] || p.relationship.type}</span>
      {p.relationship.basis !== 'none' && BASIS[p.relationship.basis] && <span className="cn-muted cn-small"> ({BASIS[p.relationship.basis]})</span>}
      {p.sphere.value !== 'unknown' && <span className="cn-chip" title={p.sphere.why}>{SPHERE[p.sphere.value]}</span>}
      {p.presence && <span className="cn-chip" title={p.presence.why}>{PRESENCE[p.presence.state] || p.presence.state}</span>}
      {next && <span className="cn-chip" title={next.reminder.why}>{next.kind} {next.date.slice(5)}{next.reminder.policy === 'none' ? '' : ' · reminders on'}</span>}
      {c.open > 0 && <span className="cn-chip">{[c.nickOwes ? `you owe ${c.nickOwes}` : null, c.owesNick ? `owes you ${c.owesNick}` : null].filter(Boolean).join(' · ')}</span>}
      <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Details'}</button>
      {open && (
        <div className="cn-small" data-testid="people-detail">
          <div className="cn-muted">Why: {p.relationship.why} {p.sphere.basis !== 'none' ? p.sphere.why : ''} {p.household.basis !== 'none' ? p.household.why : ''}</div>
          <YouWrote lines={p.youWrote} />
          {(p.dates || []).map((d) => <div key={d.id}>{d.kind === 'birthday' ? 'Birthday' : d.kind === 'anniversary' ? 'Anniversary' : 'Date'} {d.date} — {d.reminder.why}</div>)}
          {(c.items || []).map((i) => <div key={i.id}>{i.direction === 'nick-owes' ? 'You owe' : 'Owes you'}: {i.description}{i.due ? ` (by ${i.due.date})` : ''}{i.linkedBy === 'unique-first-name' ? ' — linked by first name only' : ''}</div>)}
          {c.open > (c.items || []).length && <div className="cn-muted">…and {c.open - c.items.length} more open.</div>}
          {p.context && p.context.personal && <div>Likes: {p.context.personal.likes.join(', ')}</div>}
          {showWork && p.context && p.context.work && <div className="cn-muted">{[p.context.work.role, p.context.work.team].filter(Boolean).join(' · ')}</div>}
          {p.relationship.type !== 'self' && <Classify person={p} act={act} busy={busy} />}
          {p.rosterMatch && (
            <div className="cn-muted">Home Assistant’s “{p.rosterMatch.name}” is matched to this note by {p.rosterMatch.method === 'exact-alias' ? 'an alias' : 'its exact name'}.{' '}
              <button type="button" className="cn-btn cn-btn--tiny" disabled={busy}
                onClick={() => act('/api/people/links/reject', { subject: p.rosterMatch.subject, personId: p.personId })}>Not this person</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Nick's own words, verbatim. Shown so confirming is quick — never applied. */
function YouWrote({ lines }) {
  if (!lines || !lines.length) return null;
  return <div className="cn-small" data-testid="people-you-wrote">You wrote: {lines.map((l) => `“${l}”`).join(' · ')} <span className="cn-muted">(NEURO doesn’t act on this until you confirm.)</span></div>;
}

function CreateFromRoster({ m, act, busy }) {
  const [name, setName] = useState(m.name);
  const [rel, setRel] = useState(null);
  return (
    <li data-testid="people-unlinked">
      <strong>{m.name}</strong> <span className="cn-chip">{m.role === 'resident' ? 'resident' : 'visiting'}</span>
      {m.presence && <span className="cn-chip">{PRESENCE[m.presence.state] || m.presence.state}</span>}
      <div className="cn-muted cn-small">{m.why}</div>
      <YouWrote lines={m.youWrote} />
      <div className="cn-row-actions">
        <input type="text" value={name} maxLength={60} disabled={busy} aria-label="Full name for the People note" onChange={(e) => setName(e.target.value)} />
        <RelSelect value={rel} disabled={busy} onChange={setRel} />
        <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !name.trim()}
          onClick={() => act('/api/people', { name: name.trim(), rosterName: m.name, relationshipType: rel || undefined, household: m.role === 'resident' ? true : undefined })}>
          Create People note</button>
      </div>
    </li>
  );
}

export default function PeopleCard() {
  const { data, error, reload } = useCanonical('/api/people');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const act = async (path, body) => {
    setBusy(true); setMsg(null);
    try { await postCanonical(path, body); reload(); return true; } catch (e) { setMsg(e.message); return false; } finally { setBusy(false); }
  };
  return <PeopleView data={data} error={error} act={act} busy={busy} msg={msg} />;
}

/** The view, from a `people-v1` payload. Exported so it renders in tests from the REAL read. */
export function PeopleView({ data, error = null, act, busy = false, msg = null }) {
  const [skipped, setSkipped] = useState([]);
  const sections = data ? data.sections : [];
  const sec = (id) => (sections.find((s) => s.id === id) || { people: [] }).people;
  const queue = data ? data.queue.next.filter((p) => !skipped.includes(p.personId)) : [];
  const counts = data ? data.counts : null;
  const meta = counts ? `${counts.classified} of ${counts.active - (data.self ? 1 : 0)} known · ${counts.unknown} not said` : null;

  return (
    <section className="cn-section" data-testid="people-card">
      <h3 className="cn-h3">People</h3>
      {error && <div className="cn-error">Couldn’t read People — {error}</div>}
      {msg && <div className="cn-error">Not saved — {msg}</div>}
      {!data && !error && <div className="cn-muted">Reading…</div>}
      {data && (
        <>
          <p className="cn-muted cn-small">{meta}. Who someone is to you comes only from what you’ve told NEURO.</p>

          {(sec('household').length > 0 || data.unlinkedHousehold.length > 0) && (
            <Fold title="Household" meta={`${sec('household').length + data.unlinkedHousehold.length}`} open>
              <ul className="cn-list">
                {sec('household').map((p) => <PersonRow key={p.personId} p={p} act={act} busy={busy} />)}
                {data.unlinkedHousehold.map((m) => <CreateFromRoster key={m.subject} m={m} act={act} busy={busy} />)}
              </ul>
            </Fold>
          )}

          {queue.length > 0 && (
            <Fold title="Who is this?" meta={`${data.queue.total} not said`} open={sec('household').length === 0}>
              <p className="cn-muted cn-small">A few at a time is fine. “Leave as not said” takes someone off this list.</p>
              <ul className="cn-list">
                {queue.map((p) => (
                  <li key={p.personId} data-testid="people-queue">
                    <strong>{p.name}</strong>{p.context && p.context.work && p.context.work.team && <span className="cn-muted"> — {p.context.work.team}</span>}
                    <Classify person={p} act={act} busy={busy} compact />
                    <button type="button" className="cn-btn cn-btn--tiny" onClick={() => setSkipped((s) => [...s, p.personId])}>Not now</button>
                  </li>
                ))}
              </ul>
            </Fold>
          )}

          {['family', 'friends', 'other', 'unknown'].map((id) => sec(id).length > 0 && (
            <Fold key={id} title={sections.find((s) => s.id === id).label} meta={`${sec(id).length}`} open={id !== 'unknown'}>
              <ul className="cn-list">{sec(id).map((p) => <PersonRow key={p.personId} p={p} act={act} busy={busy} />)}</ul>
            </Fold>
          ))}

          <Fold title="Work" meta={`${sec('work').length}`}>
            <p className="cn-muted cn-small">Kept separate from your personal life. The People board has the 1-2-1s.</p>
            <ul className="cn-list">{sec('work').map((p) => <PersonRow key={p.personId} p={p} act={act} busy={busy} showWork />)}</ul>
          </Fold>

          {data.unlinkedDates.length > 0 && (
            <Fold title="Dates with no person" meta={`${data.unlinkedDates.length}`}>
              <ul className="cn-list">{data.unlinkedDates.map((d) => (
                <li key={d.id} data-testid="people-unlinked-date">{d.title} — {d.date}<div className="cn-muted cn-small">{d.why} {d.reminder.why}</div></li>
              ))}</ul>
            </Fold>
          )}

          {data.duplicates.length > 0 && (
            <Fold title="Possibly the same person" meta={`${data.duplicates.length}`} open>
              <ul className="cn-list">{data.duplicates.map((d) => (
                <li key={d.key} data-testid="people-duplicate">
                  <strong>{d.a.name}</strong> and <strong>{d.b.name}</strong><div className="cn-muted cn-small">{d.why.join('; ')}</div>
                  <div className="cn-row-actions">
                    <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act('/api/people/duplicates/decide', { a: d.a.personId, b: d.b.personId, decision: 'merge', keep: d.a.personId })}>Same — keep {d.a.name}</button>
                    <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act('/api/people/duplicates/decide', { a: d.a.personId, b: d.b.personId, decision: 'merge', keep: d.b.personId })}>Same — keep {d.b.name}</button>
                    <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => act('/api/people/duplicates/decide', { a: d.a.personId, b: d.b.personId, decision: 'keep-separate' })}>Different people</button>
                  </div>
                </li>
              ))}</ul>
            </Fold>
          )}

          <Fold title="Sources" meta={data.sources.filter((s) => s.state !== 'ok' && s.state !== 'complete' && s.state !== 'not-used').length ? 'something not read' : 'read'}>
            <ul className="cn-list">{data.sources.map((s) => (
              <li key={s.id} data-testid="people-source"><strong>{s.label}</strong> <span className="cn-chip">{s.state}</span><div className="cn-muted cn-small">{s.detail}</div></li>
            ))}</ul>
          </Fold>
          <HowItWorks>{data.rule} NEURO never counts how often you see, meet or message anyone, never scores a relationship and never reminds you to keep in touch. A birthday is a fact; it only reminds you if you set lead reminders for that kind of date.</HowItWorks>
        </>
      )}
    </section>
  );
}
