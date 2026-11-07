import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './Sidebar.css';
import { VIEW_GROUPS, groupOfView } from './ViewTabs';
import { useWorkOnly, WORK_ONLY_HIDDEN_GROUPS, WORK_ONLY_HIDDEN_ITEMS } from '../workOnly';
import { SaimMark } from './BrandMarks';

const PRIMARY_ITEMS = [
  // ── Build 10P: Nick-first navigation ───────────────────────────────────────
  //
  // Work is ONE section below, not the root of the app (vault: JARVIS FRIDAY
  // Target Architecture, "Nick-first operating model"). The primary row is the
  // things done from a standing start whatever part of life they concern:
  // Now (the one situational surface — Briefing and Focus merged into it),
  // Capture, Ask, Actions (the governed approval queue — never under a
  // collapsed group, or its badge is invisible) and Commitments (both
  // directions, from the world model).
  { id: 'today',       label: 'Now',         icon: '◐' },
  // Next steps (3 Nov 2026): everything pending in one list — Start / Snooze / Not today.
  { id: 'next-steps',  label: 'Next steps',  icon: '▸' },
  // Drafts (22 Oct 2026): every unfinished thing SAiM has prepared, in one place — where Now's "make ready" lands.
  { id: 'drafts',      label: 'Drafts',      icon: '✎' },
  // The list Nick works from every day — primary, beside the promises behind it (13 Oct 2026).
  { id: 'todos',       label: 'Tasks',       icon: '☑' },
  { id: 'capture',     label: 'Capture',     icon: '+' },
  { id: 'chat',        label: 'Ask',         icon: '›' },
  { id: 'actions',     label: 'Actions',     icon: '✓' },
  { id: 'commitments', label: 'Commitments', icon: '⇄' },
  // Its own entry (7 Nov 2026): it was a card on NEURO Health nobody could find.
  { id: 'could-do',    label: 'NEURO could do', icon: '✧' },
  // What NEURO did on its own, and the time it saved (moved up from SYSTEM, 7 Nov 2026).
  { id: 'neuro-did',   label: 'NEURO did for you', icon: '◷' },
];

// Groups, in order. Each id appears exactly once across PRIMARY and GROUPS.
// ⚠ Retired ids (briefing, focus, qa, strava, kpi-tracker) are NOT here; they
// still route via viewIds.canonicalView so old links land somewhere real.
const GROUPS = [
  // The Life overhaul (13 Oct 2026): Life is an overview; each part of life
  // has a page. An entry with `group` is the first tab of a ViewTabs group and
  // stays lit for every tab in it (Health: My Health / Apple Health / Medical; Home: Home / Catalogues; Outdoor: Outdoor / Hike safety /
  // Weather). Those tab ids are still views of their own — deep links work.
  { id: 'life', label: 'LIFE', items: [
    { id: 'life',       label: 'Life',       icon: '◍' },
    { id: 'my-health',  label: 'Health',     icon: '♥', group: 'health' },
    { id: 'home',       label: 'Home',       icon: '⌂', group: 'home' },
    // Not "People": PEOPLE & MEETINGS already has the work one.
    { id: 'family',     label: 'Family & friends', icon: '❦' },
    { id: 'outdoor',    label: 'Outdoor',    icon: '⛰', group: 'outdoor' },
    { id: 'money',      label: 'Money & car', icon: '£' },
    { id: 'leisure',    label: 'Leisure & projects', icon: '♪' },
    // nick@ / contact@ newest first — separate from the work Inbox (12 Oct 2026).
    { id: 'personal-inbox', label: 'Personal inbox', icon: '✉' },
    { id: 'journal',    label: 'Journal',    icon: '>' },
    // Life loops (3 Nov 2026): letters + decision look-back; logbook + Choose for me.
    { id: 'future-me',  label: 'Future me',  icon: '✉' },
    { id: 'choose',     label: 'Choose for me', icon: '◇' },
    { id: 'about-me',   label: 'About me',   icon: '◍' },
  ] },
  { id: 'people', label: 'PEOPLE & MEETINGS', items: [
    { id: 'people',       label: 'People',       icon: '>' },
    { id: 'calendar',     label: 'Calendar',     icon: '>' },
    { id: 'meeting-prep', label: 'Meeting Prep', icon: '>' },
    // The running list to raise with Chris (3 Nov 2026) — its own page; open items still print in the Monday report.
    { id: 'chris',        label: 'To discuss with Chris', icon: '>' },
    { id: 'overtime',     label: 'Overtime',     icon: '>' },
  ] },
  { id: 'work', label: 'WORK', items: [
    { id: 'dashboard',   label: 'Review',          icon: '⬡' },
    { id: 'inbox',       label: 'Inbox',           icon: '>' },
    { id: 'escalations', label: 'Escalations',     icon: '▲' },
    // 'standup' is the editor; 'standups' the read-only history. Both rituals
    // keep a door of their own (they were once reachable only from a nudge).
    { id: 'standup',     label: 'Standup',         icon: '✎' },
    { id: 'eod',         label: 'End of day',      icon: '✓' },
    { id: 'standups',    label: 'Standup history', icon: '>' },
  ] },
  { id: 'reports', label: 'REPORTS', items: [
    // The 08:00 daily and the Monday weekly briefing (12 Oct 2026).
    { id: 'briefings',      label: 'Briefings',      icon: '☀' },
    // The Monday report to Chris — a deadline and a named recipient.
    { id: 'weekly-risk',    label: 'Weekly Risk',    icon: '▲' },
    // The Monday debrief for Ricky and Chris — emailed only when Nick is off (15 Oct 2026).
    { id: 'soap',           label: 'SOAP report',    icon: '◆' },
    // Fixes that reach the SOAP and Weekly Risk reports; the vault is the master (23 Oct 2026).
    { id: 'fixes-log',      label: 'Fixes log',      icon: '✓' },
    // A running record, logged the day it happens (Nick, 7 Sep 2026).
    { id: 'management-log', label: 'Management Log', icon: '▤' },
  ] },
  { id: 'knowledge', label: 'KNOWLEDGE', items: [
    { id: 'vault',        label: 'Vault',        icon: '>' },
    { id: 'brain-health', label: 'Brain Health', icon: '⋈' },
    { id: 'plaud-transcripts', label: 'PLAUD transcripts', icon: '≋' },
    { id: 'insights',     label: 'Insights',     icon: '◈' },
    { id: 'decisions',    label: 'Decisions',    icon: '>' },
    { id: 'imports',      label: 'Imports',      icon: '>' },
    { id: 'recent',       label: 'Recent',       icon: '>' },
  ] },
  { id: 'system', label: 'SYSTEM', items: [
    // Sources reads SourceHealth; Findings is what the evaluators noticed and
    // what attention decided. Both are deep NEURO, never SAiM.
    // What has not been set up yet, per device, judged from evidence.
    // Build 15D: "what has NEURO done?" — one semantic timeline, first in SYSTEM.
    { id: 'activity',     label: 'Activity',      icon: '≡' },
    { id: 'setup',        label: 'Set up',        icon: '✓' },
    { id: 'sources',      label: 'Sources',       icon: '◎' },
    // Reminder lists, calendar classifications, coverage — moved off Life.
    { id: 'life-sources', label: 'Life sources',  icon: '◎' },
    { id: 'findings',     label: 'Findings',      icon: '◇' },
    { id: 'state',        label: 'State of Play', icon: '◈' },
    // Label only — the view id stays pi-health so deep links keep working.
    { id: 'pi-health',    label: 'NEURO Health',  icon: '▚' },
    { id: 'screen-usage', label: 'Screen Usage',  icon: '▦' },
    // Notion Sync lives inside Settings (Nick, 3 Sep 2026); do not re-add it
    // here without moving the panel out of AdminPanel.
    { id: 'admin',        label: 'Settings',      icon: '>' },
  ] },
];

const GROUP_OF = new Map(GROUPS.flatMap((g) => g.items.flatMap((i) => [
  [i.id, g.id],
  ...(i.group ? VIEW_GROUPS[i.group].map((t) => [t.id, g.id]) : []),
])));

// Option B (Brief 003): when the `saim_desktop_workspace` switch is on, SAiM
// leads the primary row and Now stays right beneath it as the fallback.
// The SAiM entry wears her mark and wordmark (6 Nov 2026, Nick's mockup).
const SAIM_ITEM = {
  id: 'saim',
  // The menu's own font and size (Nick, 6 Nov 2026); her colours: white letters,
  // blue i — selected or not. The brand lettering lives on the SAiM page header.
  label: <span className="sidebar-saim" aria-label="SAiM">SA<span className="brand-word__i">i</span>M</span>,
  icon: <SaimMark width={14} />,
};

function readOpenGroups() {
  try { return JSON.parse(localStorage.getItem('sidebar_groups_open') || '{}') || {}; } catch { return {}; }
}

export default function Sidebar({ activeView, onNavigate, open, saimWorkspace = false }) {
  const [workOnly] = useWorkOnly();
  const [importsCount, setImportsCount] = useState(0);
  const [actionsCount, setActionsCount] = useState(0);
  const [nextCount, setNextCount] = useState(0);
  const [actionsTitle, setActionsTitle] = useState('');
  const [escCount, setEscCount] = useState(0);
  const [escTitle, setEscTitle] = useState('');
  const [inboxCount, setInboxCount] = useState(0);
  const [couldDoCount, setCouldDoCount] = useState(0);
  // Queues that wait on Nick's press (7 Nov 2026, Nick: anything not badged
  // depends on him remembering to go and look). Same honesty as the rest: a
  // failed read keeps the last number, never shows 0.
  const [draftsCount, setDraftsCount] = useState(0);
  const [triageCount, setTriageCount] = useState(0);
  const [bookCount, setBookCount] = useState(0);
  const [overtimeCount, setOvertimeCount] = useState(0);
  // Microsoft sign-in due or expired (27 Oct 2026): a menu button, not a banner
  // (Nick's call). Null = could not ask, which shows nothing rather than a guess.
  const [msSignIn, setMsSignIn] = useState(null);

  const [openGroups, setOpenGroups] = useState(readOpenGroups);

  const toggleGroup = (id) => {
    setOpenGroups(prev => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem('sidebar_groups_open', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // The group holding the active view is always open — a highlighted item
  // inside a collapsed group is a screen you cannot see you are on.
  useEffect(() => {
    const g = GROUP_OF.get(activeView);
    if (g) setOpenGroups(prev => (prev[g] ? prev : { ...prev, [g]: true }));
  }, [activeView]);

  useEffect(() => {
    // The heavier reads (the whole task list, a NOVA bridge call, every draft's
    // view) run every fifth minute, not every minute. The first pass runs all.
    let tick = 0;
    function fetchCounts() {
      const slow = tick % 5 === 0;
      tick += 1;
      fetch(apiUrl('/api/imports/pending'))
        .then(res => res.json())
        .then(data => setImportsCount(data.count || 0))
        .catch(() => {});

      // Unseen escalations + pending-rejection tickets, and unread inbox mail.
      // A failed read keeps the last number rather than showing 0.
      fetch(apiUrl('/api/escalation/counts'))
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data && typeof data.unseen === 'number') { setEscCount(data.unseen); setEscTitle(`${data.escalations} escalation${data.escalations === 1 ? '' : 's'} waiting on you · ${data.rejections} rejection${data.rejections === 1 ? '' : 's'} not opened · ${data.sentiment ?? 0} angry customer${data.sentiment === 1 ? '' : 's'} not opened`); } })
        .catch(() => {});

      fetch(apiUrl('/api/next-steps'))
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (!data) return;
          if (data.counts && typeof data.counts.work === 'number') setNextCount(data.counts.work);
          else if (typeof data.count === 'number') setNextCount(data.count);
        })
        .catch(() => {});

      fetch(apiUrl('/api/email/unseen-count'))
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data && typeof data.unseen === 'number') setInboxCount(data.unseen); })
        .catch(() => {});

      // Open capability suggestions waiting for a yes/no. Unreadable keeps the last number.
      fetch(apiUrl('/api/setup/capabilities'))
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data && data.known !== false && Array.isArray(data.open)) setCouldDoCount(data.open.length); })
        .catch(() => {});

      fetch(apiUrl('/api/microsoft/signin'))
        .then(res => (res.ok ? res.json() : null))
        .then(data => setMsSignIn(data))
        .catch(() => {});

      // The badge is the discovery mechanism: a queued draft reply is invisible
      // otherwise, and it was for a day. pendingTotal, not pending.length —
      // the list itself is capped and the badge must not inherit that cap.
      //
      // ⚠ ONE QUEUE, ONE NUMBER (Build 9). The Actions screen holds two stores —
      // the legacy queue (navigation shortcuts, internal suggestions) and the
      // governed drafts every outbound email now is — and this badge counted
      // the legacy one alone, so a prepared weekly-risk report raised no number
      // on the one control whose job is "something needs you". Both are summed;
      // a store that could not be read contributes nothing rather than a guess,
      // and the title says which parts answered.
      Promise.allSettled([
        fetch(apiUrl('/api/actions')).then(res => res.json()),
        fetch(apiUrl('/api/prepared-actions?limit=1')).then(res => res.json()),
      ]).then(([legacy, governed]) => {
        // People: NOVA's "1-2-1s to book" — the same filter the People board's list uses,
        // read off this same response (live rows are always included), so no extra call.
        if (governed.status === 'fulfilled' && Array.isArray(governed.value.actions)) {
          setBookCount(governed.value.actions.filter(a => a && a.status === 'prepared' && a.actionType === 'create_calendar_event' && a.origin === '1to1-book').length);
        }
        const l = legacy.status === 'fulfilled'
          ? (legacy.value.pendingTotal ?? (legacy.value.pending || []).length) : null;
        const ny = governed.status === 'fulfilled' ? governed.value.needsYou : null;
        const g = ny && ny.known ? (ny.needsApproval || 0) + (ny.needsReview || 0) : null;
        if (l === null && g === null) return;
        setActionsCount((l || 0) + (g || 0));
        setActionsTitle([
          g === null ? 'drafted emails: could not check' : `${g} drafted email${g === 1 ? '' : 's'} to approve or check`,
          l === null ? 'other actions: could not check' : `${l} other pending`,
        ].join(' · '));
      });

      if (slow) {
        // Drafts: prepared moves waiting on his answer or confirmation (held ones cannot be acted on).
        fetch(apiUrl('/api/prepared-moves/drafts'))
          .then(res => (res.ok ? res.json() : null))
          .then(data => {
            const confirm = data && data.ok && data.sections && Array.isArray(data.sections.confirm) ? data.sections.confirm : null;
            if (confirm) setDraftsCount(confirm.filter(r => r && r.status !== 'held').length);
          })
          .catch(() => {});

        // Tasks: how many still need triage (the "Triage (N)" button inside Tasks).
        fetch(apiUrl('/api/todos'))
          .then(res => (res.ok ? res.json() : null))
          .then(data => { if (data && typeof data.triageCount === 'number') setTriageCount(data.triageCount); })
          .catch(() => {});

        // Overtime: claims agents submitted that wait for Nick's decision. His own
        // claims are Chris's to approve (they ride in the sign-off email), so they
        // are not counted — the same split the Overtime screen makes.
        Promise.all([
          fetch(apiUrl('/api/overtime-claims?status=submitted')).then(res => (res.ok ? res.json() : null)),
          fetch(apiUrl('/api/overtime-claims/signoff')).then(res => (res.ok ? res.json() : null)).catch(() => null),
        ]).then(([data, so]) => {
          if (!data || !data.ok || !Array.isArray(data.claims)) return;
          const me = so && so.me ? String(so.me).toLowerCase() : null;
          setOvertimeCount(data.claims.filter(c => !me || String((c && c.agentEmail) || '').toLowerCase() !== me).length);
        }).catch(() => {});
      }
    }

    fetchCounts();
    const interval = setInterval(fetchCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  // The newer queue badges, by item id. `n` is shown only when above zero.
  const QUEUE_BADGES = {
    drafts: { n: draftsCount, title: 'Drafts waiting on your answer or confirmation' },
    todos: { n: triageCount, title: 'Tasks still to triage (MoSCoW, priority, estimate, due date, origin)' },
    people: { n: bookCount, title: '1-2-1s NOVA asked to book — one tap sends each invite' },
    overtime: { n: overtimeCount, title: 'Overtime claims waiting for your decision' },
  };
  // A collapsed group still says something in it is waiting on him.
  const groupBadge = (group) => group.items.reduce((sum, item) => sum + ((QUEUE_BADGES[item.id] && QUEUE_BADGES[item.id].n) || 0), 0);

  const renderItem = (item) => (
    <button
      key={item.id}
      className={[
        'sidebar-item',
        item.primary ? 'sidebar-item-primary' : '',
        activeView === item.id || (item.group && groupOfView(activeView) === item.group) ? 'active' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onNavigate(item.id)}
    >
      <span className="sidebar-icon">{item.icon}</span>
      <span className="sidebar-label">
        {item.label}
        {item.id === 'imports' && importsCount > 0 && (
          <span className="sidebar-badge">{importsCount}</span>
        )}
        {item.id === 'next-steps' && nextCount > 0 && (
          <span className="sidebar-badge" title="Work things pending in Next steps (Life and snoozed ones not counted)">{nextCount > 99 ? '99+' : nextCount}</span>
        )}
        {item.id === 'actions' && actionsCount > 0 && (
          /* 930 does not fit a badge and 930 is the real number, so say "lots"
             rather than either lying or breaking the row. */
          <span className="sidebar-badge" title={actionsTitle || undefined}>{actionsCount > 99 ? '99+' : actionsCount}</span>
        )}
        {item.id === 'escalations' && escCount > 0 && (
          <span className="sidebar-badge" title={escTitle || undefined}>{escCount > 99 ? '99+' : escCount}</span>
        )}
        {item.id === 'could-do' && couldDoCount > 0 && (
          <span className="sidebar-badge" title="Suggestions waiting for a yes or no">{couldDoCount}</span>
        )}
        {item.id === 'inbox' && inboxCount > 0 && (
          <span className="sidebar-badge" title="Unread in Outlook and not dealt with here">{inboxCount > 99 ? '99+' : inboxCount}</span>
        )}
        {QUEUE_BADGES[item.id] && QUEUE_BADGES[item.id].n > 0 && (
          <span className="sidebar-badge" title={QUEUE_BADGES[item.id].title}>{QUEUE_BADGES[item.id].n > 99 ? '99+' : QUEUE_BADGES[item.id].n}</span>
        )}

      </span>
    </button>
  );

  return (
    <nav className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-nav">
        {/* Primary: Now / Capture / Ask / Actions / Commitments */}
        <div className="sidebar-group sidebar-group-primary">
          {msSignIn && msSignIn.showInMenu && (
            <button
              className={[
                'sidebar-item', 'sidebar-item-primary', 'sidebar-signin',
                msSignIn.state === 'expired' ? 'sidebar-signin-expired' : 'sidebar-signin-due',
                activeView === 'microsoft-signin' ? 'active' : '',
              ].filter(Boolean).join(' ')}
              title={msSignIn.say || undefined}
              onClick={() => onNavigate('microsoft-signin')}
            >
              <span className="sidebar-icon">⚠</span>
              <span className="sidebar-label">
                Sign in to Microsoft
                <span className="sidebar-signin-state">{msSignIn.state === 'expired' ? 'expired' : 'due'}</span>
              </span>
            </button>
          )}
          {[...(saimWorkspace ? [SAIM_ITEM] : []), ...PRIMARY_ITEMS].map(item => renderItem({ ...item, primary: true }))}
        </div>

        {GROUPS.filter((g) => !(workOnly && WORK_ONLY_HIDDEN_GROUPS.has(g.id))).map(group => (
          <div className="sidebar-group" key={group.id}>
            <button
              className="sidebar-group-header sidebar-group-toggle"
              onClick={() => toggleGroup(group.id)}
              aria-expanded={!!openGroups[group.id]}
            >
              <span className="sidebar-group-label">{group.label}</span>
              {!openGroups[group.id] && groupBadge(group) > 0 && (
                <span className="sidebar-badge" title="Something in here is waiting on you">{groupBadge(group) > 99 ? '99+' : groupBadge(group)}</span>
              )}
              <span className="sidebar-group-chevron">{openGroups[group.id] ? '▾' : '▸'}</span>
            </button>
            {openGroups[group.id] && group.items.filter((item) => !(workOnly && WORK_ONLY_HIDDEN_ITEMS.has(item.id))).map(item => renderItem(item))}
          </div>
        ))}
      </div>
    </nav>
  );
}
