import React, { useState } from 'react';
import useCachedFetch from '../useCachedFetch';
import { apiUrl } from '../api';
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
  email: '✉',
};

const TIER_LABELS = {
  1: 'ACT NOW',
  2: 'DO NEXT',
  3: 'LATER',
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

export default function FocusPanel({ onNavigate }) {
  const [showAll, setShowAll] = useState(false);
  const { data, status, refresh } = useCachedFetch(
    showAll ? '/api/focus?all=true' : '/api/focus',
    { interval: 30000 }
  );

  const items = data?.items || [];
  const context = data?.context || {};
  const suppressed = data?.suppressed || 0;
  const totalCandidates = data?.totalCandidates || 0;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Morning';
    if (h < 17) return 'Afternoon';
    return 'Evening';
  })();

  const handleDismiss = async (e, item) => {
    e.stopPropagation();
    try {
      await fetch(apiUrl('/api/focus/dismiss'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, itemType: item.type }),
      });
      refresh();
    } catch {}
  };

  const handleNavigate = (item) => {
    // Pass context so drill-down views know they came from Focus and can show prioritised shortlist
    const ctx = { fromFocus: true, focusItem: item };
    if (item.type === 'jira_ticket' || item.type === 'escalation') {
      onNavigate?.('queue', { ...ctx, filter: 'at-risk' });
    } else if (item.type === 'meeting') {
      onNavigate?.('calendar');
    } else if (item.type === 'todo') {
      const filter = item.id?.includes('overdue') ? 'overdue' : item.id?.includes('today') ? 'today' : 'all';
      onNavigate?.('todos', { ...ctx, filter });
    } else if (item.type === 'nudge' && item.meta?.type === 'standup') {
      onNavigate?.('standup');
    } else if (item.type === 'nudge' && item.meta?.type === 'eod') {
      onNavigate?.('standup');
    } else if (item.type === 'imports') {
      onNavigate?.('imports');
    } else if (item.type === 'email') {
      onNavigate?.('inbox', { ...ctx, filter: 'urgent' });
    }
  };

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
              className={[
                'focus-item',
                `focus-urgency-${item.urgency || 'low'}`,
                item.primary ? 'focus-item-primary' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => handleNavigate(item)}
            >
              <div className="focus-item-left">
                <span className="focus-item-icon">{TYPE_ICONS[item.type] || '·'}</span>
                <div className="focus-item-content">
                  {item.primary && <div className="focus-primary-label">Start here</div>}
                  <div className="focus-item-title">{item.title}</div>
                  <div className="focus-item-reason">{item.reason}</div>
                </div>
              </div>
              <div className="focus-item-right">
                {item.tier && !item.primary && (
                  <span className={`focus-tier-badge focus-tier-${item.tier}`}>
                    {TIER_LABELS[item.tier] || ''}
                  </span>
                )}
                <span className={`focus-urgency-badge focus-urgency-${item.urgency || 'low'}`}>
                  {URGENCY_LABELS[item.urgency] || ''}
                </span>
                {!showAll && (
                  <button
                    className="focus-dismiss-btn"
                    onClick={(e) => handleDismiss(e, item)}
                    title="Dismiss for 30 min"
                  >×</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Suppression summary + view all toggle */}
      <div className="focus-footer">
        {suppressed > 0 && !showAll && (
          <button
            className="focus-view-all"
            onClick={() => setShowAll(true)}
          >
            +{suppressed} more hidden
          </button>
        )}
        {showAll && totalCandidates > 0 && (
          <button
            className="focus-view-all"
            onClick={() => setShowAll(false)}
          >
            Show focused only
          </button>
        )}
        {data?.generatedAt && (
          <span className="focus-footer-time">
            Updated {timeAgo(data.generatedAt)}
          </span>
        )}
      </div>
    </div>
  );
}
