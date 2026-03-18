import React from 'react';
import './Sidebar.css';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '>' },
  { id: 'standup', label: 'Standup', icon: '>' },
  { id: 'people', label: 'Team / People', icon: '>' },
  { id: 'queue', label: 'KPI / Queue', icon: '>' },
  { id: 'todos', label: 'Todos', icon: '>' },
  { id: 'calendar', label: 'Calendar', icon: '>' },
  { id: 'inbox', label: 'Inbox Triage', icon: '>' },
  { id: 'plan', label: '90-Day Plan', icon: '>' },
  { id: 'qa', label: 'QA Dashboard', icon: '>' },
  { id: 'admin', label: 'Settings', icon: '>' },
];

export default function Sidebar({ activeView, onNavigate }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-nav">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`sidebar-item ${activeView === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
