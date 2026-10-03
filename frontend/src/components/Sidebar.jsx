import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './Sidebar.css';

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
  { id: 'capture',     label: 'Capture',     icon: '+' },
  { id: 'chat',        label: 'Ask',         icon: '›' },
  { id: 'actions',     label: 'Actions',     icon: '✓' },
  { id: 'commitments', label: 'Commitments', icon: '⇄' },
];

// Groups, in order. Each id appears exactly once across PRIMARY and GROUPS.
// ⚠ Retired ids (briefing, focus, qa, strava, kpi-tracker) are NOT here; they
// still route via viewIds.canonicalView so old links land somewhere real.
const GROUPS = [
  { id: 'life', label: 'LIFE', items: [
    { id: 'life',       label: 'Life',       icon: '◍' },
    // Tasks span every domain (work | personal), so they sit under Life.
    { id: 'todos',      label: 'Tasks',      icon: '☑' },
    { id: 'health',     label: 'My Health',  icon: '♥' },
    { id: 'journal',    label: 'Journal',    icon: '>' },
    { id: 'catalogues', label: 'Catalogues', icon: '▤' },
    { id: 'about-me',   label: 'About me',   icon: '◍' },
  ] },
  { id: 'people', label: 'PEOPLE & MEETINGS', items: [
    { id: 'people',       label: 'People',       icon: '>' },
    { id: 'calendar',     label: 'Calendar',     icon: '>' },
    { id: 'meeting-prep', label: 'Meeting Prep', icon: '>' },
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
    // The Monday report to Chris — a deadline and a named recipient.
    { id: 'weekly-risk',    label: 'Weekly Risk',    icon: '▲' },
    // A running record, logged the day it happens (Nick, 7 Sep 2026).
    { id: 'management-log', label: 'Management Log', icon: '▤' },
  ] },
  { id: 'knowledge', label: 'KNOWLEDGE', items: [
    { id: 'vault',        label: 'Vault',        icon: '>' },
    { id: 'brain-health', label: 'Brain Health', icon: '⋈' },
    { id: 'insights',     label: 'Insights',     icon: '◈' },
    { id: 'decisions',    label: 'Decisions',    icon: '>' },
    { id: 'imports',      label: 'Imports',      icon: '>' },
    { id: 'recent',       label: 'Recent',       icon: '>' },
  ] },
  { id: 'system', label: 'SYSTEM', items: [
    // Sources reads SourceHealth; Findings is what the evaluators noticed and
    // what attention decided. Both are deep NEURO, never SAiM.
    { id: 'sources',      label: 'Sources',       icon: '◎' },
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

const GROUP_OF = new Map(GROUPS.flatMap((g) => g.items.map((i) => [i.id, g.id])));

function readOpenGroups() {
  try { return JSON.parse(localStorage.getItem('sidebar_groups_open') || '{}') || {}; } catch { return {}; }
}

export default function Sidebar({ activeView, onNavigate, open }) {
  const [importsCount, setImportsCount] = useState(0);
  const [actionsCount, setActionsCount] = useState(0);
  const [actionsTitle, setActionsTitle] = useState('');

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
    function fetchCounts() {
      fetch(apiUrl('/api/imports/pending'))
        .then(res => res.json())
        .then(data => setImportsCount(data.count || 0))
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
    }

    fetchCounts();
    const interval = setInterval(fetchCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  const renderItem = (item) => (
    <button
      key={item.id}
      className={[
        'sidebar-item',
        item.primary ? 'sidebar-item-primary' : '',
        activeView === item.id ? 'active' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onNavigate(item.id)}
    >
      <span className="sidebar-icon">{item.icon}</span>
      <span className="sidebar-label">
        {item.label}
        {item.id === 'imports' && importsCount > 0 && (
          <span className="sidebar-badge">{importsCount}</span>
        )}
        {item.id === 'actions' && actionsCount > 0 && (
          /* 930 does not fit a badge and 930 is the real number, so say "lots"
             rather than either lying or breaking the row. */
          <span className="sidebar-badge" title={actionsTitle || undefined}>{actionsCount > 99 ? '99+' : actionsCount}</span>
        )}

      </span>
    </button>
  );

  return (
    <nav className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-nav">
        {/* Primary: Now / Capture / Ask / Actions / Commitments */}
        <div className="sidebar-group sidebar-group-primary">
          {PRIMARY_ITEMS.map(item => renderItem({ ...item, primary: true }))}
        </div>

        {GROUPS.map(group => (
          <div className="sidebar-group" key={group.id}>
            <button
              className="sidebar-group-header sidebar-group-toggle"
              onClick={() => toggleGroup(group.id)}
              aria-expanded={!!openGroups[group.id]}
            >
              <span className="sidebar-group-label">{group.label}</span>
              <span className="sidebar-group-chevron">{openGroups[group.id] ? '▾' : '▸'}</span>
            </button>
            {openGroups[group.id] && group.items.map(item => renderItem(item))}
          </div>
        ))}
      </div>
    </nav>
  );
}
