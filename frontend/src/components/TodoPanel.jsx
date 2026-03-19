import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './TodoPanel.css';

function sourceClass(source) {
  if (!source) return '';
  if (source.startsWith('Master')) return 'todo-source-master';
  if (source.startsWith('MS Planner')) return 'todo-source-planner';
  if (source.startsWith('MS ToDo')) return 'todo-source-todo';
  if (source.startsWith('Daily')) return 'todo-source-daily';
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

// Group todos by source prefix
function groupBySource(todos) {
  const groups = {};
  for (const todo of todos) {
    const src = todo.source || 'Other';
    // Group by first part before parenthetical: "Master (Now)" → "Master Todo"
    let groupKey;
    if (src.startsWith('Master')) groupKey = 'Master Todo';
    else if (src.startsWith('MS Planner')) groupKey = 'MS Planner';
    else if (src.startsWith('MS ToDo')) groupKey = 'MS ToDo';
    else if (src.startsWith('Daily')) groupKey = 'Today\'s Daily Note';
    else groupKey = src;

    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(todo);
  }
  return groups;
}

export default function TodoPanel() {
  const [todos, setTodos] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all, overdue, today, high, master, ms, daily

  const [toggling, setToggling] = useState({});

  const fetchTodos = async () => {
    try {
      const res = await fetch(apiUrl(`/api/todos${showDone ? '?all=true' : ''}`));
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (e) { /* ignore */ }
    setLoading(false);
  };

  const toggleTodo = async (todo) => {
    if (!todo.filePath || todo.lineNumber == null) return;
    const key = `${todo.filePath}:${todo.lineNumber}`;
    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      await fetch(apiUrl('/api/todos/toggle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: todo.filePath, lineNumber: todo.lineNumber })
      });
      await fetchTodos();
    } catch (e) { /* ignore */ }
    setToggling(prev => ({ ...prev, [key]: false }));
  };

  useEffect(() => { fetchTodos(); }, [showDone]);

  const activeTodos = todos.filter(t => !t.done);
  const doneTodos = todos.filter(t => t.done);
  const overdueTodos = activeTodos.filter(t => isOverdue(t.due_date));

  // Apply filter
  let filtered = activeTodos;
  if (filter === 'overdue') filtered = activeTodos.filter(t => isOverdue(t.due_date));
  else if (filter === 'today') filtered = activeTodos.filter(t => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date);
    const today = new Date(new Date().toDateString());
    return d.getTime() === today.getTime() || d < today;
  });
  else if (filter === 'high') filtered = activeTodos.filter(t => t.priority === 'high');
  else if (filter === 'master') filtered = activeTodos.filter(t => t.source && t.source.startsWith('Master'));
  else if (filter === 'ms') filtered = activeTodos.filter(t => t.source && t.source.startsWith('MS'));
  else if (filter === 'daily') filtered = activeTodos.filter(t => t.source && t.source.startsWith('Daily'));

  // Source summary counts
  const sourceCounts = {};
  for (const t of activeTodos) {
    const src = t.source || 'Other';
    let key;
    if (src.startsWith('Master')) key = 'Master Todo';
    else if (src.startsWith('MS')) key = 'MS Tasks';
    else if (src.startsWith('Daily')) key = 'Daily Note';
    else key = src;
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }

  return (
    <div className="todo-container">
      <div className="todo-header">
        <h2 className="todo-title">Todos</h2>
        <div className="todo-header-right">
          <span className="todo-count">
            {activeTodos.length} open
            {overdueTodos.length > 0 && <span className="overdue-count"> / {overdueTodos.length} overdue</span>}
          </span>
          <button className="btn btn-secondary" onClick={fetchTodos}>Refresh</button>
        </div>
      </div>

      <div className="todo-source-summary">
        {Object.entries(sourceCounts).map(([src, count]) => (
          <span key={src} className="source-chip">{src}: {count}</span>
        ))}
      </div>

      <div className="todo-filters">
        {[
          { key: 'all', label: 'All' },
          { key: 'overdue', label: `Overdue (${overdueTodos.length})` },
          { key: 'today', label: 'Due today' },
          { key: 'high', label: 'High priority' },
          { key: 'master', label: 'Master Todo' },
          { key: 'ms', label: 'MS Tasks' },
          { key: 'daily', label: 'Daily Note' },
        ].map(f => (
          <button
            key={f.key}
            className={`todo-filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

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
