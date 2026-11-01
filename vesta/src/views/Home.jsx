import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import Tasks from '../components/Tasks.jsx';
import Calendar from '../components/Calendar.jsx';
import Kitchen from '../components/Kitchen.jsx';
import Meals from '../components/Meals.jsx';
import Presence from '../components/Presence.jsx';
import Walk from '../components/Walk.jsx';
import Energy from '../components/Energy.jsx';
import HouseBoard, { HouseHero, JobsMore, Week } from '../components/HouseBoard.jsx';
import { Sheet, Photo, Sky, skyPhase, photoSlot } from './WallCinema.jsx';
import { SheetBoundary } from './WallSheets.jsx';
import './WallCinema.css';

const KITCHEN_SLUG = 'kitchen';

/**
 * One GET renders the whole screen.
 *
 * It is a fridge-door screen, on a phone, over mobile data. Four round trips to
 * draw one page is three too many, so `/home` returns everything this account
 * may see and every block reports its own failure — a kitchen file that will not
 * parse must not blank the diary.
 *
 * ⚠ SCOPES DECIDE WHAT IS MOUNTED AT ALL, not what is hidden with CSS. A block
 * she has no right to see is ABSENT from the response and absent from the page.
 * An empty calendar and no permission to see the calendar are different facts
 * and must not share a rendering.
 */
export default function Home({ onSignedOut, onWall }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // The family wall's payload, for the wall's features on the phone (1 Nov
  // 2026): undefined = not read yet, null = could not be read (boardErr says why).
  const [board, setBoard] = useState(undefined);
  const [boardErr, setBoardErr] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [dirty, setDirty] = useState(false);
  // The minute, for the date, the greeting and the time-of-day photograph.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60 * 1000); return () => clearInterval(t); }, []);

  const token = api.getToken();

  // Both reads at once; a failed board never costs the rest of Home.
  const refresh = useCallback(async () => {
    const boardRead = api.wall(token, { timeoutMs: 20000 })
      .then((b) => { setBoard(b); setBoardErr(null); })
      .catch((err) => {
        if (err.expired) return;
        setBoardErr(err.message);
        setBoard((prev) => (prev === undefined ? null : prev));
      });
    try {
      setData(await api.home(token));
      setError(null);
    } catch (err) {
      // A dead session is not an error to puzzle over — it is a sign-in.
      if (err.expired) return onSignedOut();
      setError(err.message);
    } finally {
      setLoading(false);
    }
    await boardRead;
  }, [token, onSignedOut]);

  useEffect(() => { refresh(); }, [refresh]);

  // The wall's landscape behind the phone (1 Nov 2026: "like the wall"),
  // chosen by the time of day and the station's weather, exactly as the wall chooses.
  const sun = board && board.sun;
  const backdrop = (
    <div className={`cine cine--${skyPhase(now, sun)} vh__backdrop`} aria-hidden="true">
      <Sky phase={skyPhase(now, sun)} />
      <Photo slot={photoSlot(now, sun)} condition={board && board.station ? board.station.condition : null} />
    </div>
  );

  if (loading) return <div className="home home--cine">{backdrop}<p className="home__loading">Getting things…</p></div>;

  if (error && !data) {
    return (
      <div className="home__error home--cine" role="alert">
        {backdrop}
        <p>{error}</p>
        <button className="btn" onClick={refresh}>Try again</button>
      </div>
    );
  }

  const scopes = data.scopes || [];
  const can = s => scopes.includes(s);
  const gapFor = block => (data.gaps || []).find(g => g.block === block)?.why || null;

  // ⚠ A block is a GAP when the server could not read it — the response carries
  // `null` and a reason. It is EMPTY when it read fine and held nothing. The
  // components keep those apart; this only has to pass the reason through.
  const cataloguesGap = gapFor('catalogues');
  const kitchenGap = gapFor('kitchen') || cataloguesGap;

  // Both of the things only Nick can do. Until his partner has an account with
  // the kitchen scope AND a catalogue called "kitchen" marked shared, this
  // section is correct and empty — so it says which is missing rather than
  // rendering a blank panel that looks broken.
  const kitchenMissing = can('kitchen') && !kitchenGap && !data.kitchenSections;

  async function addTask(text, assignees, dueDate) {
    await api.addTask(token, text, assignees, dueDate);
    await refresh();
  }

  async function updateTask(id, patch) {
    await api.updateTask(token, id, patch);
    await refresh();
  }
  /**
   * `quiet` skips the refresh so a confirmed photo does not re-fetch the whole
   * home screen once per item — the proposal loop refreshes once when it is
   * finished. The result is returned either way, because the caller needs to
   * know whether something was already in.
   */
  async function addItem(section, name, { quiet = false } = {}) {
    const result = await api.addItem(token, KITCHEN_SLUG, section, name);
    if (!quiet) await refresh();
    return result;
  }

  async function scanPhoto(image, mediaType) {
    return api.scanPhoto(token, KITCHEN_SLUG, image, mediaType);
  }
  async function useItem(section, name) {
    await api.useItem(token, KITCHEN_SLUG, section, name);
    await refresh();
  }

  // The wall's sheets change things through this — the SAME shape the wall
  // passes them. NEURO answers, then Home is re-read; nothing is changed here first.
  const after = async (p) => { const res = await p; await refresh(); return res; };
  const act = {
    task: (id, patch) => after(api.updateTask(token, id, patch)),
    addTask: ({ text, dueDate, assignees, notes, priority }) => after(api.addTask(token, text, assignees, dueDate, {
      ...(notes ? { notes } : {}), ...(priority ? { priority } : {}),
    })),
    event: {
      add: (body) => after(api.addFamilyEvent(token, body)),
      update: (id, body) => after(api.updateFamilyEvent(token, id, body)),
      remove: (id) => after(api.deleteFamilyEvent(token, id)),
    },
    tea: (date, text) => after(api.setTea(token, date, text)),
    note: {
      add: (text) => after(api.addNote(token, text)),
      clear: (id) => after(api.clearNote(token, id)),
    },
    countdown: (body) => after(api.setCountdown(token, body)),
    shopping: {
      add: (name) => after(api.shoppingAdd(token, name)),
      bought: (name, undo) => after(api.shoppingBought(token, name, undo)),
    },
    home: {
      get: () => api.getHomeControl(token),
      control: (entity, action) => api.homeControl(token, entity, action),
    },
  };
  const closeSheet = () => { setDirty(false); setSheet(null); };

  return (
    <div className="home home--cine">
      {backdrop}
      <HouseHero board={board} label={data.label} now={now} open={setSheet} />

      {/* A refresh that failed while we still have the last good screen: say so
          rather than either blanking it or pretending it is current. */}
      {error && <p className="home__stale" role="status">{error} Showing what I last had.</p>}

      {/* First when he is out on a walk: if he is overdue it is the most important thing on the page. */}
      {can('hike') && <Walk hike={data.hike} gap={gapFor('hike')} token={token} />}

      {/* Tea, shopping, notes, the house controls, countdowns — the wall's dock. */}
      <HouseBoard board={board} boardErr={boardErr} open={setSheet} />

      <Tasks tasks={data.tasks} gap={gapFor('tasks')} people={data.people || []} onAdd={addTask} onUpdate={updateTask} />
      <JobsMore board={board} open={setSheet} />

      {/* Above the calendar: "where is he right now" is the question she is most
          likely to have opened this for, and it is one line. Gated on the scope
          so the block is ABSENT without it, never rendered-then-hidden — the
          client enforces nothing and must never start. */}
      {can('presence') && <Presence presence={data.presence} />}

      {can('energy') && <Energy energy={data.energy} gap={gapFor('energy')} />}

      {/* The week from the wall's payload; today's diary from /home only when
          the board could not be read, so the same day is never listed twice. */}
      {board && Array.isArray(board.week)
        ? <Week board={board} open={setSheet} />
        : can('calendar') && <Calendar events={data.calendar} gap={gapFor('calendar')} todayKey={data.calendarDate} />}

      {can('kitchen') && (
        kitchenMissing ? (
          <section className="section">
            <header className="section__head"><h2 className="section__title">The kitchen</h2></header>
            <p className="section__empty">
              There&rsquo;s no kitchen list yet. Nick needs to make one and share it &mdash;
              until then there&rsquo;s nothing here for me to show.
            </p>
          </section>
        ) : (
          <>
            <Kitchen
              sections={data.kitchenSections}
              items={data.kitchen}
              gap={kitchenGap}
              photo={data.photo === true}
              onAdd={addItem}
              onUse={useItem}
              onScan={scanPhoto}
              onRefresh={refresh}
            />
            <Meals meals={data.meals} />
          </>
        )
      )}

      <footer className="home__foot">
        <span className="home__acct">{data.label}</span>
        <button className="btn btn--quiet" onClick={onSignedOut}>Sign out</button>
        <button className="btn btn--quiet" onClick={refresh}>Refresh</button>
        {onWall && <button className="btn btn--quiet" onClick={onWall}>Wall view</button>}
        <span className="home__build">{api.BUILD_LABEL}</span>
      </footer>

      {/* The wall's sheet, full-screen on the phone. `.cine` carries its colours. */}
      {sheet && board && (
        <div className="cine cine--sheethost">
          <SheetBoundary key={sheet.kind} onFail={closeSheet}>
            <Sheet sheet={sheet} data={board} act={act} setSheet={setSheet} dirty={dirty} setDirty={setDirty}
                   onClose={closeSheet} onOpenWeek={null} />
          </SheetBoundary>
        </div>
      )}
    </div>
  );
}
