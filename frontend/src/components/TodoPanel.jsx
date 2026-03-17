import React, { useState, useEffect } from 'react';
import './TodoPanel.css';

export default function TodoPanel() {
  const [todos, setTodos] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [newText, setNewText] = useState('');
  const [newPriority, setNewPriority] = useState('normal');

  const fetchTodos = async () => {
    try {
      const res = await fetch(`/api/todos${showDone ? '?all=true' : ''}`);
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (e) { /* ignore */ }
  };

  useEffect(() => { fetchTodos(); }, [showDone]);

  const addTodo = async () => {
    const text = newText.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, priority: newPriority })
      });
      const data = await res.json();
      setTodos(data.todos || []);
      setNewText('');
      setNewPriority('normal');
    } catch (e) { /* ignore */ }
  };

  const completeTodo = async (id) => {
    try {
      const res = await fetch(`/api/todos/${id}/complete`, { method: 'POST' });
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (e) { /* ignore */ }
  };

  const deleteTodo = async (id) => {
    try {
      const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
      const data = await res.json();
      setTodos(data.todos || []);
    } catch (e) { /* ignore */ }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo();
    }
  };

  const activeTodos = todos.filter(t => !t.done);
  const doneTodos = todos.filter(t => t.done);

  return (
    <div className="todo-container">
      <div className="todo-header">
        <h2 className="todo-title">Todos</h2>
        <span className="todo-count">{activeTodos.length} open</span>
      </div>

      <div className="todo-add-row">
        <input
          className="todo-input"
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a todo..."
        />
        <select className="todo-priority-select" value={newPriority} onChange={e => setNewPriority(e.target.value)}>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <button className="btn btn-primary" onClick={addTodo} disabled={!newText.trim()}>Add</button>
      </div>

      <div className="todo-list">
        {activeTodos.length === 0 && (
          <div className="todo-empty">No open todos. Nice work.</div>
        )}
        {activeTodos.map(todo => (
          <div key={todo.id} className={`todo-item priority-${todo.priority}`}>
            <button className="todo-check" onClick={() => completeTodo(todo.id)} title="Complete" />
            <div className="todo-text-col">
              <span className="todo-text">{todo.text}</span>
              {todo.source && <span className="todo-source">via {todo.source}</span>}
            </div>
            <span className={`todo-priority-badge ${todo.priority}`}>{todo.priority}</span>
            <button className="todo-delete" onClick={() => deleteTodo(todo.id)} title="Delete">x</button>
          </div>
        ))}
      </div>

      <div className="todo-footer">
        <button className="btn btn-secondary" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hide completed' : 'Show completed'}
        </button>
      </div>

      {showDone && doneTodos.length > 0 && (
        <div className="todo-done-list">
          {doneTodos.map(todo => (
            <div key={todo.id} className="todo-item done">
              <span className="todo-check-done" />
              <span className="todo-text">{todo.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
