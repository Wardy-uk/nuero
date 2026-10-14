import { dayLine, blockNow } from './model.mjs';

// Now: the day as task blocks. NEURO's open blocks, meetings and protected
// time, in clock order — not re-ranked. Labelled honestly: NEURO lists only
// OPEN blocks, so finished ones are not here.

const KIND = { block: 'Block', meeting: 'Meeting', protected: 'Protected' };

export function NowPageView({ canonical, adhd, taskBlocks, session, now = Date.now(), heldOpen = false, onToggleHeld = null, error = null }) {
  if (!taskBlocks && !canonical) {
    return <div className="v2-page"><section className="v2-card"><p className="v2-muted">{error ? `I can’t reach NEURO — ${error}.` : 'Reading the day…'}</p></section></div>;
  }
  const current = blockNow(adhd, session);
  const line = dayLine(canonical, taskBlocks, { now, currentId: current && current.blockId });
  const held = Array.isArray(canonical && canonical.dropped) ? canonical.dropped : [];
  const blocksKnown = Boolean(taskBlocks && taskBlocks.ok !== false && Array.isArray(taskBlocks.blocks));

  return (
    <div className="v2-page">
      {error && <p className="v2-stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}
      <section className="v2-card" aria-label="Today">
        <p className="v2-eyebrow">Today’s remaining open blocks, meetings and protected time</p>
        {!blocksKnown && <p className="v2-warn">I couldn’t read today’s task blocks.</p>}
        {line.items.length === 0 && blocksKnown
          ? <p className="v2-muted">Nothing left in the plan for today.</p>
          : (
            <ol className="v2-day">
              {line.items.map((i, n) => (
                <li key={n} className={`v2-day__item v2-day__item--${i.kind}${i.current ? ' is-current' : ''}`}>
                  <span className="v2-day__time">{i.start}{i.end ? `–${i.end}` : ''}</span>
                  <span className="v2-day__kind">{i.current ? 'Now' : KIND[i.kind]}</span>
                  <span className="v2-day__title">
                    {i.title}
                    {i.kind === 'block' && i.block.awaitingWriteup && <span className="v2-muted"> · awaiting write-up</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        <p className="v2-muted v2-small">
          Finished blocks aren’t listed — NEURO only reports open ones.
          {!line.agendaKnown
            ? ' I couldn’t read the diary, so meetings may be missing.'
            : !line.agendaToday ? ' The diary has nothing more today.'
              : line.agendaLimited ? ' NEURO’s diary feed lists at most four upcoming events, so later ones may be missing.' : ''}
        </p>
      </section>

      {held.length > 0 && (
        <section className="v2-card v2-card--quiet" aria-label="Held work">
          <p className="v2-eyebrow">Held</p>
          <p>{held.length} {held.length === 1 ? 'item is' : 'items are'} held{held[0] && held[0].why ? `: ${held[0].why}` : ''}.</p>
          {onToggleHeld && <button type="button" className="v2-link" aria-expanded={heldOpen} onClick={onToggleHeld}>{heldOpen ? 'Hide held work' : 'Show held work'}</button>}
          {heldOpen && <ul className="v2-list">{held.map((h, n) => <li key={n}>{h.title || h.type}{h.why ? <span className="v2-muted"> — {h.why}</span> : null}</li>)}</ul>}
        </section>
      )}
    </div>
  );
}
