import React from 'react';
import useCachedFetch from '../useCachedFetch';
import './Dashboard.css';

const START_DATE = new Date('2026-03-16');

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatEventTime(isoStr) {
  return isoStr.split('T')[1]?.substring(0, 5) || '';
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

export default function Dashboard({ queueData, onNavigate }) {
  const today = new Date();
  const dayCount = Math.max(0, Math.floor((today - START_DATE) / (1000 * 60 * 60 * 24)));
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const planFetch = useCachedFetch('/api/obsidian/ninety-day-plan', { interval: 60000 });
  const todoFetch = useCachedFetch('/api/todos', { interval: 30000 });
  const td = todayStr();
  const calFetch = useCachedFetch(`/api/obsidian/calendar?start=${td}&end=${td}`, { interval: 120000 });
  const calEvents = (calFetch.data?.events || []).filter(e => e.showAs !== 'cancelled');

  const plan = planFetch.data;
  const todos = (todoFetch.data?.todos || []).filter(t => !t.done);
  const highTodos = todos.filter(t => t.priority === 'high').slice(0, 3);
  const topTodos = highTodos.length > 0 ? highTodos : todos.slice(0, 3);

  const atRisk = queueData?.at_risk_count ?? 0;
  const queueTotal = queueData?.total ?? 0;
  const p1s = queueData?.open_p1s ?? 0;

  const planPct = plan ? Math.round((plan.totalDone / Math.max(plan.totalTasks, 1)) * 100) : 0;
  const overdue = plan?.overdueTasks?.length ?? 0;

  return (
    <div className="dash">
      {/* Greeting */}
      <div className="dash-greeting">
        <h1 className="dash-hello">{getGreeting()}, Nick.</h1>
        <span className="dash-date">{dateStr} — Day {dayCount}</span>
      </div>

      {/* Stat cards */}
      <div className="dash-stats">
        <div className={`dash-stat ${atRisk > 0 ? 'stat-danger' : ''}`} onClick={() => onNavigate?.('queue')}>
          <span className="stat-val">{queueTotal}</span>
          <span className="stat-lbl">My Queue</span>
          {atRisk > 0 && <span className="stat-sub">{atRisk} at risk</span>}
        </div>

        <div className={`dash-stat ${p1s > 0 ? 'stat-warn' : ''}`} onClick={() => onNavigate?.('queue')}>
          <span className="stat-val">{p1s}</span>
          <span className="stat-lbl">P1s</span>
        </div>

        <div className="dash-stat" onClick={() => onNavigate?.('plan')}>
          <span className="stat-val">{plan ? `${planPct}%` : '-'}</span>
          <span className="stat-lbl">90-Day</span>
          {plan && <span className="stat-sub">Day {plan.currentDay}</span>}
        </div>

        <div className={`dash-stat ${overdue > 0 ? 'stat-warn' : ''}`} onClick={() => onNavigate?.('todos')}>
          <span className="stat-val">{todos.length}</span>
          <span className="stat-lbl">Tasks</span>
          {overdue > 0 && <span className="stat-sub">{overdue} overdue</span>}
        </div>
      </div>

      {/* Today's calendar */}
      {calEvents.length > 0 && (
        <div className="dash-calendar" onClick={() => onNavigate?.('calendar')}>
          <div className="tasks-header">
            <span className="tasks-title">Today</span>
            <button className="tasks-more" onClick={e => { e.stopPropagation(); onNavigate?.('calendar'); }}>Full calendar</button>
          </div>
          {calEvents.slice(0, 5).map((ev, i) => {
            const now = new Date();
            const isCurrent = !ev.isAllDay && now >= new Date(ev.start) && now < new Date(ev.end);
            return (
              <div key={i} className={`dash-cal-event ${isCurrent ? 'cal-now' : ''}`}>
                <span className="cal-ev-time">
                  {ev.isAllDay ? 'All day' : formatEventTime(ev.start)}
                </span>
                <span className="cal-ev-subject">{ev.subject}</span>
                {isCurrent && <span className="cal-ev-now">NOW</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* 90-Day progress bar */}
      {plan && (
        <div className="dash-progress">
          <div className="progress-header">
            <span className="progress-title">90-Day Plan</span>
            <span className="progress-meta">{plan.totalDone}/{plan.totalTasks} done — {plan.nextCheckpoint.label} in {plan.daysToCheckpoint}d</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${planPct}%` }} />
            <div className="progress-marker" style={{ left: `${Math.round((plan.currentDay / 90) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Top tasks */}
      {topTodos.length > 0 && (
        <div className="dash-tasks">
          <div className="tasks-header">
            <span className="tasks-title">Focus</span>
            <button className="tasks-more" onClick={() => onNavigate?.('todos')}>All tasks</button>
          </div>
          {topTodos.map((t, i) => (
            <div key={t.id || i} className={`dash-task ${t.priority === 'high' ? 'task-high' : ''}`}>
              <span className="task-text">{t.text}</span>
              {t.due_date && <span className="task-due">{t.due_date}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Quick actions — mobile */}
      <div className="dash-actions dash-mobile-only">
        <button className="dash-action" onClick={() => onNavigate?.('capture')}>+ Capture</button>
        <button className="dash-action" onClick={() => onNavigate?.('standup')}>Standup</button>
        <button className="dash-action" onClick={() => onNavigate?.('queue')}>Queue</button>
      </div>

      {/* Queue peek — at-risk tickets */}
      {queueData?.at_risk_tickets?.length > 0 && (
        <div className="dash-queue-peek">
          <div className="tasks-header">
            <span className="tasks-title">At Risk</span>
            <button className="tasks-more" onClick={() => onNavigate?.('queue')}>Full queue</button>
          </div>
          {queueData.at_risk_tickets.slice(0, window.innerWidth <= 768 ? 3 : 4).map(t => (
            <div key={t.ticket_key} className="dash-task task-high">
              <span className="task-key">{t.ticket_key}</span>
              <span className="task-text">{t.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
