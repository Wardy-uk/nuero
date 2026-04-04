import React from 'react';
import useCachedFetch from '../useCachedFetch';
import './FocusPanel.css';

const URGENCY_LABELS = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
};

const TYPE_ICONS = {
  escalation: '!!',
  jira_ticket: '#',
  meeting: '@',
  todo: '[ ]',
  nudge: '~',
  imports: '>',
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

export default function FocusPanel({ onNavigate }) {
  const { data, status, refresh } = useCachedFetch('/api/focus', { interval: 30000 });

  const items = data?.items || [];
  const context = data?.context || {};

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Morning';
    if (h < 17) return 'Afternoon';
    return 'Evening';
  })();

  return (
    <div className="focus-panel">
      <div className="focus-header">
        <div className="focus-header-left">
          <h1 className="focus-title">{greeting} — what matters now</h1>
          <div className="focus-meta">
            {context.standupDone === false && (
              <span className="focus-meta-tag focus-meta-warn">Standup pending</span>
            )}
            {context.queueTotal > 0 && (
              <span className="focus-meta-tag">{context.queueTotal} tickets open</span>
            )}
            {context.planProgress != null && (
              <span className="focus-meta-tag">{Math.round(context.planProgress)}% plan</span>
            )}
            {status === 'cached' && (
              <span className="focus-meta-tag focus-meta-stale">cached</span>
            )}
          </div>
        </div>
        <button className="focus-refresh" onClick={refresh} title="Refresh">↻</button>
      </div>

      {items.length === 0 ? (
        <div className="focus-empty">
          <div className="focus-empty-icon">✓</div>
          <div className="focus-empty-text">Nothing urgent right now.</div>
          <div className="focus-empty-sub">Your queue, calendar, and todos are clear.</div>
        </div>
      ) : (
        <ul className="focus-list">
          {items.map((item, i) => (
            <li
              key={item.id || i}
              className={`focus-item focus-urgency-${item.urgency || 'low'}`}
              onClick={() => {
                if (item.type === 'jira_ticket' || item.type === 'escalation') onNavigate?.('queue');
                else if (item.type === 'meeting') onNavigate?.('calendar');
                else if (item.type === 'todo') onNavigate?.('todos');
                else if (item.type === 'nudge' && item.meta?.type === 'standup') onNavigate?.('standup');
                else if (item.type === 'imports') onNavigate?.('imports');
              }}
            >
              <div className="focus-item-left">
                <span className="focus-item-icon">{TYPE_ICONS[item.type] || '·'}</span>
                <div className="focus-item-content">
                  <div className="focus-item-title">{item.title}</div>
                  <div className="focus-item-reason">{item.reason}</div>
                </div>
              </div>
              <div className="focus-item-right">
                <span className={`focus-urgency-badge focus-urgency-${item.urgency || 'low'}`}>
                  {URGENCY_LABELS[item.urgency] || ''}
                </span>
                {item.actionHint && (
                  <span className="focus-item-hint">{item.actionHint}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {data?.generatedAt && (
        <div className="focus-footer">
          Updated {timeAgo(data.generatedAt)}
        </div>
      )}
    </div>
  );
}
