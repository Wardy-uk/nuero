'use strict';

/**
 * The home router, as a sense NEURO can see — and an early warning before it
 * takes DHCP down with it.
 *
 * Nick, 14 Sep 2026, after the Sky box reported "no ethernet connection":
 * *"can we build alerting/early warning into NEURO/SARA same way as we do for
 * smart devices?"*
 *
 * ── What actually fails ─────────────────────────────────────────────────────
 * The ASUS RT-AC68U wedges roughly every 2-3 weeks (17.8 days, measured). Not a
 * crash — a PILE-UP. Daemons block in uninterruptible D state, every process
 * that touches them queues behind them and CANNOT BE KILLED, `check_watchdog`
 * restarts services every 60s adding more, and the box eventually cannot fork
 * or allocate. dnsmasq then fails to write its lease file and DHCP dies.
 *
 * ⚠ THE WHOLE POINT IS THAT IT LOOKS FINE FROM EVERYWHERE ELSE. Packet
 * forwarding and DNS are kernel-side and keep working throughout, so the
 * internet is up, every device is happy, and the only symptom is the next
 * device that happens to need a DHCP renewal falling off the network. That is
 * the same blindness `signals.js` exists to remove, one layer down: nothing in
 * the house could see the router dying.
 *
 * ── The inverted alarm, which is the interesting bit ────────────────────────
 * ⚠ WHEN THE ROUTER IS WEDGED, THE WATCHER'S OWN READS FAIL. `ps` needs to
 * fork, and fork is precisely what runs out. So a sample that says *"I could
 * not read the D-state count"* is NOT a gap in the data — it is the strongest
 * single piece of evidence that the failure is happening, because nothing else
 * makes `ps` fail on an idle router. Unreadability IS the signature.
 *
 * That inverts this codebase's usual rule. Everywhere else an unreadable source
 * must never be reported as a fault. Here, a shell that will not run on a box
 * that still answers ping IS the fault, and calling it "unknown" would hide the
 * one state this was built to catch.
 *
 * ── Thresholds are PROVISIONAL and say so ───────────────────────────────────
 * ⚠ We have exactly TWO measurements: healthy, and fully wedged. We do NOT yet
 * have the onset curve — the router's syslog is a 256KB ring buffer that had
 * already rotated away the origin by the time anyone looked. So every number
 * below sits deliberately FAR from the healthy baseline rather than close to
 * the failure, because the expensive mistake is crying wolf: a rule that fires
 * on a normal Tuesday is one Nick learns to ignore, and it costs him the real
 * one.
 *
 *   measured 14 Sep 2026      healthy        wedged
 *   load (15m)                0.65 - 1.5     250
 *   tasks                     ~140           369
 *   D-state processes         0              ~250
 *   MemFree                   117 MB         81 MB
 *   nvram free                6762 B         5342 B
 *
 * ⚠ MemFree is a POOR indicator and is deliberately not a trigger on its own.
 * It moved only 117MB -> 81MB across a total failure, so any threshold tight
 * enough to catch the wedge would fire constantly. Carried for context.
 *
 * ⚠ D-STATE MUST BE SUSTAINED. Every disk read passes through D for
 * microseconds, so a single non-zero sample is noise. Two consecutive samples
 * (~10 minutes) is the bar, and it is the earliest honest signal available.
 *
 * Revisit all of these once the watcher has captured one real build-up. Until
 * then `provisional: true` rides on the payload so no screen can present these
 * as measured.
 *
 * PURE where it judges: `assess()` takes samples and a clock, so the rules pin
 * without a database — the `pi-health.assess()` split. Only `record()` and
 * `samples()` read or write.
 *
 * READ-ONLY with respect to the router. Nothing here logs in, reboots, or
 * changes anything on it. It watches.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const STATE_KEY = 'router_health';
// At one sample per 5 minutes this is a little over 24 hours — enough to see a
// build-up in context without putting a day of telemetry in agent_state.
const MAX_SAMPLES = 300;

// ── Thresholds (PROVISIONAL — see header) ────────────────────────────────────
const LOAD_WARN = 10;          // baseline peaks ~1.5; wedged 250
const TASKS_WARN = 200;        // baseline ~140; wedged 369
const D_SUSTAINED = 3;         // baseline 0
const D_SAMPLES_REQUIRED = 2;  // ~10 minutes — one sample is noise
const NVRAM_LOW = 2000;        // bytes free of a 64KB partition
const MEM_FLOOR_KB = 40000;    // context only; well under the 81MB seen when wedged
const WATCHER_STALE_MIN = 20;  // 4 missed samples at a 5-minute cadence

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * ⚠ ABSENCE IS NEVER A ZERO. `Number(null)` and `Number('')` are both 0, so a
 * naive coercion turns "I could not read the D-state count" into "there are no
 * stuck processes" — a wedged router reporting itself healthy, which is the one
 * result this whole file exists to make impossible. Caught by a test, not by
 * reading.
 */
function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Newest-first, and only samples we can date. */
function _ordered(samples) {
  return (Array.isArray(samples) ? samples : [])
    .filter((s) => s && s.at && Number.isFinite(Date.parse(s.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Is the D-state count sustained above the bar? PURE.
 *
 * ⚠ Requires D_SAMPLES_REQUIRED CONSECUTIVE samples, newest first. A transient
 * D is what a healthy disk read looks like; a persistent one is a hang that
 * cannot be killed.
 *
 * ⚠ Returns null when there is not enough history to say, which is deliberately
 * NOT the same as false — "I cannot tell yet" and "no" license different words.
 */
function sustainedD(samples, { need = D_SAMPLES_REQUIRED, bar = D_SUSTAINED } = {}) {
  const usable = _ordered(samples).filter((s) => _num(s.dcount) != null);
  if (usable.length < need) return null;
  for (let i = 0; i < need; i += 1) {
    if (_num(usable[i].dcount) < bar) return false;
  }
  return true;
}

/**
 * Turn the samples into a state and a ranked issue list. PURE.
 *
 * States, worst first:
 *   wedged        the failure is happening now
 *   unreachable   it does not answer at all
 *   degrading     the build-up has started
 *   ok            reporting and healthy
 *   unknown       we cannot say — no watcher, or it has stopped
 *
 * ⚠ `unknown` is NOT `ok`. A watcher that has stopped tells us nothing about
 * the router, and rendering that as a green light is the exact failure this
 * file exists to prevent.
 */
function assess(samples, now = new Date()) {
  const list = _ordered(samples);
  const issues = [];
  const add = (level, title, detail) => issues.push({ level, title, detail });
  const base = { provisional: true, issues, latest: list[0] || null, sampleCount: list.length };

  if (!list.length) {
    return { ...base, state: 'unknown', ageMinutes: null, why: 'the router watcher has never reported' };
  }

  const latest = list[0];
  const ageMin = Math.max(0, Math.round((now.getTime() - Date.parse(latest.at)) / 60000));

  if (ageMin > WATCHER_STALE_MIN) {
    add('warn', 'Router watcher has stopped', `last sample ${ageMin} minutes ago — this says nothing about the router itself`);
    return { ...base, state: 'unknown', ageMinutes: ageMin, why: `no sample for ${ageMin} minutes` };
  }

  // ── Not answering at all ──────────────────────────────────────────────────
  if (latest.reachable === false) {
    add('critical', 'Router not responding', 'it does not answer a ping — rebooting, or down');
    return { ...base, state: 'unreachable', ageMinutes: ageMin, why: 'no ping response' };
  }

  // ── The inverted alarm ────────────────────────────────────────────────────
  // ⚠ Answers ping but will not run a shell. On an idle router nothing else
  // does that: it means fork is failing, which is the wedge itself.
  if (latest.shellOk === false) {
    add('critical', 'Router cannot run commands',
      'it answers ping but a shell will not start — fork exhaustion, the wedge is happening');
    return { ...base, state: 'wedged', ageMinutes: ageMin, why: 'shell will not start' };
  }
  if (latest.dstateReadable === false) {
    add('critical', 'Router cannot list processes', 'ps failed to fork — the process table is exhausted');
    return { ...base, state: 'wedged', ageMinutes: ageMin, why: 'ps could not fork' };
  }

  // ── Build-up ──────────────────────────────────────────────────────────────
  let degrading = false;

  const dSustained = sustainedD(list);
  const dcount = _num(latest.dcount);
  if (dSustained === true) {
    degrading = true;
    const names = Array.isArray(latest.dprocs) && latest.dprocs.length
      ? ` — ${latest.dprocs.slice(0, 4).join(', ')}`
      : '';
    add('critical', `${dcount} processes stuck in D state`,
      `sustained across samples${names}. These cannot be killed; only a reboot clears them.`);
  } else if (dcount != null && dcount >= D_SUSTAINED) {
    // Seen once. Worth recording, not worth alarming about.
    add('info', `${dcount} processes in D state`,
      'a single sample — normal during disk I/O, watch for it persisting');
  }

  const load15 = _num(latest.load15);
  if (load15 != null && load15 >= LOAD_WARN) {
    degrading = true;
    add('critical', `Load average ${load15}`,
      'on Linux this counts blocked processes too, so it is a queue length rather than CPU use');
  }

  const tasks = _num(latest.tasks);
  if (tasks != null && tasks >= TASKS_WARN) {
    degrading = true;
    add('warn', `${tasks} tasks`, 'baseline is around 140 — processes are accumulating');
  }

  // ── Slow burn, independent of the wedge ───────────────────────────────────
  const nvramFree = _num(latest.nvramFree);
  if (nvramFree != null && nvramFree <= NVRAM_LOW) {
    add('warn', `nvram nearly full — ${nvramFree} bytes left`,
      'writes start failing when this runs out, which is one of the ways the box gets into trouble');
  }

  const memFree = _num(latest.memFreeKb);
  if (memFree != null && memFree <= MEM_FLOOR_KB) {
    add('warn', `MemFree ${Math.round(memFree / 1024)} MB`, 'low even by this router’s standards');
  }

  if (degrading) {
    return { ...base, state: 'degrading', ageMinutes: ageMin, why: issues[0] ? issues[0].title : 'build-up detected' };
  }
  return { ...base, state: 'ok', ageMinutes: ageMin };
}

/**
 * One line for a status row or a push. PURE.
 *
 * ⚠ Returns null when there is nothing worth saying. There is no cheerful
 * version of "the router is fine", and a surface that always speaks is one
 * nobody reads — the `wins.headline` rule.
 */
function headline(a) {
  if (!a) return null;
  if (a.state === 'wedged') return 'The router is wedging — DHCP will stop and devices will drop off. Reboot it.';
  if (a.state === 'unreachable') return 'The router is not responding.';
  if (a.state === 'degrading') {
    const top = (a.issues || []).find((i) => i.level === 'critical') || (a.issues || [])[0];
    return top ? `Router: ${top.title}` : 'Router: build-up detected';
  }
  return null;
}

// ── Reading and writing ──────────────────────────────────────────────────────

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return { samples: [], notifiedFor: null };
    const parsed = JSON.parse(raw);
    return {
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      notifiedFor: parsed.notifiedFor || null,
    };
  } catch {
    return { samples: [], notifiedFor: null, unreadable: true };
  }
}

/** Store one sample. Bounded, newest first. */
function record(sample = {}) {
  const state = _load();
  const tri = (v) => (v === true ? true : v === false ? false : null);
  const row = {
    at: sample.at && Number.isFinite(Date.parse(sample.at))
      ? new Date(sample.at).toISOString()
      : new Date().toISOString(),
    // ⚠ Three-valued, not boolean. "I did not check" must not read as "it failed".
    reachable: tri(sample.reachable),
    shellOk: tri(sample.shellOk),
    dstateReadable: tri(sample.dstateReadable),
    uptimeSec: _num(sample.uptimeSec),
    load1: _num(sample.load1),
    load5: _num(sample.load5),
    load15: _num(sample.load15),
    tasks: _num(sample.tasks),
    dcount: _num(sample.dcount),
    dprocs: Array.isArray(sample.dprocs) ? sample.dprocs.slice(0, 12).map((s) => String(s).slice(0, 40)) : [],
    memFreeKb: _num(sample.memFreeKb),
    nvramFree: _num(sample.nvramFree),
  };
  const samples = [row, ...(state.samples || [])].slice(0, MAX_SAMPLES);
  db.setState(STATE_KEY, JSON.stringify({ samples, notifiedFor: state.notifiedFor || null }));
  return row;
}

function samples() {
  return _load().samples || [];
}

/**
 * Has this episode already been announced? So the push fires ONCE when the
 * state turns, not every five minutes for a fortnight.
 *
 * ⚠ Keyed on the STATE, so a recovery clears it and a fresh episode speaks
 * again. `unknown` deliberately does not latch — a stopped watcher is not an
 * episode to announce and re-announce.
 */
function shouldAnnounce(state) {
  const s = _load();
  const write = (notifiedFor) => db.setState(STATE_KEY, JSON.stringify({ samples: s.samples || [], notifiedFor }));
  if (state === 'ok' || state === 'unknown') {
    if (s.notifiedFor) write(null);
    return false;
  }
  if (s.notifiedFor === state) return false;
  write(state);
  return true;
}

function current(now = new Date()) {
  return assess(samples(), now);
}

module.exports = {
  assess, sustainedD, headline,
  record, samples, current, shouldAnnounce,
  STATE_KEY, MAX_SAMPLES,
  LOAD_WARN, TASKS_WARN, D_SUSTAINED, D_SAMPLES_REQUIRED, NVRAM_LOW, WATCHER_STALE_MIN,
};
