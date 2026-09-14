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
  /**
   * ⚠⚠ THE DEVICE'S OWN CONTROLS. The mic sat in the foot, styled like nothing
   * else on the screen, and it belongs here: MANIFESTATION.md already says what
   * this corner is — "the bottom-right corner is HARDWARE, not content: weather
   * now-and-next, the desk-intent apps where the laptop answered, the house
   * doors where the house answered." A microphone is exactly that, a capability
   * of the thing he is holding, offered only where it exists.
   *
   * ⚠ A SLOT RATHER THAN A FIELD, because whether a mic exists is a fact about
   * the DEVICE and the composer cannot know it. Nick, 14 Sep 2026: "talk to me
   * is on the fire tablet, not the laptop" — Electron exposes
   * `webkitSpeechRecognition` with no service behind it, so the shell decides
   * and passes nothing here when it cannot listen.
   */
  device = null,
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
  }
  // ⚠ `why` is the CAPTION, never a chip. Rendered as one it sat beside a
  // caption already saying the same thing — "DESKTOP-8LGF9RR is asleep" next to
  // "you're not at the laptop" — which is the duplication this layout keeps
  // removing, in miniature.

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

  // ⚠⚠ ONE CARD PER ROOM, NOT ONE PER FACT. This pushed a separate card for the
  // temperature and another for the lights, so a single room took two slots and
  // the row grew by TWO for every area she is considering — which is how the
  // bottom-right corner came to wrap, with "3 off" orphaned onto a line of its
  // own under "office 21°" (photographed 14 Sep 2026).
  //
  // They are two readings of ONE ROOM. Grouping them is what they already are,
  // and it is the fix that survives a third room being added — widening the box
  // only moves the wrap to whenever the house gets busier.
  (rooms?.considered || []).forEach((area) => {
    const facts = [];
    const t = temp(area?.temperature?.reading?.currentC);
    if (t) facts.push(t);
    const lights = area?.lights;
    let unreachable = 0;
    if (lights && Number.isFinite(lights.total) && lights.total > 0) {
      const on = (lights.on || []).length;
      const off = (lights.off || []).length;
      if (on > 0) facts.push(`${on} on`);
      else if (off > 0) facts.push(`${off} off`);
      unreachable = (lights.unreachable || []).length;
    }
    if (facts.length > 0) {
      items.push({ key: `room-${area.area}`, text: `${area.area} ${facts.join(' · ')}`, quiet: true });
    }
    // ⚠ STILL ITS OWN CARD, and still dashed. Off at the wall means she CANNOT
    // REACH IT, which is the third light state — folding it in beside a reading
    // she can act on would make an unreachable bulb look like a live one, and
    // the dash is the only thing saying otherwise.
    if (unreachable > 0) {
      items.push({ key: `u-${area.area}`, text: `${unreachable} at the wall`, off: true });
    }
  });

  // ── What the shelf says about itself ──────────────────────────────────────
  // ⚠ WHICH FACT IT IS, in the machine's own words where it gave them. "I
  // cannot see it", "it is asleep" and "it had nothing to offer" are three
  // different states and only the first is a fault.
  const caption = host && work && work.atDesk ? `open on ${host}`
    : work && work.deskKnown === false ? 'I can’t see your laptop'
      : offer && offer.why ? offer.why
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
        {/* ⚠ The shelf never goes empty — and a device control is something it
            CAN reach even when nothing else answered, so it stays. */}
        <div className="shelf__row">
          {device}
          <span className="shelf__none">Nothing I can reach from here.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="shelf">
      <span className="shelf__cap">{caption}</span>
      <div className="shelf__row">
        {/* ⚠ FIRST, because it is the one control here that is about HER rather
            than about the world — and because this row WRAPS, so whatever is
            last is what falls off the end. The way to speak to a surface with
            no menu must not be the item that wraps away. */}
        {device}
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
