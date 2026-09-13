import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './AmbientSection.css';

/**
 * "What she's noticed" — GET /api/ambient.
 *
 * ⚠ PORTED FROM iOS (13 Sep 2026), which is the direction that matters. The
 * native Now screen has rendered "Been sitting" and "Right now, physically"
 * since ambient shipped, and the desktop had NO mention of it anywhere — so the
 * surface Nick sits in front of all day was the one that could not see his body.
 *
 * All the judgement is in `backend/services/ambient.js`; this only renders. The
 * rules it enforces are worth restating because they are what make the section
 * safe to have on a screen he reads every day:
 *
 *   * NOT LOGGED IS NOT NOT DONE. `dietary_energy_consumed` last has a sample in
 *     March, so a naive read would tell him he has not eaten, every lunchtime,
 *     for five months. The service asks whether the habit is LIVE first and
 *     reports `unknown` with a reason instead.
 *   * A STOPPED SENSOR IS AN UNKNOWN, not an observation — `quiet:*` findings
 *     fold into `unknowns` server-side, which is why they are not rendered here.
 *   * NOTHING NOTICED RENDERS NOTHING. No heading, no consolation line: "all
 *     good" over a body it could not read is the claim this refuses.
 *
 * ⚠ BELOW the work, never above it, and never in the primary slot. These are
 * facts about right now rather than things to decide about — a sitting-down
 * prompt must never outrank a breaching escalation.
 *
 * ⚠ PULL ONLY. Nothing here notifies; nudge volume is the one budget allowed to
 * argue against building more.
 */
export default function AmbientSection() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const payload = await apiFetch('/api/ambient');
        if (alive) setData(payload);
      } catch {
        // ⚠ A failed read is NOT "nothing to notice" — but this is a passive
        // section under the work, and a banner here would be a second warning
        // competing with the ones that matter. It renders nothing, and the
        // unread state is already reported where it is actionable: NEURO Health.
        if (alive) setData(null);
      }
    })();
    return () => { alive = false; };
  }, []);

  const observations = (data && data.observations) || [];
  if (observations.length === 0) return null;

  return (
    <section className="ambient">
      <h3 className="ambient__h">What she&rsquo;s noticed</h3>
      <ul className="ambient__list">
        {observations.map((o, i) => (
          <li key={`${o.kind || 'obs'}-${i}`} className={`ambient__item ambient__item--${o.level || 'info'}`}>
            <span className="ambient__text">{o.text}</span>
            {o.detail && <span className="ambient__detail">{o.detail}</span>}
            {o.suggestion && <span className="ambient__suggest">{o.suggestion}</span>}
            {/* ⚠ NEVER DROPPED. Apple Health cannot separate exercise, illness,
                alcohol and a hard week, and a reading without its caveat reads
                as a diagnosis. */}
            {o.caveat && <span className="ambient__caveat">{o.caveat}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
