import React, { useState, useCallback } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './NinetyDayPlan.css';

const OUTCOME_ICONS = {
  1: '📊', 2: '🔀', 3: '✨', 4: '👥', 5: '🤝', 6: '🏭'
};

export default function NinetyDayPlan() {
  const { data: plan, refresh } = useCachedFetch('/api/obsidian/ninety-day-plan');
  const [expandedOutcome, setExpandedOutcome] = useState(null);
  const [toggling, setToggling] = useState(null); // lineNumber being toggled

  const toggleTask = useCallback(async (task) => {
    if (toggling) return;
    setToggling(task.lineNumber);
    try {
      const res = await fetch(apiUrl('/api/todos/toggle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: plan.filePath,
          lineNumber: task.lineNumber - 1  // API expects 0-based
        })
      });
      if (res.ok) refresh();
    } catch (e) {
      console.error('Toggle failed:', e);
    } finally {
      setToggling(null);
    }
  }, [plan, toggling, refresh]);

  if (!plan) return <div className="plan-container"><p className="plan-loading">Loading plan…</p></div>;

  const progress = Math.min(100, (plan.currentDay / plan.totalDays) * 100);

  return (
    <div className="plan-container">
      {/* Header */}
      <div className="plan-header">
        <h2 className="plan-title">90-Day Plan</h2>
        <div className="plan-day-badge">
          Day <span className="plan-day-num">{plan.currentDay}</span> / {plan.totalDays}
        </div>
      </div>

      {/* Progress timeline */}
      <div className="plan-timeline">
        <div className="plan-track">
          <div className="plan-fill" style={{ width: `${progress}%` }} />
          <div className="plan-you-marker" style={{ left: `${progress}%` }}>
            <div className="plan-you-dot" />
            <span className="plan-you-label">YOU</span>
          </div>
          {plan.checkpoints.map(cp => {
            const pos = (cp.day / 90) * 100;
            const isPast = plan.currentDay >= cp.day;
            return (
              <div key={cp.day} className={`plan-cp-marker ${isPast ? 'past' : ''}`} style={{ left: `${pos}%` }}>
                <div className="plan-cp-dot" />
                <span className="plan-cp-label">{cp.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Next checkpoint countdown */}
      <div className="plan-checkpoint-card">
        <div className="plan-cp-countdown">
          <span className="plan-cp-num">{plan.daysToCheckpoint}</span>
          <span className="plan-cp-unit">working days</span>
        </div>
        <div className="plan-cp-info">
          <span className="plan-cp-next-label">Next checkpoint: {plan.nextCheckpoint.label}</span>
          <span className="plan-cp-date">{plan.nextCheckpoint.date}</span>
        </div>
        <div className="plan-cp-progress">
          <span className="plan-cp-score">{plan.totalDone}/{plan.totalTasks} tasks done</span>
        </div>
      </div>

      {/* Alerts: overdue + today */}
      {plan.overdueTasks.length > 0 && (
        <div className="plan-alert plan-alert-overdue">
          <span className="plan-alert-icon">⚠️</span>
          <div className="plan-alert-body">
            <strong>{plan.overdueTasks.length} overdue</strong>
            <ul className="plan-alert-list">
              {plan.overdueTasks.map((t, i) => (
                <li key={i} className={`plan-task-toggle ${toggling === t.lineNumber ? 'toggling' : ''}`} onClick={() => toggleTask(t)}>
                  <span className="plan-task-check">{toggling === t.lineNumber ? '⏳' : '○'}</span>
                  <span className="plan-task-day">D{t.day}</span> {t.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {plan.todayTasks.length > 0 && (
        <div className="plan-alert plan-alert-today">
          <span className="plan-alert-icon">🎯</span>
          <div className="plan-alert-body">
            <strong>Today — Day {plan.currentDay}</strong>
            <ul className="plan-alert-list">
              {plan.todayTasks.map((t, i) => (
                <li key={i} className={`plan-task-toggle ${t.status === 'x' ? 'done' : ''} ${toggling === t.lineNumber ? 'toggling' : ''}`} onClick={() => toggleTask(t)}>
                  <span className="plan-task-check">{toggling === t.lineNumber ? '⏳' : t.status === 'x' ? '✓' : '○'}</span>
                  {t.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* This week focus */}
      {plan.thisWeekTasks.length > 0 && (
        <div className="plan-week-card">
          <h3 className="plan-week-title">This Week</h3>
          <ul className="plan-week-list">
            {plan.thisWeekTasks.map((t, i) => (
              <li key={i} className={`plan-week-item plan-task-toggle ${t.status === '>' ? 'slipped' : ''} ${toggling === t.lineNumber ? 'toggling' : ''}`} onClick={() => toggleTask(t)}>
                <span className="plan-task-check">{toggling === t.lineNumber ? '⏳' : '○'}</span>
                <span className="plan-task-day">D{t.day}</span>
                {t.outcome && <span className="plan-outcome-dot" style={{ background: plan.outcomes[t.outcome]?.color }} />}
                <span className="plan-task-text">{t.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 6 outcome cards */}
      <div className="plan-outcomes">
        {Object.entries(plan.outcomes).map(([id, o]) => {
          const pct = o.total > 0 ? Math.round((o.done / o.total) * 100) : 0;
          const isExpanded = expandedOutcome === id;
          return (
            <div
              key={id}
              className={`plan-outcome-card ${isExpanded ? 'expanded' : ''}`}
              style={{ borderLeftColor: o.color }}
              onClick={() => setExpandedOutcome(isExpanded ? null : id)}
            >
              <div className="plan-outcome-header">
                <span className="plan-outcome-icon">{OUTCOME_ICONS[id]}</span>
                <span className="plan-outcome-name">{o.name}</span>
                <span className="plan-outcome-count">{o.done}/{o.total}</span>
              </div>
              <div className="plan-outcome-bar-bg">
                <div className="plan-outcome-bar-fill" style={{ width: `${pct}%`, background: o.color }} />
              </div>
              {isExpanded && o.tasks.length > 0 && (
                <ul className="plan-outcome-tasks">
                  {o.tasks.map((t, i) => (
                    <li key={i} className={`plan-ot plan-task-toggle ${t.status === 'x' ? 'done' : t.day < plan.currentDay && t.status !== 'x' ? 'overdue' : ''} ${toggling === t.lineNumber ? 'toggling' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleTask(t); }}>
                      <span className="plan-task-check">
                        {toggling === t.lineNumber ? '⏳' : t.status === 'x' ? '✓' : t.status === '>' ? '→' : t.status === '/' ? '◐' : '○'}
                      </span>
                      <span className="plan-task-day">D{t.day}</span>
                      <span className="plan-ot-text">{t.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
