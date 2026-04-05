import React, { useState } from 'react';
import useCachedFetch from '../useCachedFetch';
import { apiUrl } from '../api';
import './FocusPanel.css';

const TYPE_ICONS = {
  escalation: '!!',
  jira_ticket: '#',
  meeting: '@',
  todo: '[ ]',
  nudge: '~',
  imports: '>',
  email: '✉',
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
  const sara = data?.sara || null;
  const tone = data?.tone || 'focused';
  const suggestions = data?.suggestions || [];
  const [actionLoading, setActionLoading] = useState(null);

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
    const ctx = { fromFocus: true, focusItem: item };
    if (item.type === 'jira_ticket' || item.type === 'escalation') {
      onNavigate?.('queue', { ...ctx, filter: 'at-risk' });
    } else if (item.type === 'meeting') {
      onNavigate?.('meeting-prep');
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

  // Find AI guidance for a specific item
  const getItemGuidance = (item) => {
    if (!sara?.items) return null;
    return sara.items.find(ai => ai.id === item.id) || null;
  };

  return (
    <div className="focus-panel">
      <div className="focus-header">
        <div className="focus-header-left">
          <h1 className="focus-title">{greeting}</h1>
          <div className="focus-meta">
            {context.standupDone === false && (
              <span className="focus-meta-tag focus-meta-warn">Standup pending</span>
            )}
            {context.queueTotal > 0 && (
              <span className="focus-meta-tag">{context.queueTotal} tickets</span>
            )}
            {status === 'cached' && (
              <span className="focus-meta-tag focus-meta-stale">cached</span>
            )}
          </div>
        </div>
        <button className="focus-refresh" onClick={refresh} title="Refresh">↻</button>
      </div>

      {/* ── SARA Says block ── */}
      {sara?.primary && !showAll && (
        <div className={`sara-says sara-tone-${tone}`}>
          <div className="sara-says-header">
            <span className="sara-says-label">SARA</span>
          </div>
          <div className="sara-says-message">{sara.primary.message}</div>
          {sara.primary.action && (
            <div className="sara-says-action">{sara.primary.action}</div>
          )}
          {sara.ignore && (
            <div className="sara-says-ignore">{sara.ignore}</div>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="focus-empty">
          <div className="focus-empty-icon">✓</div>
          <div className="focus-empty-text">Nothing urgent right now.</div>
          <div className="focus-empty-sub">Your queue, calendar, and todos are clear.</div>
        </div>
      ) : (
        <ul className="focus-list">
          {items.map((item, i) => {
            const guidance = getItemGuidance(item);
            return (
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
                    <div className="focus-item-title">{item.title}</div>
                    {/* AI-enhanced reason, or fall back to deterministic */}
                    <div className="focus-item-reason">
                      {guidance?.why || item.reason}
                    </div>
                    {/* AI action suggestion */}
                    {guidance?.action && (
                      <div className="focus-item-action">{guidance.action}</div>
                    )}
                  </div>
                </div>
                <div className="focus-item-right">
                  {!showAll && (
                    <button
                      className="focus-dismiss-btn"
                      onClick={(e) => handleDismiss(e, item)}
                      title="Dismiss for 30 min"
                    >×</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── SARA Suggests block ── */}
      {suggestions.length > 0 && !showAll && (
        <div className="sara-suggests">
          <div className="sara-suggests-header">
            <span className="sara-says-label">NEXT</span>
          </div>
          {suggestions.map((s, idx) => (
            <div key={s.id} className={`sara-suggestion ${idx === 0 ? 'sara-suggestion-primary' : ''} ${actionLoading === s.id ? 'sara-suggestion-loading' : ''}`}>
              <div className="sara-suggestion-content">
                <div className="sara-suggestion-reason">{s.reason}</div>
              </div>
              <div className="sara-suggestion-actions">
                <button
                  className={idx === 0 ? 'sara-do-btn' : 'sara-approve-btn'}
                  disabled={actionLoading === s.id}
                  onClick={async () => {
                    setActionLoading(s.id);
                    try {
                      const r = await fetch(apiUrl(`/api/actions/${s.id}/approve`), { method: 'POST' });
                      const result = await r.json();
                      if (result.ok) {
                        // Open external URL if provided (e.g. Jira ticket)
                        if (result.url) {
                          window.open(result.url, '_blank');
                        }
                        // Navigate to the target view
                        if (result.navigate && onNavigate) {
                          onNavigate(result.navigate, result.navigateContext || { fromFocus: true });
                        } else {
                          // No navigation — just refresh Focus to show next action
                          window.setTimeout(() => refresh(), 300);
                        }
                      }
                    } catch {}
                    setActionLoading(null);
                  }}
                >{actionLoading === s.id ? '...' : (idx === 0 ? 'Do it' : 'Go')}</button>
                <button
                  className="sara-reject-btn"
                  disabled={actionLoading === s.id}
                  onClick={async () => {
                    setActionLoading(s.id);
                    try {
                      await fetch(apiUrl(`/api/actions/${s.id}/reject`), { method: 'POST' });
                      window.setTimeout(() => refresh(), 300);
                    } catch {}
                    setActionLoading(null);
                  }}
                >Skip</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="focus-footer">
        {suppressed > 0 && !showAll && (
          <button className="focus-view-all" onClick={() => setShowAll(true)}>
            +{suppressed} more hidden
          </button>
        )}
        {showAll && totalCandidates > 0 && (
          <button className="focus-view-all" onClick={() => setShowAll(false)}>
            Show focused only
          </button>
        )}
        {data?.generatedAt && (
          <span className="focus-footer-time">
            Updated {timeAgo(data.generatedAt)}
            {sara?.provider && ` · ${sara.provider}`}
          </span>
        )}
      </div>
    </div>
  );
}
