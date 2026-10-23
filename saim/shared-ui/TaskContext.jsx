import { useCallback, useEffect, useState } from 'react';
import './TaskContext.css';

// TaskContext — the vault material pinned to ONE task (22 Oct 2026).
//
// One component, two modes, every surface:
//   compact   Now, a prepared move, meeting prep: the pinned items only (≤3), and
//             NOTHING AT ALL when there are none — a surface is not made noisy by a
//             task that has no context yet.
//   editable  the task card: pinned + suggestions + stale + the scan's question,
//             "Add context" (search a note, link a project or an area) and Remove.
//
// It decides nothing. Every word (the reason, the badge, the stale sentence) comes
// from /api/task-context; `call(path, {method, body}) → {status, body}` is the
// shell's authenticated fetch, and `onOpen(item)` opens a note or folder.
// ⚠ A failed read SAYS so — "couldn't read" is never rendered as "no context".

const TYPE_LABEL = { note: 'Note', project: 'Project', area: 'Area' };
const enc = encodeURIComponent;

export function ContextItem({ item, onOpen = null, onRemove = null, busy = false, compact = false }) {
  // An open route exists only when the server gave one: a restricted note on a
  // limited view (kiosk, MCP, any machine) comes back with no path at all, so it
  // cannot be opened from here however the shell is wired.
  const route = item.open || null;
  const href = route && route.obsidianUrl;
  const open = route && onOpen ? () => onOpen(item) : null;
  const ex = item.excerpt || null;
  return (
    <li className={`tctx__item tctx__item--${item.type}${item.restricted ? ' tctx__item--restricted' : ''}`} data-ref={item.ref || undefined}>
      <div className="tctx__head">
        {open
          ? <button type="button" className="tctx__title" onClick={open} title={item.ref || undefined}>{item.title}</button>
          : <span className="tctx__title" title={item.ref || undefined}>{item.title}</span>}
        <span className="tctx__badge">{TYPE_LABEL[item.type] || item.type}</span>
        <span className={`tctx__badge tctx__badge--${item.automatic ? 'auto' : 'manual'}`}>{item.originLabel}</span>
      </div>
      <p className="tctx__reason">{item.provenance || item.reason}</p>
      {item.restricted && <p className="tctx__restricted">{item.restrictedSay || 'Restricted — shown as a title only on this screen.'}</p>}
      {ex && (
        <blockquote className={`tctx__excerpt${compact ? ' tctx__excerpt--compact' : ''}`}>
          {ex.heading && !compact && <span className="tctx__excerpt-head">{ex.heading}</span>}
          <span className="tctx__excerpt-text">{ex.text}</span>
          {!compact && ex.say && <span className="tctx__excerpt-why">{ex.say}</span>}
        </blockquote>
      )}
      {!ex && !compact && item.excerptGap && <p className="tctx__quiet">{item.excerptGap}</p>}
      {!ex && !compact && item.preview && <p className="tctx__preview">{item.preview}</p>}
      {!compact && Array.isArray(item.scopeItems) && item.scopeItems.length > 0 && (
        <ul className="tctx__scope">
          {item.scopeItems.map((s) => (
            <li key={s.ref}>
              {onOpen
                ? <button type="button" className="tctx__scope-link" onClick={() => onOpen({ type: 'note', ref: s.ref, title: s.title, open: { kind: 'note', path: s.ref } })}>{s.title}</button>
                : <span>{s.title}</span>}
              <span className="tctx__scope-why">{s.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {(route && item.type === 'note' && (open || href)) || onRemove ? (
        <div className="tctx__row">
          {route && item.type === 'note' && open && <button type="button" className="tctx__open" onClick={open}>Open source note</button>}
          {route && item.type === 'note' && !open && href && <a className="tctx__open" href={href}>Open source note</a>}
          {onRemove && <button type="button" className="tctx__remove" disabled={busy} onClick={() => onRemove(item)}>Remove</button>}
        </div>
      ) : null}
    </li>
  );
}

/** PURE. What the add-context search should show for the chosen type. */
export function searchResults(result, type) {
  if (!result || !result.ok) return [];
  if (type === 'note') return result.notes || [];
  return (result.scopes || []).filter((s) => s.type === type);
}

function AddContext({ taskId, call, onLinked }) {
  const [type, setType] = useState('note');
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);
  const [choice, setChoice] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const search = async (e) => {
    if (e) e.preventDefault();
    if (q.trim().length < 2) { setMsg('Type at least two characters.'); return; }
    setBusy(true); setMsg(null); setChoice(null);
    try {
      const r = await call(`/api/task-context/search?q=${enc(q.trim())}&taskId=${enc(taskId)}`);
      setResult(r.body);
      if (!r.body || !r.body.ok) setMsg((r.body && r.body.error) || 'NEURO couldn’t search the vault.');
    } catch { setMsg('NEURO didn’t answer.'); } finally { setBusy(false); }
  };

  const link = async (t, ref) => {
    setBusy(true); setMsg(null);
    try {
      const r = await call(`/api/task-context/tasks/${enc(taskId)}/links`, { method: 'POST', body: { type: t, ref } });
      if (r.status === 409 && r.body && r.body.needsChoice) { setChoice(r.body.needsChoice); return; }
      if (!r.body || !r.body.ok) { setMsg((r.body && r.body.error) || `NEURO answered ${r.status}; nothing was linked.`); return; }
      setMsg(r.body.already ? 'Already linked.' : 'Linked.');
      setChoice(null); setResult(null); setQ('');
      onLinked && onLinked();
    } catch { setMsg('NEURO didn’t answer; nothing was linked.'); } finally { setBusy(false); }
  };

  const rows = searchResults(result, type);
  return (
    <div className="tctx__add">
      <form className="tctx__add-form" onSubmit={search}>
        <select aria-label="What to link" value={type} onChange={(e) => { setType(e.target.value); setResult(null); setChoice(null); }}>
          <option value="note">A note</option>
          <option value="project">A project</option>
          <option value="area">An area</option>
        </select>
        <input aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={type === 'note' ? 'Search note titles…' : `Search ${type}s…`} />
        <button type="submit" disabled={busy}>Search</button>
      </form>
      {choice && (
        <div className="tctx__ask" role="group" aria-label="Which one">
          <p>{choice.question}</p>
          {choice.options.map((o) => <button key={o.ref} type="button" disabled={busy} onClick={() => link(o.type, o.ref)}>{o.title}<span className="tctx__scope-why">{o.ref}</span></button>)}
        </div>
      )}
      {result && result.ok && (
        rows.length ? (
          <ul className="tctx__results">
            {rows.map((r) => (
              <li key={`${r.type}|${r.ref}`}>
                <button type="button" disabled={busy || r.linked} onClick={() => link(r.type, r.ref)}>
                  {r.title}{r.restricted ? ' · restricted' : ''}{r.linked ? ' · linked' : ''}
                  <span className="tctx__scope-why">{r.folder || r.ref}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="tctx__quiet">Nothing matches “{result.query}”.</p>
      )}
      {result && result.ok && result.complete === false && <p className="tctx__quiet">The vault search stopped early — this may not be everything.</p>}
      {msg && <p className="tctx__msg" role="status">{msg}</p>}
    </div>
  );
}

export default function TaskContext({ taskId, call, onOpen = null, compact = false, editable = false, limit = 3, label = 'Context', initial = null }) {
  const [state, setState] = useState(initial ? { data: initial } : { loading: true });
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (taskId == null || !call) return;
    try {
      const r = await call(`/api/task-context/tasks/${enc(taskId)}`);
      setState(r.body && r.body.ok ? { data: r.body } : { error: (r.body && r.body.error) || `NEURO answered ${r.status}.` });
    } catch { setState({ error: 'NEURO didn’t answer.' }); }
  }, [taskId, call]);
  useEffect(() => { if (!initial) load(); }, [load, initial]);

  const act = async (path, body = {}) => {
    setBusy(true);
    try { await call(path, { method: 'POST', body }); } catch { /* the re-read shows what happened */ }
    await load();
    setBusy(false);
  };
  const remove = editable ? (item) => act(`/api/task-context/tasks/${enc(taskId)}/links/${enc(item.id)}/remove`) : null;

  if (taskId == null) return null;
  if (state.loading) return compact ? null : <section className="tctx tctx--loading" aria-label={label}><p className="tctx__quiet">Reading context…</p></section>;
  if (state.error) return <section className={`tctx${compact ? ' tctx--compact' : ''}`} aria-label={label}><h4 className="tctx__label">{label}</h4><p className="tctx__gap">Couldn’t read this task’s context — {state.error} This is not “no context”.</p></section>;

  const d = state.data;
  const pinned = d.pinned || [];
  if (compact) {
    if (!pinned.length) return null;
    const shown = pinned.slice(0, limit);
    return (
      <section className="tctx tctx--compact" aria-label={label}>
        <h4 className="tctx__label">{label}</h4>
        <ul className="tctx__list">{shown.map((it) => <ContextItem key={it.id} item={it} onOpen={onOpen} compact />)}</ul>
        {pinned.length > shown.length && <p className="tctx__quiet">{pinned.length - shown.length} more on the task.</p>}
      </section>
    );
  }

  const sugg = d.suggestions || [];
  const stale = d.stale || [];
  return (
    <section className="tctx" aria-label={label}>
      <div className="tctx__top">
        <h4 className="tctx__label">{label}</h4>
        {editable && <button type="button" className="tctx__addbtn" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? 'Close' : 'Add context'}</button>}
      </div>
      {d.question && editable && (
        <div className="tctx__ask" role="group" aria-label="SAiM asks">
          <p>{d.question.text}</p>
          {d.question.options.map((o) => <button key={o.ref} type="button" disabled={busy} onClick={() => act(`/api/task-context/tasks/${enc(taskId)}/links`, { type: o.type, ref: o.ref })}>{o.title}</button>)}
          <button type="button" className="tctx__quietbtn" disabled={busy} onClick={() => act(`/api/task-context/tasks/${enc(taskId)}/question/dismiss`)}>Neither</button>
        </div>
      )}
      {pinned.length
        ? <ul className="tctx__list">{pinned.map((it) => <ContextItem key={it.id} item={it} onOpen={onOpen} onRemove={remove} busy={busy} />)}</ul>
        : <p className="tctx__quiet">No context pinned yet.{d.automatic && d.automatic.enabled === false ? ' Automatic linking is off until you turn it on in NEURO → Brain Health — you can link context by hand.' : (d.lastScan ? '' : ' The nightly scan hasn’t run.')}</p>}
      {stale.length > 0 && (
        <details className="tctx__fold">
          <summary>{stale.length} no longer available</summary>
          <ul className="tctx__list">
            {stale.map((it) => (
              <li key={it.id} className="tctx__item tctx__item--stale">
                <span className="tctx__title">{it.title}</span>
                <p className="tctx__reason">{it.staleSay}</p>
                {editable && <button type="button" className="tctx__remove" disabled={busy} onClick={() => remove(it)}>Remove</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {sugg.length > 0 && (
        <details className="tctx__fold">
          <summary>{sugg.length} suggestion{sugg.length === 1 ? '' : 's'} — not pinned</summary>
          <ul className="tctx__list">
            {sugg.map((it) => (
              <li key={it.id} className="tctx__item tctx__item--suggested">
                <div className="tctx__head">
                  {onOpen && it.open ? <button type="button" className="tctx__title" onClick={() => onOpen(it)}>{it.title}</button> : <span className="tctx__title">{it.title}</span>}
                  <span className="tctx__badge">{TYPE_LABEL[it.type] || it.type}</span>
                </div>
                <p className="tctx__reason">{it.reason}</p>
                {editable && (
                  <div className="tctx__row">
                    <button type="button" disabled={busy} onClick={() => act(`/api/task-context/tasks/${enc(taskId)}/links/${enc(it.id)}/pin`)}>Pin it</button>
                    <button type="button" className="tctx__quietbtn" disabled={busy} onClick={() => remove(it)}>Not related</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {editable && adding && <AddContext taskId={taskId} call={call} onLinked={load} />}
    </section>
  );
}
