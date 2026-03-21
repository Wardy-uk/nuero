import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './Sidebar.css';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '>' },
  { id: 'capture', label: 'Capture', icon: '+' },
  { id: 'recent', label: 'Recent', icon: '>' },
  { id: 'standup', label: 'Standup', icon: '>' },
  { id: 'people', label: 'Team / People', icon: '>' },
  { id: 'queue', label: 'KPI / Queue', icon: '>' },
  { id: 'todos', label: 'Todos', icon: '>' },
  { id: 'calendar', label: 'Calendar', icon: '>' },
  { id: 'vault', label: 'Vault', icon: '>' },
  { id: 'imports', label: 'Imports', icon: '>' },
  { id: 'inbox', label: 'Inbox Triage', icon: '>' },
  { id: 'plan', label: '90-Day Plan', icon: '>' },
  { id: 'qa', label: 'QA Dashboard', icon: '>' },
  { id: 'admin', label: 'Settings', icon: '>' },
];

export default function Sidebar({ activeView, onNavigate, open }) {
  const [importsCount, setImportsCount] = useState(0);

  useEffect(() => {
    fetch(apiUrl('/api/imports/pending'))
      .then(res => res.json())
      .then(data => setImportsCount(data.count || 0))
      .catch(() => {});

    const interval = setInterval(() => {
      fetch(apiUrl('/api/imports/pending'))
        .then(res => res.json())
        .then(data => setImportsCount(data.count || 0))
        .catch(() => {});
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <nav className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-nav">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`sidebar-item ${activeView === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">
              {item.label}
              {item.id === 'imports' && importsCount > 0 && (
                <span className="sidebar-badge">{importsCount}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
