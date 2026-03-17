const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/todos
router.get('/', (req, res) => {
  const all = req.query.all === 'true';
  const todos = all ? db.getAllTodos() : db.getActiveTodos();
  res.json({ todos });
});

// POST /api/todos
router.post('/', (req, res) => {
  const { text, priority, due_date, source } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  db.createTodo(text, priority, due_date, source);
  res.json({ success: true, todos: db.getActiveTodos() });
});

// POST /api/todos/:id/complete
router.post('/:id/complete', (req, res) => {
  db.completeTodo(Number(req.params.id));
  res.json({ success: true, todos: db.getActiveTodos() });
});

// DELETE /api/todos/:id
router.delete('/:id', (req, res) => {
  db.deleteTodo(Number(req.params.id));
  res.json({ success: true, todos: db.getActiveTodos() });
});

module.exports = router;
