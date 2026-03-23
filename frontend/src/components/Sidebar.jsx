import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './Sidebar.css';

const NAV_GROUPS = [
  {
    id: 'now',
    label: 'NOW',
    items: [
      { id: 'dashboard',  label: 'Dashboard',   icon: '⬡' },
      { id: 'standup',    label: 'Standup',      icon: '◎' },
      { id: 'chat',       label: 'Chat',         icon: '›' },
      { id: 'capture',    label: 'Capture',      icon: '+' },
      { id: 'todos',      label: 'Todos',        icon: '◻' },
    ]
  },
  {
    id: 'work',
    label: 'WORK',
    items: [
      { id: 'people',     label: 'People',       icon: '>' },
      { id: 'queue',      label: 'Queue',        icon: '>' },
      { id: 'calendar',   label: 'Calendar',     icon: '>' },
      { id: 'inbox',      label: 'Inbox',        icon: '>' },
      { id: 'plan',       label: '90-Day Plan',  icon: '>' },
    ]
  },
  {
    id: 'reference',
    label: 'REFERENCE',
    collapsible: true,
    items: [
      { id: 'journal',    label: 'Journal',      icon: '>' },
      { id: 'vault',      label: 'Vault',        icon: '>' },
      { id: 'strava',     label: 'Strava',       icon: '>' },
      { id: 'imports',    label: 'Imports',      icon: '>' },
      { id: 'insights',   label: 'Insights',     icon: '◈' },
      { id: 'qa',         label: 'QA',           icon: '>' },
      { id: 'recent',     label: 'Recent',       icon: '>' },
      { id: 'admin',      label: 'Settings',     icon: '>' },
    ]
  }
];

function useTimeHighlight() {
  const [highlight, setHighlight] = React.useState(null);
  React.useEffect(() => {
    function check() {
      const now = new Date();
      const h = now.getHours();
      const day = now.getDay();
      const isWeekday = day >= 1 && day <= 5;
      if (!isWeekday) { setHighlight(null); return; }
      if (h >= 8 && h < 10) { setHighlight('standup'); return; }
      if (h >= 21 && h < 23) { setHighlight('journal'); return; }
      setHighlight(null);
    }
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);
  return highlight;
}

export default function Sidebar({ activeView, onNavigate, open }) {
  const [importsCount, setImportsCount] = useState(0);
  const [escalationCount, setEscalationCount] = useState(0);

  const [refOpen, setRefOpen] = useState(() => {
    try { return localStorage.getItem('sidebar_ref_open') === 'true'; }
    catch { return false; }
  });

  const toggleRef = () => {
    setRefOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('sidebar_ref_open', String(next)); } catch {}
      return next;
    });
  };

  // Auto-expand Reference if active view is inside it
  useEffect(() => {
    const refIds = NAV_GROUPS.find(g => g.id === 'reference')?.items.map(i => i.id) || [];
    if (refIds.includes(activeView)) setRefOpen(true);
  }, [activeView]);

  useEffect(() => {
    function fetchCounts() {
      fetch(apiUrl('/api/imports/pending'))
        .then(res => res.json())
        .then(data => setImportsCount(data.count || 0))
        .catch(() => {});

      fetch(apiUrl('/api/jira/escalations/unseen'))
        .then(r => r.json())
        .then(data => setEscalationCount(data.count || 0))
        .catch(() => {});
    }

    fetchCounts();
    const interval = setInterval(fetchCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  const timeHighlight = useTimeHighlight();

  return (
    <nav className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-nav">
        {NAV_GROUPS.map(group => (
          <div key={group.id} className="sidebar-group">
            {group.collapsible ? (
              <button
                className="sidebar-group-header sidebar-group-toggle"
                onClick={toggleRef}
              >
                <span className="sidebar-group-label">{group.label}</span>
                <span className="sidebar-group-chevron">{refOpen ? '▾' : '▸'}</span>
              </button>
            ) : (
              <div className="sidebar-group-header">
                <span className="sidebar-group-label">{group.label}</span>
              </div>
            )}

            {(!group.collapsible || refOpen) && group.items.map(item => (
              <button
                key={item.id}
                className={[
                  'sidebar-item',
                  activeView === item.id ? 'active' : '',
                  timeHighlight === item.id ? 'time-highlight' : ''
                ].filter(Boolean).join(' ')}
                onClick={() => onNavigate(item.id)}
              >
                <span className="sidebar-icon">{item.icon}</span>
                <span className="sidebar-label">
                  {item.label}
                  {item.id === 'imports' && importsCount > 0 && (
                    <span className="sidebar-badge">{importsCount}</span>
                  )}
                  {item.id === 'queue' && escalationCount > 0 && (
                    <span className="sidebar-badge sidebar-badge-red">{escalationCount}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
