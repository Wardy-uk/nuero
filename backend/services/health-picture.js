'use strict';

/**
 * My Health — the whole picture, across every health source NEURO holds.
 *
 * Apple Health (the Watch, plus the HiLo bracelet's blood pressure, which reaches
 * NEURO through Apple Health), the JC Ring's own table, medical records and the
 * exertion model are each rendered on a page of their own. Nothing put them side
 * by side, so the facts that only mean something together — blood pressure beside
 * weight, VO2 max (which is PER KILOGRAM) beside weight, today's recovery beside
 * yesterday's load — were never said anywhere.
 *
 * Split like pi-health: `compose()` is PURE (inputs → picture, no DB, no clock
 * beyond the `today` key it is given) and `read()` gathers. Every rule states its
 * numbers, its source and its basis, and the published thresholds it uses are
 * named as such. It never diagnoses: an "act" item says what to DO with a
 * measurement (book a review, weigh in, keep today light), never what is wrong.
 *
 * ⚠ A source that could not be read is a NAMED GAP and its rule does not run —
 * "no blood-pressure finding" must never be how an unreadable feed looks.
 * ⚠ Pull-only. Nothing here notifies.
 */

const LEVELS = ['act', 'watch', 'gap', 'good'];

// NICE NG136: a home (or ambulatory) average of 135/85 or more is the threshold
// for hypertension, 150/95 for stage 2. Home monitoring averages, not one reading.
const BP_HOME_STAGE1 = { sys: 135, dia: 85 };
const BP_HOME_STAGE2 = { sys: 150, dia: 95 };
const BP_WINDOW_DAYS = 14;
const BP_MIN_DAYS = 5;

// NHS adult guideline: 150 minutes of moderate activity a week.
const NHS_WEEKLY_MINUTES = 150;
const SPO2_TYPICAL_FLOOR = 95;
const SLEEP_FLOOR_HOURS = 7;
const DAYLIGHT_FLOOR_MIN = 30;
const WEIGHT_GAIN_KG = 3;          // over the comparison window, to be worth saying
const WEIGHT_STALE_DAYS = 21;
const VO2_FALL_1Y = 2;
const RHR_RISE_BPM = 3;
const RING_STALE_HOURS = 48;
const WATCH_STALE_HOURS = 6;
const HILO_STALE_HOURS = 48;

const ANTIHYPERTENSIVES = /amlodipine|ramipril|lisinopril|perindopril|losartan|candesartan|irbesartan|indapamide|bendroflumethiazide|bisoprolol|doxazosin/i;

const DOMAIN_ORDER = ['bp', 'recovery', 'weight', 'fitness', 'activity', 'oxygen', 'heart', 'sleep', 'daylight', 'medical', 'sources'];

function round(n, dp = 1) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function median(nums) {
  const v = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function mean(nums) {
  const v = nums.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Whole days between two YYYY-MM-DD keys. Both are wall-clock dates, never parsed as instants. */
function daysBetween(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b))) return null;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Values of one field across complete days whose key is in [from, to). Newest-first input. */
function window(days, key, { today, fromDaysAgo, toDaysAgo }) {
  const hi = shiftDay(today, -toDaysAgo);
  const lo = shiftDay(today, -fromDaysAgo);
  return days.filter((d) => d.complete && d.day >= lo && d.day < hi && Number.isFinite(d[key]))
    .map((d) => d[key]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'February 2026' from a day key — sliced, never parsed into a Date. */
function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})/.exec(String(key));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(key);
}

function fmtKg(n) { return `${round(n, 1)}kg`; }

// ── The rules. Each takes the inputs and returns { insight, system } or nulls. ──

function bloodPressure({ days, today, medical }) {
  const recent = days.filter((d) => d.complete && Number.isFinite(d.bpSystolic) && Number.isFinite(d.bpDiastolic)
    && daysBetween(d.day, today) <= BP_WINDOW_DAYS);
  const system = { id: 'bp', label: 'Blood pressure', sources: ['HiLo (via Apple Health)'], view: 'health' };
  if (recent.length < BP_MIN_DAYS) {
    return {
      system: { ...system, status: 'unknown', value: null,
        sub: `${recent.length} day${recent.length === 1 ? '' : 's'} with a reading in the last ${BP_WINDOW_DAYS} — not enough for an average` },
      insight: {
        id: 'bp-sparse', domain: 'bp', level: 'gap', view: 'health',
        title: 'Not enough blood-pressure readings for an average',
        finding: `Only ${recent.length} day${recent.length === 1 ? '' : 's'} in the last ${BP_WINDOW_DAYS} carried a HiLo reading.`,
        action: 'Wear the HiLo bracelet daily for a week so NEURO can work out a home average.',
        basis: `A home average needs at least ${BP_MIN_DAYS} days.`,
        evidence: [],
      },
    };
  }
  const sys = round(mean(recent.map((d) => d.bpSystolic)), 0);
  const dia = round(mean(recent.map((d) => d.bpDiastolic)), 0);
  const earlier = days.filter((d) => d.complete && Number.isFinite(d.bpSystolic)
    && daysBetween(d.day, today) > 90 && daysBetween(d.day, today) <= 365);
  const earlierSys = earlier.length >= BP_MIN_DAYS ? round(mean(earlier.map((d) => d.bpSystolic)), 0) : null;
  const earlierDia = earlier.length >= BP_MIN_DAYS ? round(mean(earlier.map((d) => d.bpDiastolic)), 0) : null;
  const trend = earlierSys != null ? `${earlierSys}/${earlierDia} averaged 3–12 months ago` : null;

  const stage2 = sys >= BP_HOME_STAGE2.sys || dia >= BP_HOME_STAGE2.dia;
  const stage1 = sys >= BP_HOME_STAGE1.sys || dia >= BP_HOME_STAGE1.dia;
  // Already under care? Then the action is "take it to the review", not "book one".
  const known = (medical?.diagnoses || []).some((n) => /hypertension|blood pressure/i.test(n))
    || (medical?.prescriptions || []).some((n) => ANTIHYPERTENSIVES.test(n));

  const evidence = [{ source: 'HiLo (via Apple Health)', text: `${sys}/${dia} mmHg mean of ${recent.length} days` }];
  if (trend) evidence.push({ source: 'HiLo (via Apple Health)', text: trend });

  const sysOut = { ...system, value: `${sys}/${dia}`, unit: 'mmHg', sub: `${BP_WINDOW_DAYS}-day home average${trend ? ` · ${trend}` : ''}` };
  if (!stage1) {
    return {
      system: { ...sysOut, status: 'good' },
      insight: {
        id: 'bp-ok', domain: 'bp', level: 'good', view: 'health',
        title: 'Blood pressure is under the home-monitoring threshold',
        finding: `Your ${BP_WINDOW_DAYS}-day home average is ${sys}/${dia}.`,
        action: null,
        basis: `NICE NG136 uses ${BP_HOME_STAGE1.sys}/${BP_HOME_STAGE1.dia} as the threshold for a home average.`,
        evidence,
      },
    };
  }
  const threshold = stage2 ? `${BP_HOME_STAGE2.sys}/${BP_HOME_STAGE2.dia} (stage 2)` : `${BP_HOME_STAGE1.sys}/${BP_HOME_STAGE1.dia}`;
  return {
    system: { ...sysOut, status: 'act' },
    insight: {
      id: 'bp-high', domain: 'bp', level: 'act', view: 'health',
      title: `Blood pressure is averaging ${sys}/${dia}`,
      finding: `Your ${BP_WINDOW_DAYS}-day home average from HiLo is ${sys}/${dia}, at or above the ${threshold} home-monitoring threshold${trend ? `. It was ${trend.replace(' averaged', '')}` : ''}.`,
      action: known
        ? 'Take this average to your next blood-pressure review. It is the figure a clinician will ask for.'
        : 'Book a blood-pressure review with your GP practice and take HiLo’s 7-day report. A clinician confirms with a cuff or a 24-hour monitor, so this is the evidence that starts that conversation.',
      basis: `NICE NG136: a home average of ${BP_HOME_STAGE1.sys}/${BP_HOME_STAGE1.dia} or more is the hypertension threshold; ${BP_HOME_STAGE2.sys}/${BP_HOME_STAGE2.dia} is stage 2.`,
      caveat: 'HiLo is a cuffless bracelet calibrated against a cuff. This is a measurement to act on, not a diagnosis.',
      evidence,
    },
  };
}

function weight({ days, today }) {
  const series = days.filter((d) => Number.isFinite(d.weightKg)).map((d) => ({ day: d.day, kg: d.weightKg }));
  const system = { id: 'weight', label: 'Weight', sources: ['Apple Health (scales)'], view: 'health' };
  if (!series.length) {
    return {
      system: { ...system, status: 'unknown', value: null, sub: 'No weight readings in the last year' },
      insight: {
        id: 'weight-none', domain: 'weight', level: 'gap', view: 'health',
        title: 'No weight readings',
        finding: 'Nothing in Apple Health in the last year.',
        action: 'Weigh in once a week. It is the number most of the others move with.',
        basis: null, evidence: [],
      },
    };
  }
  const latest = series[0];
  const since = daysBetween(latest.day, today);
  // Compare against the lowest reading in the 6–12 months before the latest one,
  // which is "where you were", not one odd morning.
  const prior = series.filter((s) => { const age = daysBetween(s.day, latest.day); return age >= 120 && age <= 365; });
  const low = prior.length ? prior.reduce((a, b) => (b.kg < a.kg ? b : a)) : null;
  const gain = low ? round(latest.kg - low.kg, 1) : null;
  const evidence = [{ source: 'Apple Health', text: `${fmtKg(latest.kg)} on ${latest.day}` }];
  if (low) evidence.push({ source: 'Apple Health', text: `${fmtKg(low.kg)} on ${low.day}` });

  const sub = [low ? `${gain >= 0 ? '+' : ''}${gain}kg since ${monthLabel(low.day)}` : null,
    since > 0 ? `last weighed ${since} day${since === 1 ? '' : 's'} ago` : 'weighed today'].filter(Boolean).join(' · ');
  const stale = since > WEIGHT_STALE_DAYS;
  const rising = gain != null && gain >= WEIGHT_GAIN_KG;
  const status = rising ? 'watch' : stale ? 'unknown' : 'good';
  const systemOut = { ...system, status, value: fmtKg(latest.kg), sub };

  if (rising) {
    return {
      system: systemOut,
      insight: {
        id: 'weight-up', domain: 'weight', level: 'watch', view: 'health',
        title: `Weight is up ${gain}kg since ${monthLabel(low.day)}`,
        finding: `${fmtKg(low.kg)} on ${low.day}, ${fmtKg(latest.kg)} on ${latest.day}${stale ? `, the last weigh-in, ${since} days ago` : ''}.`,
        action: stale
          ? 'Weigh in this week, then once a week, so NEURO can see which way it is going now.'
          : 'Keep weighing in weekly. Weight is the lever that moves blood pressure and VO2 max together.',
        basis: 'Losing weight lowers blood pressure, by roughly 1 mmHg per kg in published trials.',
        evidence,
      },
    };
  }
  if (stale) {
    return {
      system: systemOut,
      insight: {
        id: 'weight-stale', domain: 'weight', level: 'gap', view: 'health',
        title: `No weigh-in for ${since} days`,
        finding: `The last reading was ${fmtKg(latest.kg)} on ${latest.day}.`,
        action: 'Weigh in this week.', basis: null, evidence,
      },
    };
  }
  return { system: systemOut, insight: null };
}

function fitness({ fitnessData, days, exertionRows, today }) {
  const v = fitnessData?.vo2max;
  const system = { id: 'fitness', label: 'Cardio fitness', sources: ['Apple Watch (VO2 max)'], view: 'health' };
  if (!v || !v.latest) {
    return { system: { ...system, status: 'unknown', value: null, sub: 'No VO2 max estimate' }, insight: null };
  }
  const change = v.change1y;
  const systemOut = { ...system, value: String(v.latest.value), unit: 'ml/kg/min',
    sub: `${change != null ? `${change > 0 ? '+' : ''}${change} over a year` : 'no year-ago figure'} · week of ${v.latest.week}` };

  // Zone 3+ minutes per week over the last four finished weeks of exertion.
  const recentEx = (exertionRows || []).filter((r) => r.complete && daysBetween(r.day, today) >= 1 && daysBetween(r.day, today) <= 28);
  const z3plus = recentEx.length
    ? round(recentEx.reduce((s, r) => s + (r.zoneMinutes || []).slice(2).reduce((a, b) => a + (b || 0), 0), 0) / (recentEx.length / 7), 0)
    : null;

  if (change == null || change > -VO2_FALL_1Y) {
    return { system: { ...systemOut, status: change == null ? 'unknown' : 'good' }, insight: null };
  }
  // VO2 max is per kilogram: how much of the fall is the scales, not the heart?
  // The same "a year back" cardioFitness's change1y measures from.
  const then = [...v.series].reverse().find((s) => daysBetween(s.week, v.latest.week) >= 364) || null;
  const weightNear = (week) => {
    let best = null;
    for (const d of days) {
      if (!Number.isFinite(d.weightKg)) continue;
      const gap = Math.abs(daysBetween(d.day, week));
      if (gap <= 45 && (!best || gap < best.gap)) best = { kg: d.weightKg, gap };
    }
    return best ? best.kg : null;
  };
  const wThen = then ? weightNear(then.week) : null;
  const wNow = weightNear(v.latest.week) ?? (days.find((d) => Number.isFinite(d.weightKg))?.weightKg ?? null);
  let weightShare = null;
  if (then && wThen && wNow && wNow > wThen) {
    const expected = round(then.value * wThen / wNow, 1);
    weightShare = { expected, thenKg: wThen, nowKg: wNow, explained: round(then.value - expected, 1) };
  }
  const evidence = [{ source: 'Apple Watch', text: `VO2 max ${then ? `${then.value} (week of ${then.week}) → ` : ''}${v.latest.value} (week of ${v.latest.week})` }];
  if (z3plus != null) evidence.push({ source: 'Exertion model', text: `${z3plus} min/week in heart-rate zones 3–5, last 4 weeks` });
  return {
    system: { ...systemOut, status: 'watch' },
    insight: {
      id: 'vo2-down', domain: 'fitness', level: 'watch', view: 'health',
      title: `Cardio fitness is down ${Math.abs(change)} over a year`,
      finding: `VO2 max is ${v.latest.value}, from ${then ? then.value : `${round(v.latest.value - change, 1)}`} a year ago.`
        + (weightShare
          ? ` It is measured per kilogram, so going from ${fmtKg(weightShare.thenKg)} to ${fmtKg(weightShare.nowKg)} accounts for about ${weightShare.explained} of that on its own.`
          : ''),
      action: z3plus != null
        ? `You averaged ${z3plus} minutes a week with your heart rate in zones 3–5. Two or three sessions a week that get you breathing hard, such as hills on a walk, is what raises it.${weightShare ? ' Bringing your weight back down lifts it as well.' : ''}`
        : 'Two or three sessions a week that get you breathing hard is what raises it.',
      basis: 'Apple estimates VO2 max from outdoor walks with GPS, in ml per kg per minute.',
      evidence,
    },
  };
}

function activity({ days, today }) {
  const ex = window(days, 'exerciseMinutes', { today, fromDaysAgo: 28, toDaysAgo: 0 });
  const steps = window(days, 'steps', { today, fromDaysAgo: 14, toDaysAgo: 0 });
  const system = { id: 'activity', label: 'Activity', sources: ['Apple Watch'], view: 'health' };
  if (ex.length < 14) return { system: { ...system, status: 'unknown', value: null, sub: 'Not enough complete days' }, insight: null };
  const weekly = round(ex.reduce((a, b) => a + b, 0) / (ex.length / 7), 0);
  const typical = round(median(ex), 0);
  const stepMed = round(median(steps), 0);
  const systemOut = { ...system, value: String(weekly), unit: 'min/week',
    sub: `exercise · typical day ${typical} min${stepMed != null ? ` · ${stepMed.toLocaleString('en-GB')} steps` : ''}` };
  if (weekly >= NHS_WEEKLY_MINUTES) {
    return {
      system: { ...systemOut, status: 'good' },
      insight: typical < 15 ? {
        id: 'activity-lumpy', domain: 'activity', level: 'watch', view: 'health',
        title: 'The weekly target is met, mostly on hike days',
        finding: `${weekly} exercise minutes a week over 4 weeks, but a typical day is ${typical} minutes.`,
        action: 'Add a brisk 20-minute walk on workdays so the week does not depend on one big day.',
        basis: `NHS guideline: ${NHS_WEEKLY_MINUTES} minutes of moderate activity a week, spread across it.`,
        evidence: [{ source: 'Apple Watch', text: `${ex.length} days, median ${typical} min/day` }],
      } : null,
    };
  }
  return {
    system: { ...systemOut, status: 'watch' },
    insight: {
      id: 'activity-low', domain: 'activity', level: 'watch', view: 'health',
      title: `${weekly} active minutes a week, against ${NHS_WEEKLY_MINUTES}`,
      finding: `Averaged over the last 4 weeks. A typical day is ${typical} minutes${stepMed != null ? ` and ${stepMed.toLocaleString('en-GB')} steps` : ''}.`,
      action: `A brisk 20-minute walk on five days closes the ${NHS_WEEKLY_MINUTES - weekly}-minute gap.`,
      basis: `NHS guideline: ${NHS_WEEKLY_MINUTES} minutes of moderate activity a week.`,
      evidence: [{ source: 'Apple Watch', text: `${ex.length} complete days` }],
    },
  };
}

function recovery({ perf }) {
  const system = { id: 'recovery', label: 'Recovery today', sources: ['Apple Watch', 'Exertion model'], view: 'health' };
  const r = perf?.recovery;
  if (!r || !r.known) return { system: { ...system, status: 'unknown', value: null, sub: r?.reason || 'No recovery read yet today' }, insight: null };
  const load = perf.trainingLoad;
  const target = perf.target?.known ? perf.target : null;
  const adverse = (r.contributors || []).filter((c) => c.flag === 'adverse').map((c) => c.note);
  const sub = [`${r.state}`, adverse.length ? adverse.join('; ') : null].filter(Boolean).join(' · ');
  const systemOut = { ...system, value: String(r.score), unit: '/100', sub };
  const spike = load?.known && load.state === 'spike';
  if (r.state === 'low' || spike) {
    const why = [adverse.length ? adverse.join(' and ') : null,
      spike ? `your week's load is ${load.ratio}× your usual` : null,
      perf.yesterday && Number.isFinite(perf.yesterday.load) ? `yesterday's load was ${round(perf.yesterday.load, 0)}` : null]
      .filter(Boolean).join(', ');
    return {
      system: { ...systemOut, status: r.state === 'low' ? 'act' : 'watch' },
      insight: {
        id: 'recovery-today', domain: 'recovery', level: r.state === 'low' ? 'act' : 'watch', view: 'health', today: true,
        title: r.state === 'low' ? 'Keep today light' : 'Your load is running high',
        finding: `Recovery ${r.score}/100${why ? `: ${why}` : ''}.`,
        action: target
          ? `Aim for a load between ${target.low} and ${target.high} today. An easy walk fits, a hard session does not.`
          : 'An easy walk is fine today. Leave the hard session for a better morning.',
        basis: 'Recovery compares HRV, resting heart rate and sleep with your last 14 days. Load uses the acute:chronic ratio. Both are heuristics and are not validated on you.',
        evidence: (r.contributors || []).map((c) => ({ source: 'Apple Watch', text: c.note })),
      },
    };
  }
  return { system: { ...systemOut, status: 'good' }, insight: null };
}

function oxygen({ days, today, ring }) {
  const recent = window(days, 'spo2', { today, fromDaysAgo: 14, toDaysAgo: 0 });
  const earlier = window(days, 'spo2', { today, fromDaysAgo: 365, toDaysAgo: 120 });
  const resp = window(days, 'respiratoryRate', { today, fromDaysAgo: 14, toDaysAgo: 0 });
  const system = { id: 'oxygen', label: 'Blood oxygen', sources: ['Apple Watch', 'JC Ring'], view: 'health' };
  if (recent.length < 7) return { system: { ...system, status: 'unknown', value: null, sub: 'Not enough readings' }, insight: null };
  const med = round(median(recent), 1);
  const was = earlier.length >= 30 ? round(median(earlier), 1) : null;
  const ringO2 = ring?.spo2 && Number.isFinite(ring.spo2.value) && ring.spo2.ageHours != null && ring.spo2.ageHours <= 24 * 7 ? ring.spo2 : null;
  const sub = [`14-day median${was != null ? ` · ${was}% 4–12 months ago` : ''}`, ringO2 ? `ring ${ringO2.value}%` : null].filter(Boolean).join(' · ');
  const systemOut = { ...system, value: String(med), unit: '%', sub };
  if (med >= SPO2_TYPICAL_FLOOR) return { system: { ...systemOut, status: 'good' }, insight: null };
  const evidence = [{ source: 'Apple Watch', text: `${med}% median over ${recent.length} days` }];
  if (was != null) evidence.push({ source: 'Apple Watch', text: `${was}% median 4–12 months ago` });
  if (ringO2) evidence.push({ source: 'JC Ring', text: `${ringO2.value}% latest reading` });
  if (resp.length) evidence.push({ source: 'Apple Watch', text: `respiratory rate ${round(median(resp), 1)}/min while asleep` });
  return {
    system: { ...systemOut, status: 'watch' },
    insight: {
      id: 'spo2-low', domain: 'oxygen', level: 'watch', view: 'health',
      title: `Watch blood oxygen is reading ${med}%`,
      finding: `The Watch's 14-day median is under the usual ${SPO2_TYPICAL_FLOOR}%${was != null && was > med ? `, and it was ${was}% earlier in the year` : ''}.${ringO2 ? ` The ring's latest is ${ringO2.value}%, so the two devices disagree.` : ''}`,
      action: 'Wrist oximeters often read low, so do not act on this alone. If you snore, wake unrefreshed or feel sleepy in the day, mention this to your GP alongside your blood pressure.',
      basis: `Healthy resting SpO2 is usually ${SPO2_TYPICAL_FLOOR}–100%.`,
      evidence,
    },
  };
}

function heart({ days, today }) {
  const recent = window(days, 'rhrMedian', { today, fromDaysAgo: 30, toDaysAgo: 0 });
  const prior = window(days, 'rhrMedian', { today, fromDaysAgo: 120, toDaysAgo: 30 });
  const hrv = window(days, 'hrvMedian', { today, fromDaysAgo: 30, toDaysAgo: 0 });
  const hrvPrior = window(days, 'hrvMedian', { today, fromDaysAgo: 120, toDaysAgo: 30 });
  const system = { id: 'heart', label: 'Resting heart', sources: ['Apple Watch'], view: 'health' };
  if (recent.length < 14) return { system: { ...system, status: 'unknown', value: null, sub: 'Not enough readings' }, insight: null };
  const now = round(median(recent), 0);
  const before = prior.length >= 30 ? round(median(prior), 0) : null;
  const hrvNow = round(median(hrv), 1);
  const hrvBefore = hrvPrior.length >= 30 ? round(median(hrvPrior), 1) : null;
  const sub = [before != null ? `${before} bpm the 3 months before` : null,
    hrvNow != null ? `HRV ${hrvNow} ms${hrvBefore != null ? ` (was ${hrvBefore})` : ''}` : null].filter(Boolean).join(' · ');
  const rising = before != null && now - before >= RHR_RISE_BPM;
  const systemOut = { ...system, value: String(now), unit: 'bpm', sub, status: rising ? 'watch' : 'good' };
  if (!rising) return { system: systemOut, insight: null };
  return {
    system: systemOut,
    insight: {
      id: 'rhr-up', domain: 'heart', level: 'watch', view: 'health',
      title: `Resting heart rate is up ${now - before} bpm`,
      finding: `30-day median ${now} bpm, against ${before} the three months before.`,
      action: 'A rise that lasts usually follows sleep, alcohol, illness or a drop in activity. Look at which of those changed this month.',
      basis: 'Your own baseline. Nothing here is a clinical threshold.',
      evidence: [{ source: 'Apple Watch', text: `${recent.length} days vs ${prior.length} days` }],
    },
  };
}

function sleep({ days, today }) {
  const recent = window(days, 'asleepHours', { today, fromDaysAgo: 15, toDaysAgo: -1 });
  const system = { id: 'sleep', label: 'Sleep', sources: ['Apple Watch'], view: 'health' };
  if (recent.length < 7) return { system: { ...system, status: 'unknown', value: null, sub: 'Not enough nights' }, insight: null };
  const med = round(median(recent), 1);
  const short = recent.filter((h) => h < 6).length;
  const systemOut = { ...system, value: String(med), unit: 'h', sub: `median of ${recent.length} nights${short ? ` · ${short} under 6h` : ''}` };
  if (med >= SLEEP_FLOOR_HOURS) return { system: { ...systemOut, status: 'good' }, insight: null };
  return {
    system: { ...systemOut, status: 'watch' },
    insight: {
      id: 'sleep-short', domain: 'sleep', level: 'watch', view: 'health',
      title: `Sleeping ${med}h a night`,
      finding: `Median of the last ${recent.length} nights, ${short} of them under six hours.`,
      action: 'Pick a fixed lights-out time for the work week and protect it.',
      basis: `Adults generally need ${SLEEP_FLOOR_HOURS}–9 hours.`,
      evidence: [],
    },
  };
}

function daylight({ days, today }) {
  const recent = window(days, 'daylightMinutes', { today, fromDaysAgo: 14, toDaysAgo: 0 });
  const system = { id: 'daylight', label: 'Daylight', sources: ['Apple Watch'], view: 'health' };
  if (recent.length < 7) return { system: { ...system, status: 'unknown', value: null, sub: 'Not enough readings' }, insight: null };
  const med = round(median(recent), 0);
  const systemOut = { ...system, value: String(med), unit: 'min/day', sub: `14-day median, outdoors in daylight` };
  if (med >= DAYLIGHT_FLOOR_MIN) return { system: { ...systemOut, status: 'good' }, insight: null };
  return {
    system: { ...systemOut, status: 'watch' },
    insight: {
      id: 'daylight-low', domain: 'daylight', level: 'watch', view: 'health',
      title: `${med} minutes of daylight a day`,
      finding: `The median over the last ${recent.length} days. Most days are desk days indoors.`,
      action: 'Take the first coffee or a call outside before 10am. It adds daylight and some of the walking above.',
      basis: 'Morning daylight helps set the sleep–wake rhythm. The Watch counts time outdoors in daylight.',
      evidence: [],
    },
  };
}

function medicalGap({ medical }) {
  if (!medical || medical.unreadable) return null;
  if (medical.total > 0) return null;
  return {
    id: 'medical-none', domain: 'medical', level: 'gap', view: 'medical',
    title: 'No medical records in NEURO yet',
    finding: 'No test results, diagnoses or prescriptions have been added.',
    action: 'Scan your latest NHS app blood tests into Medical: cholesterol, HbA1c and kidney function. With blood pressure where it is, they are what a GP will look at next.',
    basis: null, evidence: [],
  };
}

function sourceRows({ sources, nowMs }) {
  const age = (ms) => (Number.isFinite(ms) ? round((nowMs - ms) / 3600000, 1) : null);
  const row = (name, role, ms, staleAfter, extra = null, view = 'health') => {
    const h = age(ms);
    return { name, role, lastAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null, ageHours: h,
      state: h == null ? 'none' : h > staleAfter ? 'stale' : 'live', extra, view };
  };
  return [
    row('Apple Watch', 'Heart rate, HRV, sleep, activity, SpO2, VO2 max', sources.watchMs, WATCH_STALE_HOURS),
    row('HiLo bracelet', 'Blood pressure, via Apple Health', sources.hiloMs, HILO_STALE_HOURS),
    row('JC Ring', 'Heart rate, HRV, SpO2, skin temperature, vendor BP estimate', sources.ringMs, RING_STALE_HOURS,
      Number.isFinite(sources.ringBattery) ? `battery ${sources.ringBattery}%` : null, 'jc-ring'),
    { name: 'Medical records', role: 'Test results, diagnoses, prescriptions', lastAt: sources.medicalLatest || null, ageHours: null,
      state: sources.medicalCount ? 'live' : 'none', extra: `${sources.medicalCount || 0} record${sources.medicalCount === 1 ? '' : 's'}`, view: 'medical' },
  ];
}

/**
 * PURE. inputs → the picture. `unread` names the inputs that could not be read;
 * a rule whose input is unread does not run and its system says so.
 */
function compose({ today, nowMs, days = [], perf = null, fitnessData = null, exertionRows = [], medical = null,
  ring = null, signals = [], sources = {}, unread = [] } = {}) {
  const insights = [];
  const systems = [];
  unread = unread.filter((u, i) => unread.findIndex((x) => x.input === u.input) === i);
  const blocked = new Set(unread.map((u) => u.input));
  const run = (inputs, label, fn) => {
    const missing = inputs.find((i) => blocked.has(i));
    if (missing) {
      systems.push({ id: label.id, label: label.label, status: 'unknown', value: null, sub: `Could not read ${missing}`, sources: [], view: label.view || 'health' });
      return;
    }
    const out = fn();
    if (!out) return;
    if (out.system) systems.push(out.system);
    if (out.insight) insights.push(out.insight);
  };

  run(['days'], { id: 'bp', label: 'Blood pressure' }, () => bloodPressure({ days, today, medical }));
  run(['performance'], { id: 'recovery', label: 'Recovery today' }, () => recovery({ perf }));
  run(['days'], { id: 'weight', label: 'Weight' }, () => weight({ days, today }));
  run(['fitness', 'days'], { id: 'fitness', label: 'Cardio fitness' }, () => fitness({ fitnessData, days, exertionRows, today }));
  run(['days'], { id: 'activity', label: 'Activity' }, () => activity({ days, today }));
  run(['days'], { id: 'heart', label: 'Resting heart' }, () => heart({ days, today }));
  run(['days'], { id: 'oxygen', label: 'Blood oxygen' }, () => oxygen({ days, today, ring }));
  run(['days'], { id: 'sleep', label: 'Sleep' }, () => sleep({ days, today }));
  run(['days'], { id: 'daylight', label: 'Daylight' }, () => daylight({ days, today }));
  if (!blocked.has('medical')) { const m = medicalGap({ medical }); if (m) insights.push(m); }

  const sourceList = sourceRows({ sources, nowMs });
  for (const s of sourceList) {
    if (s.state === 'stale' && s.name !== 'Medical records') {
      insights.push({ id: `source-${s.name}`, domain: 'sources', level: 'gap', view: s.view,
        title: `${s.name} has not reported for ${s.ageHours < 48 ? `${round(s.ageHours, 0)} hours` : `${round(s.ageHours / 24, 0)} days`}`,
        finding: `It provides ${s.role.toLowerCase()}. Anything above that relies on it is older than it looks.`,
        action: s.name === 'JC Ring' ? 'Open NEURO on the phone near the ring to sync it.' : `Check ${s.name} is worn and syncing.`,
        basis: null, evidence: [] });
    }
  }
  for (const f of signals) {
    insights.push({ id: `signal-${f.id}`, domain: 'sources', level: f.level === 'warn' && /stopped arriving/.test(f.title) ? 'gap' : 'watch',
      view: 'health', title: f.title, finding: f.detail, action: null, basis: f.caveat || null, evidence: [] });
  }
  for (const u of unread) {
    insights.push({ id: `unread-${u.input}`, domain: 'sources', level: 'gap', view: 'health',
      title: `Could not read ${u.input}`, finding: u.why, action: null, basis: null, evidence: [] });
  }

  insights.sort((a, b) => (LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
    || (DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain)));
  systems.sort((a, b) => DOMAIN_ORDER.indexOf(a.id) - DOMAIN_ORDER.indexOf(b.id));

  const acts = insights.filter((i) => i.level === 'act');
  const watches = insights.filter((i) => i.level === 'watch');
  const headline = acts.length
    ? `${acts.length} thing${acts.length === 1 ? '' : 's'} to act on: ${acts.map((a) => a.title.charAt(0).toLowerCase() + a.title.slice(1)).join('; ')}.`
    : watches.length
      ? `Nothing urgent. ${watches.length} trend${watches.length === 1 ? '' : 's'} worth watching.`
      : unread.length ? 'Part of the picture could not be read, so this is not an all-clear.' : 'Everything NEURO can see is holding up.';

  return {
    contract: 'health-picture-v1',
    today,
    headline,
    counts: { act: acts.length, watch: watches.length, gap: insights.filter((i) => i.level === 'gap').length,
      good: insights.filter((i) => i.level === 'good').length },
    insights,
    systems,
    sources: sourceList,
    complete: unread.length === 0,
    note: 'Pulled from Apple Health (Watch and HiLo), the JC Ring, medical records and the exertion model. It shows measurements and trends, and is not a diagnosis.',
  };
}

function toMs(at) {
  if (!at) return null;
  const s = String(at);
  const ms = Date.parse(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function localDayKey(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London' }).format(now);
}

/** Gather every input, naming whatever could not be read. */
function read({ now = new Date() } = {}) {
  const unread = [];
  const attempt = (input, fn, fallback) => {
    try { return fn(); } catch (e) { unread.push({ input, why: e.message }); return fallback; }
  };
  const db = require('../db/database');
  const days = attempt('days', () => require('./health-daily').recentDays(400), []);
  const perf = attempt('performance', () => require('./exertion').summary(now), null);
  const exertionRows = attempt('performance', () => require('./exertion').recent(35), []);
  const fitnessData = attempt('fitness', () => require('./performance-insights').loadCardioFitness(), null);
  const medical = attempt('medical', () => {
    const mr = require('./medical-records');
    const s = mr.summary();
    const total = Object.values(s).reduce((a, b) => a + (b.count || 0), 0);
    const names = (kind) => mr.list({ kind, limit: 200 }).records.map((r) => r.name).filter(Boolean);
    return { total, summary: s, diagnoses: names('diagnosis'), prescriptions: names('prescription'),
      latest: Object.values(s).map((x) => x.latest).filter(Boolean).sort().pop() || null };
  }, null);
  const signals = attempt('signals', () => require('./health-signals').snapshot({ now }).findings || [], []);

  const nowMs = now.getTime();
  const sources = attempt('sources', () => {
    const latest = require('./health-samples').latest({ now });
    const bp = require('./health-samples').latestBloodPressure({ now });
    const ringHr = db.getLatestJCRingSample('heart_rate');
    const ringBattery = db.getLatestJCRingSample('battery_level_percent');
    return {
      watchMs: toMs(latest?.latest?.heartRateMedian?.at),
      hiloMs: bp && bp.known ? toMs(bp.at) : null,
      ringMs: toMs(ringHr?.received_at || ringBattery?.received_at),
      ringBattery: ringBattery ? ringBattery.value : null,
      medicalCount: medical ? medical.total : 0,
      medicalLatest: medical ? medical.latest : null,
    };
  }, {});
  const ring = attempt('ring', () => {
    const o2 = db.getLatestJCRingSample('blood_oxygen_saturation');
    const ms = o2 ? toMs(o2.received_at) : null;
    return { spo2: o2 ? { value: o2.value, ageHours: ms ? (nowMs - ms) / 3600000 : null } : null };
  }, null);

  return compose({ today: localDayKey(now), nowMs, days, perf, fitnessData, exertionRows, medical, ring,
    signals, sources, unread });
}

module.exports = {
  compose,
  read,
  _internals: { monthLabel, bloodPressure, weight, fitness, activity, recovery, oxygen, heart, sleep, daylight, medicalGap, daysBetween, median },
  BP_HOME_STAGE1,
  BP_HOME_STAGE2,
  NHS_WEEKLY_MINUTES,
};
