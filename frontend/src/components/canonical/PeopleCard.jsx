import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks, Headline, Stat, StatTiles, Tile, TileGrid, Group, dayLabel } from './canonicalUi';

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

// What a relationship already answers. Mirrors people-model's sphereOfType (the
// server derives sphere from the relationship, basis "follows"), so asking again
// is a question with only one sensible answer. Household is only implied where
// the relationship IS the answer; "work" types never live with you by default.
const IMPLIED = {
  colleague: { sphere: 'work', household: false }, manager: { sphere: 'work', household: false },
  direct_report: { sphere: 'work', household: false }, professional_contact: { sphere: 'work', household: false },
  service_contact: { household: false },
  household_member: { sphere: 'personal', household: true },
  spouse_partner: { sphere: 'personal' }, child: { sphere: 'personal' }, parent: { sphere: 'personal' },
  sibling: { sphere: 'personal' }, extended_family: { sphere: 'personal' }, friend: { sphere: 'personal' },
};

/** One editor for "Who is this?" and "Change". Only fields Nick touches are sent. */
function Classify({ person, act, busy, compact = false }) {
  const [draft, setDraft] = useState({});
  const [more, setMore] = useState(false);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0;
  const rel = draft.relationshipType !== undefined ? draft.relationshipType : (person.relationship.basis === 'declared' ? person.relationship.type : null);
  const sph = draft.sphere !== undefined ? draft.sphere : (person.sphere.basis === 'declared' ? person.sphere.value : null);
  const hh = draft.household !== undefined ? draft.household : (person.household.basis === 'declared' ? person.household.value : null);
  const implied = (rel && IMPLIED[rel]) || {};
  // Hidden only while Nick has not answered it himself — an explicit answer
  // (e.g. "Work & personal" for a colleague who is also a friend) stays visible.
  const askSphere = more || !implied.sphere || sph != null;
  const askHousehold = more || implied.household === undefined || hh != null;
  const impliedNote = [
    !askSphere ? SPHERE[implied.sphere] : null,
    !askHousehold ? (implied.household ? 'lives with you' : 'doesn’t live with you') : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="cn-row-actions" data-testid="people-classify">
      <RelSelect value={rel} disabled={busy} onChange={(v) => set('relationshipType', v)} />
      {!compact && (
        <input type="text" maxLength={60} placeholder="detail (e.g. mother-in-law)" disabled={busy} aria-label="Relationship detail"
          value={draft.relationshipDetail !== undefined ? draft.relationshipDetail || '' : person.relationship.detail || ''}
          onChange={(e) => set('relationshipDetail', e.target.value || null)} />
      )}
      {askSphere && <SphereSelect value={sph} disabled={busy} onChange={(v) => set('sphere', v)} />}
      {askHousehold && (
        <select value={hh === true ? 'yes' : hh === false ? 'no' : ''} disabled={busy} aria-label="Lives with you"
          onChange={(e) => set('household', e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
          <option value="">lives with you?</option><option value="yes">Lives with you</option><option value="no">Doesn’t live with you</option>
        </select>
      )}
      {impliedNote && (
        <span className="cn-muted cn-small" data-testid="people-implied">
          {impliedNote}{' '}
          <button type="button" className="cn-btn cn-btn--tiny" disabled={busy} onClick={() => setMore(true)}>Not quite?</button>
        </span>
      )}
      <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !dirty}
        onClick={async () => {
          // What the line says is what gets recorded: a hidden "doesn't live with
          // you" is written as household:false, never left as an unstated guess.
          // Sphere needs no write — the server derives it from the relationship.
          const body = !askHousehold && implied.household === false && draft.relationshipType ? { ...draft, household: false } : draft;
          if (await act(`/api/people/${encodeURIComponent(person.personId)}/classify`, body)) { setDraft({}); setMore(false); }
        }}>Save</button>
    </div>
  );
}

const relLabel = (p) => (p.relationship.detail ? `${REL[p.relationship.type] || p.relationship.type} · ${p.relationship.detail}` : REL[p.relationship.type] || p.relationship.type);

/** Where the relationship came from — on hover, never a line under every person. */
function provenance(p) {
  const basis = p.relationship.basis !== 'none' && BASIS[p.relationship.basis] ? ` (${BASIS[p.relationship.basis]})` : '';
  return `${relLabel(p)}${basis}: ${p.relationship.why || ''}`.trim();
}

/** One person as a tile. Details open below the grid, full width, so the editor has room. */
function PersonTile({ p, open, onToggle }) {
  const c = p.commitments || { open: 0 };
  const next = (p.dates || [])[0];
  return (
    <Tile testid="people-person" title={p.name} sub={relLabel(p)} why={provenance(p)}
      foot={<>
        {p.sphere.value !== 'unknown' && <span className="cn-chip" title={p.sphere.why}>{SPHERE[p.sphere.value]}</span>}
        {p.presence && <span className="cn-chip" title={p.presence.why}>{PRESENCE[p.presence.state] || p.presence.state}</span>}
        {next && <span className="cn-chip" title={next.reminder.why}>{next.kind} {dayLabel(next.date)}{next.reminder.policy === 'none' ? '' : ' · reminders on'}</span>}
        {c.open > 0 && <span className="cn-chip">{[c.nickOwes ? `you owe ${c.nickOwes}` : null, c.owesNick ? `owes you ${c.owesNick}` : null].filter(Boolean).join(' · ')}</span>}
        <button type="button" className="cn-btn cn-btn--tiny" aria-expanded={open} onClick={onToggle}>{open ? 'Close' : 'Details'}</button>
      </>} />
  );
}

function PersonDetail({ p, act, busy, showWork = false, onClose }) {
  const c = p.commitments || { open: 0 };
  return (
    <div className="cn-small cn-tile-detail" data-testid="people-detail">
      <div><strong>{p.name}</strong> <button type="button" className="cn-btn cn-btn--tiny" onClick={onClose}>Close</button></div>
      <div className="cn-muted">Why: {p.relationship.why} {p.sphere.basis !== 'none' ? p.sphere.why : ''} {p.household.basis !== 'none' ? p.household.why : ''}</div>
      <YouWrote lines={p.youWrote} />
      {(p.dates || []).map((d) => <div key={d.id}>{d.kind === 'birthday' ? 'Birthday' : d.kind === 'anniversary' ? 'Anniversary' : 'Date'} {dayLabel(d.date)} — {d.reminder.why}</div>)}
      {(c.items || []).map((i) => <div key={i.id}>{i.direction === 'nick-owes' ? 'You owe' : 'Owes you'}: {i.description}{i.due ? ` (by ${dayLabel(i.due.date)})` : ''}{i.linkedBy === 'unique-first-name' ? ' — linked by first name only' : ''}</div>)}
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
  );
}

/** A set of people as tiles (plus, for the household, roster entries with no note yet). */
function PeopleTiles({ people, roster = [], act, busy, showWork = false, testid }) {
  const [openId, setOpenId] = useState(null);
  const opened = people.find((p) => p.personId === openId) || null;
  return (
    <>
      <TileGrid testid={testid}>
        {people.map((p) => <PersonTile key={p.personId} p={p} open={openId === p.personId} onToggle={() => setOpenId(openId === p.personId ? null : p.personId)} />)}
        {roster.map((m) => <CreateFromRoster key={m.subject} m={m} act={act} busy={busy} />)}
      </TileGrid>
      {opened && <PersonDetail p={opened} act={act} busy={busy} showWork={showWork} onClose={() => setOpenId(null)} />}
    </>
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
    <Tile testid="people-unlinked" title={m.name} sub={m.role === 'resident' ? 'Lives here · no People note yet' : 'Visiting · no People note yet'} why={m.why}
      foot={m.presence ? <span className="cn-chip">{PRESENCE[m.presence.state] || m.presence.state}</span> : null}>
      <YouWrote lines={m.youWrote} />
      <div className="cn-row-actions">
        <input type="text" value={name} maxLength={60} disabled={busy} aria-label="Full name for the People note" onChange={(e) => setName(e.target.value)} />
        <RelSelect value={rel} disabled={busy} onChange={setRel} />
        <button type="button" className="cn-btn cn-btn--tiny" disabled={busy || !name.trim()}
          onClick={() => act('/api/people', { name: name.trim(), rosterName: m.name, relationshipType: rel || undefined, household: m.role === 'resident' ? true : undefined })}>
          Create People note</button>
      </div>
    </Tile>
  );
}

export default function PeopleCard({ onNavigate = null } = {}) {
  const { data, error, reload } = useCanonical('/api/people');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const act = async (path, body) => {
    setBusy(true); setMsg(null);
    try { await postCanonical(path, body); reload(); return true; } catch (e) { setMsg(e.message); return false; } finally { setBusy(false); }
  };
  return <PeopleView data={data} error={error} act={act} busy={busy} msg={msg} onNavigate={onNavigate} />;
}

/** The view, from a `people-v1` payload. Exported so it renders in tests from the REAL read. */
export function PeopleView({ data, error = null, act, busy = false, msg = null, onNavigate = null }) {
  const [skipped, setSkipped] = useState([]);
  const sections = data ? data.sections : [];
  const sec = (id) => (sections.find((s) => s.id === id) || { people: [] }).people;
  const queue = data ? data.queue.next.filter((p) => !skipped.includes(p.personId)) : [];
  const counts = data ? data.counts : null;
  const household = sec('household');
  const unlinked = data ? data.unlinkedHousehold : [];
  const known = counts ? counts.active - (data.self ? 1 : 0) : null;
  // Presence is "home now" for the household and nothing else (the server's answer).
  const homeNow = [...household.filter((p) => p.presence && p.presence.state === 'home').map((p) => p.name.split(' ')[0]),
    ...unlinked.filter((m) => m.presence && m.presence.state === 'home').map((m) => m.name)];
  const names = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

  return (
    <section className="cn-section" data-testid="people-card">
      <h3 className="cn-h3">People</h3>
      {error && <div className="cn-error">Couldn’t read People — {error}</div>}
      {msg && <div className="cn-error">Not saved — {msg}</div>}
      {!data && !error && <div className="cn-muted">Reading…</div>}
      {data && (
        <>
          <Headline testid="people-headline" tone={data.duplicates.length ? 'warn' : counts.unknown ? undefined : 'good'}
            pill={data.duplicates.length ? 'check duplicates' : counts.unknown ? 'some not said' : 'all placed'}>
            {homeNow.length ? `${names(homeNow)} ${homeNow.length === 1 ? 'is' : 'are'} home now.` : 'Who people are to you — only as you’ve said.'}
          </Headline>
          <StatTiles>
            <Stat v={counts.classified} l={`known of ${known}`} />
            <Stat v={counts.unknown} l="not said yet" />
            <Stat v={household.length + unlinked.length} l="household" />
            <Stat v={sec('work').length} l="work contacts" />
          </StatTiles>

          {(household.length > 0 || unlinked.length > 0) && (
            <Group label="Household" meta={`${household.length + unlinked.length}`}>
              <PeopleTiles people={household} roster={unlinked} act={act} busy={busy} testid="people-household" />
            </Group>
          )}

          {queue.length > 0 && (
            <Fold title="Who is this?" meta={`${data.queue.total} not said`} open={household.length === 0}>
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

          {['family', 'friends', 'other'].map((id) => sec(id).length > 0 && (
            <Group key={id} label={sections.find((s) => s.id === id).label} meta={`${sec(id).length}`}>
              <PeopleTiles people={sec(id)} act={act} busy={busy} testid={`people-${id}`} />
            </Group>
          ))}
          {sec('unknown').length > 0 && (
            <Fold title={sections.find((s) => s.id === 'unknown').label} meta={`${sec('unknown').length}`}>
              <PeopleTiles people={sec('unknown')} act={act} busy={busy} testid="people-unknown" />
            </Fold>
          )}

          {/* 13 Oct 2026 — work people live on the People board (People & meetings),
              with the 1-2-1s and who owes what. Here they are one line, and the
              list stays one click away only to correct who counts as work. */}
          {sec('work').length > 0 && (
            <div className="cn-nowstrip" data-testid="people-work-link">
              <span>Work contacts live on the People board, with the 1-2-1s.</span>
              {onNavigate && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => onNavigate('people')}>Open People board</button>}
            </div>
          )}
          {sec('work').length > 0 && (
            <Fold title="Work — correct who counts as work" meta={`${sec('work').length}`}>
              <PeopleTiles people={sec('work')} act={act} busy={busy} showWork testid="people-work" />
            </Fold>
          )}

          {data.unlinkedDates.length > 0 && (
            <Fold title="Dates with no person" meta={`${data.unlinkedDates.length}`}>
              <ul className="cn-list">{data.unlinkedDates.map((d) => (
                <li key={d.id} data-testid="people-unlinked-date">{d.title} — {dayLabel(d.date)}<div className="cn-muted cn-small">{d.why} {d.reminder.why}</div></li>
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
          <HowItWorks>{data.rule} Who someone is to you comes only from what you’ve told NEURO; hover a person to see where it came from. NEURO never counts how often you see, meet or message anyone, never scores a relationship and never reminds you to keep in touch. A birthday is a fact; it only reminds you if you set lead reminders for that kind of date.</HowItWorks>
        </>
      )}
    </section>
  );
}
