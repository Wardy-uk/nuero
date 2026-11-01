import { dayOfKey, time, DAYS_LONG, MONTHS_LONG } from '../views/Wall.jsx';
import { presenceLine, outlookLines } from '../views/WallCinema.jsx';
import { CareRows } from '../views/WallSheets.jsx';
import Section from './Section.jsx';

/**
 * The family wall's features on the phone (1 Nov 2026).
 *
 * Nick: "add the features there onto the main vesta app". The phone shows each
 * one as a compact block, and a tap opens THE WALL'S OWN SHEET (Home mounts the
 * same `Sheet` the cinema wall uses, full-screen). So shopping, notes, tea, the
 * house controls, job editing and family events have one editor each, and the
 * wall and the phone cannot come to disagree about how a thing is changed.
 *
 * Data is the wall's payload (`/api/v/wall`), read beside `/home`, so every
 * rule the wall keeps is kept here unchanged:
 *   • a block the account has no scope for is ABSENT from the payload → not drawn;
 *   • a block that could not be read is `null` with a gap → says so, never empty;
 *   • the server redacts; nothing here filters.
 *
 * `board` is undefined while the first read is in flight, and null if it failed
 * (`boardErr` says why) — the rest of Home still works without it.
 */
export default function HouseBoard({ board, boardErr, open }) {
  if (board === undefined) return null;
  if (board === null) {
    return (
      <Section title="Around the house" gap={boardErr || 'The house board would not load.'} />
    );
  }
  const can = (s) => (board.scopes || []).includes(s);
  const gapFor = (b) => (board.gaps || []).find((g) => g.block === b)?.why || null;

  return (
    <>
      <AtHome board={board} can={can} open={open} />
      {can('house') && <Outside station={board.station} outlook={board.outlook} open={open} />}
      {can('house') && <WhoIsIn who={board.who} open={open} />}
      <Jobs board={board} can={can} gap={gapFor('tasks')} open={open} />
      {can('calendar') && <Week board={board} gap={gapFor('week')} open={open} />}
    </>
  );
}

/** Tea, notes, shopping, the house controls and countdowns: one row of tiles. */
function AtHome({ board, can, open }) {
  const tiles = [];
  if (can('tasks') && board.tea !== undefined) {
    tiles.push(board.tea === null
      ? <Tile key="tea" label="Tea tonight" value="Can’t read" gap />
      : <Tile key="tea" label="Tea tonight" value={board.tea.today || 'Not set'} onClick={() => open({ kind: 'tea' })} />);
  }
  if (can('kitchen') && board.shopping !== undefined) {
    const n = board.shopping && Array.isArray(board.shopping.toBuy) ? board.shopping.toBuy.length : null;
    tiles.push(board.shopping === null
      ? <Tile key="shop" label="Shopping" value="Can’t read" gap />
      : <Tile key="shop" label="Shopping" value={n ? `${n} to buy` : 'Nothing to buy'} onClick={() => open({ kind: 'shop' })} />);
  }
  if (can('tasks') && board.notes !== undefined) {
    tiles.push(board.notes === null
      ? <Tile key="notes" label="Notes" value="Can’t read" gap />
      : <Tile key="notes" label="Notes" value={board.notes.length ? `${board.notes.length} on the board` : 'None'} onClick={() => open({ kind: 'notes' })} />);
  }
  if (can('home-control')) {
    tiles.push(<Tile key="home" label="Home" value="Lights & heating" onClick={() => open({ kind: 'home' })} />);
  }
  const countdowns = can('calendar') ? board.countdowns : undefined;
  if (!tiles.length && countdowns === undefined) return null;
  return (
    <section className="section">
      <header className="section__head"><h2 className="section__title">At home</h2></header>
      {tiles.length > 0 && <div className="hb__tiles">{tiles}</div>}
      {countdowns === null && <p className="section__gap" role="status">I couldn’t read the countdowns.</p>}
      {Array.isArray(countdowns) && countdowns.length > 0 && (
        <ul className="hb__countdowns">
          {countdowns.map((c) => (
            <li key={c.key} className={`hb__cd${c.days === 0 ? ' hb__cd--today' : ''}`}>
              <span className="hb__cdtitle">{c.title}</span>
              <span className="hb__cdsay">{c.say}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Tile({ label, value, onClick, gap = false }) {
  const body = (
    <>
      <span className="hb__tilelabel">{label}</span>
      <span className={`hb__tilevalue${gap ? ' hb__tilevalue--gap' : ''}`}>{value}</span>
    </>
  );
  return onClick
    ? <button className="hb__tile" onClick={onClick}>{body}</button>
    : <div className="hb__tile hb__tile--static">{body}</div>;
}

/** Outside: the station's reading and the day's outlook. Tap for the detail. */
function Outside({ station, outlook, open }) {
  if (!station && outlook === undefined) return null;
  const o = outlookLines(outlook);
  const read = station && station.known !== false && typeof station.tempC === 'number';
  return (
    <Section title="Outside" action={read ? <button className="btn btn--quiet" onClick={() => open({ kind: 'weather' })}>Detail</button> : null}>
      {station && station.known === false && <p className="section__empty">{station.why || 'The weather station can’t be read just now.'}</p>}
      {read && (
        <button className="hb__outside" onClick={() => open({ kind: 'weather' })}>
          <span className="hb__temp">{`${Math.round(station.tempC * 10) / 10}°`}</span>
          <span className="hb__cond">
            {station.conditionLabel || ''}
            {typeof station.humidityPct === 'number' ? `${station.conditionLabel ? ' · ' : ''}${Math.round(station.humidityPct)}% humidity` : ''}
          </span>
        </button>
      )}
      {o && o.gap && <p className="section__empty">{o.gap}</p>}
      {o && !o.gap && (o.rain || o.temps) && (
        <p className="hb__outlook">{[o.rain, o.temps].filter(Boolean).join(' · ')}</p>
      )}
    </Section>
  );
}

/** Who is in: the wall's presence line, and each person opens their jobs. */
function WhoIsIn({ who, open }) {
  if (who === undefined) return null;
  const people = who && who.known ? (who.people || []) : [];
  return (
    <Section title="Who’s in">
      <p className="hb__presence">{presenceLine(who)}</p>
      {people.length > 0 && (
        <div className="hb__people">
          {people.map((p) => (
            <button key={p.id || p.name} className={`hb__person hb__person--${p.state || 'unknown'}`} onClick={() => open({ kind: 'member', person: p })}>
              <span className="hb__dot" aria-hidden="true" />
              {p.name}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

/** Household jobs in full: every job (edit, reschedule, done list, reopen) and Ember's care. */
function Jobs({ board, can, gap, open }) {
  if (board.tasks === undefined) return null;
  const n = board.tasks && Array.isArray(board.tasks.tasks) ? board.tasks.tasks.length : 0;
  const done = Array.isArray(board.doneTasks) ? board.doneTasks.length : 0;
  return (
    <Section title="Household jobs" gap={gap}>
      <div className="hb__jobbtns">
        <button className="btn" onClick={() => open({ kind: 'jobs' })}>
          {`All jobs${n ? ` (${n})` : ''}${done ? ` · ${done} done recently` : ''}`}
        </button>
        <button className="btn" onClick={() => open({ kind: 'add' })}>+ Add a job</button>
      </div>
      {can('house') && board.care !== undefined && (
        <div className="hb__care"><CareRows care={board.care} compact /></div>
      )}
    </Section>
  );
}

/** The next seven days. A day opens in full; an event opens to view or edit. */
function Week({ board, gap, open }) {
  const fam = board.familyCalendar || { canEdit: false };
  const week = Array.isArray(board.week) ? board.week.slice(0, 7) : null;
  return (
    <Section title="This week" gap={gap}
             action={fam.canEdit ? <button className="btn btn--quiet" onClick={() => open({ kind: 'addEvent', date: board.today })}>+ Event</button> : null}>
      {week && (
        <ul className="hb__week">
          {week.map((d, i) => {
            const { dow, day, month } = dayOfKey(d.date);
            const events = d.events || [];
            return (
              <li key={d.date} className="hb__day">
                <button className="hb__dayhead" onClick={() => open({ kind: 'day', day: d })}>
                  {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${DAYS_LONG[dow]} ${day} ${MONTHS_LONG[month].slice(0, 3)}`}
                </button>
                {d.off && <span className="hb__work hb__work--off">Nick off</span>}
                {d.work && <span className="hb__work">{d.work.allDay ? 'Nick at work' : `Nick at work · ${time(d.work.start)}–${time(d.work.end)}`}</span>}
                {events.length === 0 && !d.off && !d.work && <span className="hb__quiet">Nothing planned</span>}
                {events.map((e, j) => (
                  <button key={e.id || j} className="hb__event" onClick={() => open({ kind: 'event', event: e, date: d.date })}>
                    <span className="hb__etime">{e.allDay ? 'All day' : time(e.start)}</span>
                    <span className="hb__ewhat">{e.title}</span>
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
