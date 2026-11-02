import { dayOfKey, time, DAYS_LONG, MONTHS_LONG } from '../views/Wall.jsx';
import { presenceLine, nextLine, outlookLines, weatherIcon, Presence as Faces, I, DOCK_ICONS } from '../views/WallCinema.jsx';
import { CareRows } from '../views/WallSheets.jsx';
import Section from './Section.jsx';
import { LastWalkCard } from './LastWalk.jsx';

/**
 * The family wall's features on the phone (1 Nov 2026), in the wall's own look
 * (Nick: "like the wall") — the landscape behind, dark glass cards, amber.
 *
 * Every tap opens THE WALL'S OWN SHEET (Home mounts the cinema `Sheet`
 * full-screen), so the wall and the phone share one editor per thing.
 *
 * Data is the wall's payload (`/api/v/wall`), read beside `/home`:
 *   • a block the account has no scope for is ABSENT → not drawn;
 *   • a block that could not be read is `null` with a gap → says so, never empty;
 *   • the server redacts; nothing here filters.
 * `board` is undefined while the first read is in flight, null if it failed.
 */

const PART = (h) => (h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');

/** The top of the phone: date, who's home, what's next, faces, and the weather. */
export function HouseHero({ board, label, now, open }) {
  const date = `${DAYS_LONG[now.getDay()]} ${now.getDate()} ${MONTHS_LONG[now.getMonth()]}`;
  const can = (s) => !!board && (board.scopes || []).includes(s);
  const greeting = `Good ${PART(now.getHours())}${label ? `, ${label}` : ''}`;
  const headline = can('house') && board.who !== undefined ? presenceLine(board.who) : greeting;
  const today = can('calendar') && Array.isArray(board.week) ? board.week[0] : null;
  const sub = today ? nextLine(today, now) : (headline === greeting ? '' : greeting);
  return (
    <header className="vh__hero">
      <p className="vh__date">{date}</p>
      <span className="vh__rule" aria-hidden="true" />
      <h1 className="vh__headline">{headline}</h1>
      {sub && <p className="vh__sub">{sub}</p>}
      {can('house') && board.who !== undefined && (
        <div className="vh__faces"><Faces who={board.who} onPerson={(p) => open({ kind: 'member', person: p })} /></div>
      )}
      {can('house') && <Weather station={board.station} outlook={board.outlook} weekAhead={board.weekAhead} open={open} />}
    </header>
  );
}

/** One glass strip: icon, temperature, today's outlook, and the week ahead. */
function Weather({ station, outlook, weekAhead, open }) {
  if (!station && outlook === undefined) return null;
  const o = outlookLines(outlook);
  const read = station && station.known !== false && typeof station.tempC === 'number';
  const ic = read ? weatherIcon(station.condition) : null;
  return (
    <div className="vh__weather">
      <button className="vh__wnow" onClick={() => open({ kind: 'weather' })} aria-label="Outside — details">
        {ic && <span className="vh__wicon" aria-hidden="true">{I[ic]}</span>}
        <span className="vh__wtemp">{read ? `${Math.round(station.tempC * 10) / 10}°` : '—'}</span>
        <span className="vh__wtext">
          <span className="vh__wlabel">{read ? (station.conditionLabel || 'Outside') : (station && station.why) || 'Station not read'}</span>
          {o && (o.gap
            ? <span className="vh__wline vh__wline--gap">{o.gap}</span>
            : <span className={`vh__wline${o.rainState === 'raining' || o.rainState === 'arriving' ? ' vh__wline--wet' : ''}`}>{[o.rain, o.temps].filter(Boolean).join(' · ')}</span>)}
        </span>
      </button>
      {weekAhead !== undefined && <button className="vh__weekbtn" onClick={() => open({ kind: 'forecast' })}>Week ahead ›</button>}
    </div>
  );
}

const TEA_ICON = <svg viewBox="0 0 24 24"><path d="M4 10h13v3a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6z" /><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H16" /><path d="M8 3.5c0 1.5 1.5 1.5 1.5 3M12 3.5c0 1.5 1.5 1.5 1.5 3" /></svg>;
const CD_ICON = <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /><path d="M12 13v3l2 1" /></svg>;

/** Tea, shopping, notes and the house controls as icon tiles; then the countdowns. */
export default function HouseBoard({ board, boardErr, open }) {
  if (board === undefined) return null;
  if (board === null) return <Section title="Around the house" gap={boardErr || 'The house board would not load.'} />;
  const can = (s) => (board.scopes || []).includes(s);
  const tiles = [];
  if (can('tasks') && board.tea !== undefined) {
    tiles.push(board.tea === null
      ? <Tile key="tea" icon={TEA_ICON} label="Tea tonight" value="Can’t read" gap />
      : <Tile key="tea" icon={TEA_ICON} label="Tea tonight" value={board.tea.today || 'Not set'} onClick={() => open({ kind: 'tea' })} />);
  }
  if (can('kitchen') && board.shopping !== undefined) {
    const n = board.shopping && Array.isArray(board.shopping.toBuy) ? board.shopping.toBuy.length : null;
    tiles.push(board.shopping === null
      ? <Tile key="shop" icon={DOCK_ICONS.shop} label="Shopping" value="Can’t read" gap />
      : <Tile key="shop" icon={DOCK_ICONS.shop} label="Shopping" value={n ? `${n} to buy` : 'Nothing to buy'} badge={n || null} onClick={() => open({ kind: 'shop' })} />);
  }
  if (can('tasks') && board.notes !== undefined) {
    tiles.push(board.notes === null
      ? <Tile key="notes" icon={DOCK_ICONS.notes} label="Notes" value="Can’t read" gap />
      : <Tile key="notes" icon={DOCK_ICONS.notes} label="Notes" value={board.notes.length ? board.notes[0].text : 'None'} badge={board.notes.length || null} onClick={() => open({ kind: 'notes' })} />);
  }
  if (can('home-control')) {
    tiles.push(<Tile key="home" icon={DOCK_ICONS.home} label="Home" value="Lights & heating" onClick={() => open({ kind: 'home' })} />);
  }
  const countdowns = can('calendar') ? board.countdowns : undefined;
  // Nick's last walk (scope `walks`): absent = not mounted at all.
  const walkGap = ((board.gaps || []).find((g) => g.block === 'lastWalk') || {}).why || null;
  return (
    <>
      {tiles.length > 0 && <div className="vh__tiles">{tiles}</div>}
      {can('walks') && board.lastWalk !== undefined && (
        <LastWalkCard walk={board.lastWalk} gap={walkGap} onOpen={() => open({ kind: 'lastWalk' })} />
      )}
      {countdowns === null && <p className="section__gap" role="status">I couldn’t read the countdowns.</p>}
      {Array.isArray(countdowns) && countdowns.length > 0 && (
        <ul className="vh__countdowns" aria-label="Countdowns">
          {countdowns.map((c) => (
            <li key={c.key} className={`vh__cd${c.days === 0 ? ' vh__cd--today' : ''}`}>
              <span className="vh__cdicon" aria-hidden="true">{CD_ICON}</span>
              <span className="vh__cdtitle">{c.title}</span>
              <span className="vh__cdsay">{c.say}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Tile({ icon, label, value, onClick, gap = false, badge = null }) {
  const body = (
    <>
      <span className="vh__ticon" aria-hidden="true">{icon}</span>
      <span className="vh__tlabel">{label}</span>
      <span className={`vh__tvalue${gap ? ' vh__tvalue--gap' : ''}`}>{value}</span>
      {badge != null && <span className="vh__tbadge">{badge}</span>}
    </>
  );
  return onClick
    ? <button className="vh__tile" onClick={onClick}>{body}</button>
    : <div className="vh__tile vh__tile--static">{body}</div>;
}

/** Household jobs in full: every job (edit, reschedule, done list, reopen) and Ember's care. */
export function JobsMore({ board, open }) {
  if (!board || board.tasks === undefined) return null;
  const can = (s) => (board.scopes || []).includes(s);
  const n = board.tasks && Array.isArray(board.tasks.tasks) ? board.tasks.tasks.length : 0;
  const done = Array.isArray(board.doneTasks) ? board.doneTasks.length : 0;
  return (
    <div className="vh__jobsmore">
      <button className="btn" onClick={() => open({ kind: 'jobs' })}>
        {`All jobs${n ? ` (${n})` : ''}${done ? ` · ${done} done recently` : ''}`}
      </button>
      {can('house') && board.care !== undefined && <div className="vh__care"><CareRows care={board.care} compact /></div>}
    </div>
  );
}

/** The next seven days. A day opens in full; an event opens to view or edit. */
export function Week({ board, open }) {
  if (!board || !(board.scopes || []).includes('calendar') || board.week === undefined) return null;
  const gap = (board.gaps || []).find((g) => g.block === 'week')?.why || null;
  const fam = board.familyCalendar || { canEdit: false };
  const week = Array.isArray(board.week) ? board.week.slice(0, 7) : null;
  const wa = board.weekAhead && board.weekAhead.known ? board.weekAhead.days : [];
  return (
    <Section title="This week" gap={gap}
             action={fam.canEdit ? <button className="btn btn--quiet vh__add" onClick={() => open({ kind: 'addEvent', date: board.today })}>+ Event</button> : null}>
      {week && (
        <ul className="vh__week">
          {week.map((d, i) => {
            const { dow, day, month } = dayOfKey(d.date);
            const events = d.events || [];
            const fc = wa.find((x) => x.date === d.date);
            const ic = fc ? weatherIcon(fc.condition) : null;
            return (
              <li key={d.date} className={`vh__day${i === 0 ? ' vh__day--today' : ''}`}>
                <button className="vh__dayhead" onClick={() => open({ kind: 'day', day: d })}>
                  <span className="vh__dayname">{i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAYS_LONG[dow]}</span>
                  <span className="vh__daydate">{`${day} ${MONTHS_LONG[month].slice(0, 3)}`}</span>
                  {fc && (
                    <span className="vh__dayfc" title={fc.label || ''}>
                      {ic && <span className="vh__dayicon" aria-hidden="true">{I[ic]}</span>}
                      {fc.highC != null ? `${fc.highC}°` : ''}
                    </span>
                  )}
                </button>
                {d.off && <span className="vh__work vh__work--off">Nick off</span>}
                {d.work && <span className="vh__work">{d.work.allDay ? 'Nick at work' : `Nick at work · ${time(d.work.start)}–${time(d.work.end)}`}</span>}
                {events.length === 0 && !d.off && !d.work && <span className="vh__quiet">Nothing planned</span>}
                {events.map((e, j) => (
                  <button key={e.id || j} className="vh__event" onClick={() => open({ kind: 'event', event: e, date: d.date })}>
                    <span className="vh__etime">{e.allDay ? 'All day' : time(e.start)}</span>
                    <span className="vh__ewhat">{e.title}</span>
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
