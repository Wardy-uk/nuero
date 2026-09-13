import './Shelf.css';

// The shelf — what she can reach right now.
//
// Bottom-right in the Approach layout, and the contract is `sara/MANIFESTATION.md`:
// it is HARDWARE, NOT CONTENT. It has no hour, so it never rides the corridor and
// never competes for the lead slot, and it NEVER GOES EMPTY — an empty corner
// reads as a broken screen, and "there is nothing I can reach from here" is a
// fact worth printing.
//
// ── The rules ───────────────────────────────────────────────────────────────
//
//   * A BUTTON ONLY WHERE A ROUTE EXISTS. `rooms.act()` has exactly one caller
//     and it answers an OFFER key, so a light SARA has not offered is a
//     STATEMENT — "2 lamps off" — and not a control. A button NEURO would
//     refuse is worse than no button, which is the rule the desk row already
//     holds and the reason this file reads `offers` rather than `considered`
//     when deciding what is pressable.
//   * UNREACHABLE RENDERS DASHED, NEVER MISSING. A bulb switched off at the
//     wall reads `unavailable`, not `off` — three light states, not two — and a
//     control that would fail on the tap is worse than one that says it cannot.
//     Same for the laptop when it is asleep.
//   * NOT KNOWN IS NOT NOTHING. An unread house and an empty house are opposite
//     facts, and only one of them is an all-clear.
//   * IT PHRASES NOTHING IT WAS GIVEN. Every sentence here is either a label or
//     a number off the payload; the one transformation is putting a space in a
//     Home Assistant condition token, which is spelling, not judgement.

// `partlycloudy` is a machine token, not prose. Only the compounds HA actually
// sends are spaced; anything unrecognised prints as it arrived rather than
// being guessed at.
const CONDITION_WORDS = {
  partlycloudy: 'partly cloudy',
  clearnight: 'clear',
  rainy: 'rain',
  pouring: 'heavy rain',
  lightning: 'thunder',
  'lightning-rainy': 'thundery rain',
  snowy: 'snow',
  'snowy-rainy': 'sleet',
  windy: 'windy',
  'windy-variant': 'windy',
  exceptional: 'exceptional',
};
export function conditionWords(c) {
  if (typeof c !== 'string' || !c) return null;
  return CONDITION_WORDS[c] || c;
}

// One decimal is what the sensor gives; a whole number is what a person says.
function temp(c) {
  return Number.isFinite(c) ? `${Math.round(c)}°` : null;
}

export default function Shelf({
  weather = null,
  rooms = null,
  work = null,
  deskStates = {},
  onDeskOpen = null,
  onRoomAct = null,
}) {
  const items = [];

  // ── The laptop ────────────────────────────────────────────────────────────
  //
  // ⚠ Offered only where the machine ANSWERED. `deskKnown === false` is a
  // laptop SARA cannot see — asleep, off, or off the tailnet — which is not the
  // same as one with nothing to open, and the two are said differently.
  // ⚠ THE FIELD IS `apps`. The first cut read `offered` — an identifier taken
  // from memory rather than grepped — and rendered an empty shelf against a
  // machine that had four things to open. A wrong field name returns undefined
  // rather than throwing, so it fails silently and looks like a quiet laptop;
  // `surface-rooms-render` is what caught it. Same species as `sleep_core_hours`
  // and `meeting_alert`.
  const offer = work && work.deskOffer;
  const host = (offer && offer.host) || (work && work.host) || null;
  const apps = offer && Array.isArray(offer.apps) ? offer.apps : [];
  if (onDeskOpen && apps.length > 0 && work.atDesk) {
    apps.forEach(({ id, label }) => {
      items.push({
        key: `app-${id}`,
        text: label,
        state: deskStates[id] || null,
        onPress: () => onDeskOpen(id),
      });
    });
  } else if (onDeskOpen && apps.length > 0) {
    // It exists and he is not at it. Shown, dashed, so the shelf still says what
    // the machine can do rather than pretending it has nothing.
    apps.forEach(({ id, label }) => {
      items.push({ key: `app-${id}`, text: label, off: true });
    });
  } else if (onDeskOpen && offer && offer.why) {
    // It is at the desk and the machine offered nothing — which fact that is
    // matters, so it is printed rather than left as an absence.
    items.push({ key: 'app-why', text: offer.why, quiet: true });
  }

  // ── The house ─────────────────────────────────────────────────────────────
  //
  // An OFFER is pressable because `/api/rooms/:key/accept` exists for it. Room
  // state is not: it is printed.
  // ⚠ AN OFFER IS ANSWERABLE BOTH WAYS. The first cut rendered it as a single
  // button carrying the words — so there was no way to say no, and DECLINING is
  // the half the decision memory learns from; every yes and every no is stored
  // with the context that produced it, and that is the training set. Where the
  // shell cannot act at all it is rendered as a STATEMENT with no buttons,
  // never as a control that fails on the tap.
  (rooms?.offers || []).forEach((o) => {
    items.push({ key: `offer-${o.key}`, text: o.say, ask: onRoomAct ? o.key : null, lead: true });
  });

  (rooms?.considered || []).forEach((area) => {
    const t = temp(area?.temperature?.reading?.currentC);
    if (t) items.push({ key: `t-${area.area}`, text: `${area.area} ${t}`, quiet: true });
    const lights = area?.lights;
    if (lights && Number.isFinite(lights.total) && lights.total > 0) {
      const on = (lights.on || []).length;
      const off = (lights.off || []).length;
      if (on > 0) items.push({ key: `l-${area.area}`, text: `${on} on`, quiet: true });
      else if (off > 0) items.push({ key: `l-${area.area}`, text: `${off} off`, quiet: true });
      // ⚠ Off at the wall — she cannot reach it, and the dash says so rather
      // than the bulb simply being absent from the shelf.
      const un = (lights.unreachable || []).length;
      if (un > 0) items.push({ key: `u-${area.area}`, text: `${un} at the wall`, off: true });
    }
  });

  // ── What the shelf says about itself ──────────────────────────────────────
  const caption = host && work && work.atDesk ? `open on ${host}`
    : work && work.deskKnown === false ? 'I can’t see your laptop'
      : host ? `${host} is asleep`
        : rooms && rooms.known === false ? 'I couldn’t read the house'
          : 'in the house';

  const wx = weather && weather.known === false
    ? { lead: 'Weather unread', sub: 'not an all-clear' }
    : weather && Number.isFinite(weather.tempC)
      ? {
        lead: `${weather.tempC.toFixed(1).replace(/\.0$/, '')}${weather.unit || '°C'}`,
        sub: [
          conditionWords(weather.condition),
          weather.rain && weather.rain.expected ? `rain ${weather.rain.when || 'later'}` : null,
        ].filter(Boolean).join(' · ') || null,
      }
      : null;

  // ⚠ Never silent. With no weather, no house and no laptop there is still a
  // line, because a blank corner and a broken screen look identical.
  if (!wx && items.length === 0) {
    return (
      <div className="shelf">
        <span className="shelf__cap">{caption}</span>
        <div className="shelf__row"><span className="shelf__none">Nothing I can reach from here.</span></div>
      </div>
    );
  }

  return (
    <div className="shelf">
      <span className="shelf__cap">{caption}</span>
      <div className="shelf__row">
        {wx && (
          <div className="shelf__wx">
            <u>{wx.lead}</u>
            {wx.sub && <s>{wx.sub}</s>}
          </div>
        )}
        {items.map((it) => (it.ask ? (
          <span key={it.key} className="shelf__offer">
            <span className="shelf__offersay">{it.text}</span>
            <button type="button" className="shelf__btn shelf__btn--lead"
              onClick={() => onRoomAct(it.ask, 'accept')}>Yes</button>
            <button type="button" className="shelf__btn"
              onClick={() => onRoomAct(it.ask, 'decline')}>Not now</button>
          </span>
        ) : it.onPress ? (
          <button
            key={it.key}
            type="button"
            className={`shelf__btn${it.lead ? ' shelf__btn--lead' : ''}`}
            onClick={it.onPress}
          >
            {it.text}
            {it.state && <span className="shelf__state"> · {it.state}</span>}
          </button>
        ) : (
          <span
            key={it.key}
            className={`shelf__btn${it.off ? ' shelf__btn--off' : ''}${it.quiet ? ' shelf__btn--quiet' : ''}`}
          >
            {it.text}
            {it.state && <span className="shelf__state"> · {it.state}</span>}
          </span>
        )))}
      </div>
    </div>
  );
}
