import React, { useState, useMemo } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './TodoPanel.css';

function sourceClass(source) {
  if (!source) return '';
  if (source.startsWith('Master')) return 'todo-source-master';
  if (source.startsWith('MS Planner')) return 'todo-source-planner';
  if (source.startsWith('MS ToDo')) return 'todo-source-todo';
  if (source.startsWith('Daily')) return 'todo-source-daily';
  if (source.startsWith('90-Day')) return 'todo-source-plan';
  return '';
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

function formatDue(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  const today = new Date(new Date().toDateString());
  const diff = Math.floor((d - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Extract sub-category from source string
// "90-Day Plan (Quality & CX)" → "Quality & CX"
// "Master (Now)" → "Now"
// "Daily 2026-03-20" → "2026-03-20"
function getSubCategory(source) {
  if (!source) return null;
  const parenMatch = source.match(/\(([^)]+)\)/);
  if (parenMatch) return parenMatch[1];
  if (source.startsWith('Daily ')) return source.replace('Daily ', '');
  return null;
}

// Which top-level group does a source belong to?
function getTopGroup(source) {
  if (!source) return 'other';
  if (source.startsWith('90-Day')) return 'plan';
  if (source.startsWith('Master') || source.startsWith('Daily')) return 'vault';
  if (source.startsWith('MS')) return 'ms';
  return 'other';
}

export default function TodoPanel() {
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState('all'); // all, overdue, today, high, plan, vault, ms
  const [subFilters, setSubFilters] = useState([]); // multi-select sub-categories
  const [toggling, setToggling] = useState({});
  const [syncing, setSyncing] = useState(false);

  const path = `/api/todos${showDone ? '?all=true' : ''}`;
  const transform = useMemo(() => (json) => json.todos || [], []);
  const { data: todos, refresh: fetchTodos } = useCachedFetch(path, { transform });
  const loading = todos === null;

  const toggleTodo = async (todo) => {
    if (!todo.filePath || todo.lineNumber == null) return;
    const key = `${todo.filePath}:${todo.lineNumber}`;
    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      if (todo.ms_id && (todo.source === 'MS Planner' || todo.source === 'MS ToDo')) {
        await fetch(apiUrl('/api/todos/complete-ms'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msId: todo.ms_id,
            source: todo.source,
            filePath: todo.filePath,
            lineNumber: todo.lineNumber
          })
        });
      } else {
        await fetch(apiUrl('/api/todos/toggle'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: todo.filePath, lineNumber: todo.lineNumber })
        });
      }
      await fetchTodos();
    } catch (e) { /* ignore */ }
    setToggling(prev => ({ ...prev, [key]: false }));
  };

  const activeTodos = (todos || []).filter(t => !t.done);
  const doneTodos = (todos || []).filter(t => t.done);
  const overdueTodos = activeTodos.filter(t => isOverdue(t.due_date));

  // Build sub-category options for current top-level filter
  const subCategoryOptions = useMemo(() => {
    if (!['plan', 'vault', 'ms'].includes(filter)) return [];
    const counts = {};
    for (const t of activeTodos) {
      if (getTopGroup(t.source) !== filter) continue;
      const sub = getSubCategory(t.source) || (
        filter === 'vault'
          ? (t.source?.startsWith('Master') ? 'Master Todo' : t.source?.startsWith('Daily') ? 'Daily Note' : 'Other')
          : (t.source?.startsWith('MS Planner') ? 'Planner' : t.source?.startsWith('MS ToDo') ? 'ToDo' : 'Other')
      );
      counts[sub] = (counts[sub] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [filter, activeTodos]);

  // Top-level counts
  const topCounts = useMemo(() => {
    const c = { plan: 0, vault: 0, ms: 0 };
    for (const t of activeTodos) {
      const g = getTopGroup(t.source);
      if (c[g] !== undefined) c[g]++;
    }
    return c;
  }, [activeTodos]);

  // Apply filters
  let filtered = activeTodos;
  if (filter === 'overdue') {
    filtered = activeTodos.filter(t => isOverdue(t.due_date));
  } else if (filter === 'today') {
    filtered = activeTodos.filter(t => {
      if (!t.due_date) return false;
      const d = new Date(t.due_date);
      const today = new Date(new Date().toDateString());
      return d.getTime() === today.getTime() || d < today;
    });
  } else if (filter === 'high') {
    filtered = activeTodos.filter(t => t.priority === 'high');
  } else if (['plan', 'vault', 'ms'].includes(filter)) {
    filtered = activeTodos.filter(t => getTopGroup(t.source) === filter);
    // Apply sub-filters if any selected
    if (subFilters.length > 0) {
      filtered = filtered.filter(t => {
        const sub = getSubCategory(t.source) || (
          filter === 'vault'
            ? (t.source?.startsWith('Master') ? 'Master Todo' : t.source?.startsWith('Daily') ? 'Daily Note' : 'Other')
            : (t.source?.startsWith('MS Planner') ? 'Planner' : t.source?.startsWith('MS ToDo') ? 'ToDo' : 'Other')
        );
        return subFilters.includes(sub);
      });
    }
  }

  const toggleSubFilter = (sub) => {
    setSubFilters(prev =>
      prev.includes(sub) ? prev.filter(s => s !== sub) : [...prev, sub]
    );
  };

  const setTopFilter = (key) => {
    setFilter(key);
    setSubFilters([]); // reset sub-filters on top-level change
  };

  return (
    <div className="todo-container">
      <div className="todo-header">
        <h2 className="todo-title">Todos</h2>
        <div className="todo-header-right">
          <span className="todo-count">
            {activeTodos.length} open
            {overdueTodos.length > 0 && <span className="overdue-count"> / {overdueTodos.length} overdue</span>}
          </span>
          <button className="btn btn-secondary" disabled={syncing} onClick={async () => {
            setSyncing(true);
            try {
              await fetch(apiUrl('/api/microsoft/tasks/sync'), { method: 'POST' });
              await fetchTodos();
            } catch {}
            setSyncing(false);
          }}>{syncing ? 'Syncing...' : 'Sync MS'}</button>
          <button className="btn btn-secondary" onClick={fetchTodos}>Refresh</button>
        </div>
      </div>

      {/* Top-level filters */}
      <div className="todo-filters">
        {[
          { key: 'all', label: 'All' },
          { key: 'overdue', label: `Overdue (${overdueTodos.length})` },
          { key: 'today', label: 'Due today' },
          { key: 'high', label: 'High priority' },
          { key: 'plan', label: `90-Day Plan (${topCounts.plan})` },
          { key: 'vault', label: `Vault Todos (${topCounts.vault})` },
          { key: 'ms', label: `MS Tasks (${topCounts.ms})` },
        ].map(f => (
          <button
            key={f.key}
            className={`todo-filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setTopFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Sub-category filters — shown when a group filter is active */}
      {subCategoryOptions.length > 0 && (
        <div className="todo-sub-filters">
          <button
            className={`todo-sub-btn ${subFilters.length === 0 ? 'active' : ''}`}
            onClick={() => setSubFilters([])}
          >
            All
          </button>
          {subCategoryOptions.map(([sub, count]) => (
            <button
              key={sub}
              className={`todo-sub-btn ${subFilters.includes(sub) ? 'active' : ''}`}
              onClick={() => toggleSubFilter(sub)}
            >
              {sub} ({count})
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="todo-empty">Loading vault tasks...</div>
      ) : (
        <div className="todo-list">
          {filtered.length === 0 && (
            <div className="todo-empty">
              {filter === 'all' ? 'No open todos. Nice work.' : 'No matching todos.'}
            </div>
          )}
          {filtered.map(todo => {
            const overdue = isOverdue(todo.due_date);
            const dueLabel = formatDue(todo.due_date);
            const toggleKey = `${todo.filePath}:${todo.lineNumber}`;
            const isToggling = toggling[toggleKey];
            return (
              <div key={`${todo.source}-${todo.id}`} className={`todo-item priority-${todo.priority} ${overdue ? 'overdue' : ''}`}>
                <button
                  className={`todo-checkbox ${isToggling ? 'toggling' : ''}`}
                  onClick={() => toggleTodo(todo)}
                  disabled={isToggling || !todo.filePath}
                  title="Mark done"
                />
                <div className="todo-text-col">
                  <span className="todo-text">{todo.text}</span>
                  <div className="todo-meta-row">
                    {todo.source && <span className={`todo-source ${sourceClass(todo.source)}`}>{todo.source}</span>}
                    {dueLabel && (
                      <span className={`todo-due ${overdue ? 'due-overdue' : ''}`}>{dueLabel}</span>
                    )}
                  </div>
                </div>
                <span className={`todo-priority-badge ${todo.priority}`}>{todo.priority}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="todo-footer">
        <button className="btn btn-secondary" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hide completed' : 'Show completed'}
        </button>
      </div>

      {showDone && doneTodos.length > 0 && (
        <div className="todo-done-list">
          {doneTodos.map(todo => {
            const toggleKey = `${todo.filePath}:${todo.lineNumber}`;
            const isToggling = toggling[toggleKey];
            return (
              <div key={`done-${todo.id}`} className="todo-item done">
                <button
                  className={`todo-checkbox checked ${isToggling ? 'toggling' : ''}`}
                  onClick={() => toggleTodo(todo)}
                  disabled={isToggling || !todo.filePath}
                  title="Mark not done"
                />
                <div className="todo-text-col">
                  <span className="todo-text">{todo.text}</span>
                  <div className="todo-meta-row">
                    {todo.source && <span className={`todo-source ${sourceClass(todo.source)}`}>{todo.source}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
