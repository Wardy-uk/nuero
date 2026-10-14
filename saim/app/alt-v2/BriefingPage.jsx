import { briefingView, neuroLink } from './model.mjs';

// Briefing: NEURO's stored daily briefing, verbatim — not recomputed, not
// re-summarised. Laid out for a fast desktop read. Items carry no links of
// their own yet, so the route to detail is NEURO's Briefings page.

export function BriefingPageView({ resp, now = Date.now(), neuroUrl = null, error = null }) {
  const b = briefingView(resp, { now });
  const link = neuroLink(neuroUrl, 'briefings', { kind: 'daily' });
  if (!b.known) {
    return (
      <div className="v2-page">
        <section className="v2-card">
          <p className="v2-eyebrow">Daily briefing</p>
          <p className="v2-muted">{error ? `I can’t reach NEURO — ${error}.` : `No briefing to show — ${b.why}.`}</p>
          {link && <a className="v2-link" href={link} target="_blank" rel="noopener noreferrer">Open Briefings in NEURO →</a>}
        </section>
      </div>
    );
  }
  return (
    <div className="v2-page v2-page--wide">
      <section className="v2-card" aria-label="Daily briefing">
        <p className="v2-eyebrow">Daily briefing · {b.dayLabel}{b.context && b.context.weather ? ` · ${b.context.weather}` : ''}</p>
        {!b.isToday && <p className="v2-warn">Today’s briefing hasn’t been written yet — this is {b.dayLabel}’s.</p>}
        <div className="v2-brief">
          {b.sections.map((s) => (
            <div key={s.id} className={`v2-brief__section v2-brief__section--${s.id}`}>
              <h2 className="v2-brief__head">{s.label}</h2>
              {s.items.map((i) => (
                <div key={i.key} className="v2-brief__item">
                  <p className="v2-brief__title">{i.title}</p>
                  {i.detail && <p className="v2-sub">{i.detail}</p>}
                  {Array.isArray(i.items) && i.items.length > 0 && (
                    <ul className="v2-list v2-list--tight">{i.items.map((x, n) => <li key={n}>{x}</li>)}</ul>
                  )}
                  {i.why && <p className="v2-why">{i.why}</p>}
                </div>
              ))}
            </div>
          ))}
        </div>
        {b.close && <p className="v2-brief__close">{b.close}</p>}
        {b.gaps.length > 0 && <p className="v2-warn">Couldn’t read: {b.gaps.map((g) => (typeof g === 'string' ? g : g.source || g.input || g.why)).join('; ')}.</p>}
        {link && <a className="v2-link" href={link} target="_blank" rel="noopener noreferrer">Detail in NEURO → Briefings</a>}
      </section>
    </div>
  );
}
