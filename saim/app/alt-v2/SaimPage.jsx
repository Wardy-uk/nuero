import { useState } from 'react';
import { saimView, tools, deskStateText, deskStateBusy } from './model.mjs';

// The SAiM page: the live desktop companion. In priority order — the task
// block, the immediate action, the next transition (only when it changes what
// to do now), a few tools (only for a named step), and a compact Ask/Capture.
// Every word about the work is NEURO's.

function Lifecycle({ actions, onAct, busy }) {
  if (!actions || !actions.length) return null;
  return (
    <div className="v2-actions">
      {actions.map((u) => (
        <button
          key={`${u.intent.kind}:${u.intent.action || ''}:${u.say}`}
          type="button"
          className="v2-pill"
          disabled={!onAct || busy}
          onClick={() => onAct && onAct(u)}
        >{u.say}</button>
      ))}
    </div>
  );
}

function Tool({ app, onDeskOpen, deskStates, primary = false }) {
  const st = deskStates[app.id];
  if (!onDeskOpen) return <span className="v2-tool v2-tool--off">{app.label}</span>;
  return (
    <span className="v2-tool">
      <button
        type="button"
        className={primary ? 'v2-tool__primary' : 'v2-tool__btn'}
        disabled={deskStateBusy(st)}
        onClick={() => onDeskOpen(app.id)}
      >{primary ? `Open ${app.label}` : app.label}</button>
      {st && <span className={`v2-desk v2-desk--${st}`}>{deskStateText(st)}</span>}
    </span>
  );
}

/** One short field: the smallest physical next step. Optional to fill in. */
function StepForm({ label, placeholder, onSubmit, disabled, allowEmpty = false }) {
  const [text, setText] = useState('');
  return (
    <form
      className="v2-stepform"
      onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t || allowEmpty) { onSubmit(t); setText(''); } }}
    >
      <input
        className="v2-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        maxLength={200}
        aria-label={placeholder}
      />
      <button type="submit" className="v2-pill v2-pill--strong" disabled={disabled || (!allowEmpty && !text.trim())}>{label}</button>
    </form>
  );
}

const STATE_WORD ={ active: 'Active', upcoming: 'Up next', interrupted: 'Interrupted', complete: 'Complete' };

export function SaimPageView({
  canonical, adhd, taskBlocks, session, now = Date.now(),
  focus = null, onAct = null, onDeskOpen = null, deskStates = {}, busy = false,
  onStartBlock = null, onNameStep = null, dock = null, error = null,
}) {
  if (!canonical && !adhd) {
    return (
      <div className="v2-page">
        <section className="v2-card"><p className="v2-card__lead v2-muted">{error ? `I can’t reach NEURO — ${error}.` : 'Reading the day…'}</p>{dock}</section>
      </div>
    );
  }
  const v = saimView({ canonical, adhd, taskBlocks, session, now });
  const t = tools(canonical, v);
  const b = v.block;
  const s = session && session.session;
  const sessionLive = Boolean(s && !['done', 'abandoned'].includes(s.status));
  // Start the block's named task as a focus session — only for a block that is
  // running or about to, only when one task is named, and only when nothing is
  // already running (switching sessions is NEURO's question, not a button here).
  const canStart = Boolean(onStartBlock && b && b.task && !sessionLive && (b.state === 'active' || b.state === 'upcoming'));

  // A deep link names a canonical record or block; say plainly if it has moved on.
  let focusNote = null;
  if (focus && focus.blockId && (!b || b.blockId !== focus.blockId)) focusNote = 'That block isn’t the current one any more.';
  if (focus && focus.recordId) {
    const here = (v.item && v.item.recordId === focus.recordId)
      || (v.transitionActions || []).some((u) => u.intent.recordId === focus.recordId)
      || (v.actions || []).some((u) => u.intent.recordId === focus.recordId);
    if (!here) focusNote = 'That item isn’t current any more — NEURO has moved on.';
  }

  return (
    <div className="v2-page">
      {error && <p className="v2-stale" role="status">Couldn’t refresh — {error}. Showing the last read.</p>}
      {focusNote && <p className="v2-note" role="status">{focusNote}</p>}

      <section className={`v2-card${focus && focus.blockId && b && b.blockId === focus.blockId ? ' is-focus' : ''}`} aria-label="The current task block">
        {b ? (
          <>
            <p className="v2-eyebrow">
              <span className={`v2-state v2-state--${b.state}`}>{STATE_WORD[b.state]}</span>
              {b.startTime && b.endTime ? <span> · {b.startTime}–{b.endTime}</span> : null}
              {b.state === 'upcoming' && b.startsInMinutes ? <span> · in {b.startsInMinutes} min</span> : null}
            </p>
            {b.task
              ? <p className="v2-card__lead">{b.task.text}</p>
              : <p className="v2-card__lead v2-card__lead--small">{v.uncertain}</p>}
            {!b.task && b.tasks.length > 1 && (
              <ul className="v2-list">{b.tasks.map((x) => <li key={x.taskId}>{x.text}</li>)}</ul>
            )}
          </>
        ) : (
          <>
            <p className="v2-eyebrow">
              {v.protectedTime
                ? <><span className="v2-state">Protected</span> · {v.protectedTime.start}–{v.protectedTime.end}</>
                : v.blind ? 'Can’t see your work' : v.offDuty ? 'Off duty' : 'No block running'}
            </p>
            <p className={`v2-card__lead${v.item ? '' : ' v2-card__lead--small'}`}>{v.item ? v.item.title : v.uncertain}</p>
            {v.item && v.item.sub && <p className="v2-sub">{v.item.sub}</p>}
          </>
        )}
        {b && v.item && <p className="v2-sub"><span className="v2-label">Also</span>{v.item.title}</p>}
        {v.item && v.item.reason && <p className="v2-why">{v.item.reason}</p>}

        {v.step && <p className="v2-step"><span className="v2-label">Next</span>{v.step}</p>}
        {canStart && (
          <StepForm
            label={b.state === 'active' ? 'Start' : 'Start early'}
            placeholder="First step (optional)"
            allowEmpty
            disabled={busy}
            onSubmit={(step) => onStartBlock(b.task, step)}
          />
        )}
        {sessionLive && !v.step && onNameStep && (
          <StepForm label="Set" placeholder="Name the smallest next step" disabled={busy} onSubmit={onNameStep} />
        )}
        <Lifecycle actions={v.actions} onAct={onAct} busy={busy} />

        {(t.recommended || t.already || t.others.length > 0) && (
          <div className="v2-tools" aria-label="Tools for this step">
            {t.recommended && (
              <div className="v2-tools__best">
                <span className="v2-label">Best place</span>
                <Tool app={t.recommended} onDeskOpen={onDeskOpen} deskStates={deskStates} primary />
              </div>
            )}
            {t.already && <p className="v2-muted v2-small">{t.already.label} is already open — carry on there.</p>}
            {t.others.length > 0 && (
              <div className="v2-tools__row">{t.others.map((a) => <Tool key={a.id} app={a} onDeskOpen={onDeskOpen} deskStates={deskStates} />)}</div>
            )}
            {!onDeskOpen && <p className="v2-muted v2-small">This screen can’t reach the laptop, so nothing here can open.</p>}
          </div>
        )}

        {v.transition && (
          <div className={`v2-transition${focus && focus.recordId && (v.transitionActions || []).some((u) => u.intent.recordId === focus.recordId) ? ' is-focus' : ''}`}>
            <p><span className="v2-label">Then</span>{v.transition.text}{v.transition.question ? <span className="v2-muted"> {v.transition.question}</span> : null}</p>
            <Lifecycle actions={v.transitionActions} onAct={onAct} busy={busy} />
          </div>
        )}

        <div className="v2-dock">{dock}</div>
      </section>
    </div>
  );
}
