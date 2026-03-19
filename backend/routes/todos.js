const express = require('express');
const router = express.Router();
const obsidian = require('../services/obsidian');

// GET /api/todos — reads tasks from Obsidian vault
router.get('/', (req, res) => {
  try {
    const showDone = req.query.all === 'true';
    const { active, done } = obsidian.parseVaultTodos();

    const todos = showDone ? [...active, ...done] : active;

    // Map to shape the frontend expects
    const mapped = todos.map((t, i) => ({
      id: i + 1,
      text: t.text,
      priority: t.priority || 'normal',
      due_date: t.due_date || null,
      source: t.source || null,
      done: t.status === 'done' ? 1 : 0,
      ms_id: t.ms_id || null,
      vault_task: true,
      filePath: t.filePath || null,
      lineNumber: t.lineNumber != null ? t.lineNumber : null
    }));

    res.json({ todos: mapped });
  } catch (e) {
    console.error('[Todos] Error parsing vault todos:', e);
    res.status(500).json({ error: 'Failed to parse vault todos' });
  }
});

// POST /api/todos/toggle — toggle a task's done status in the vault
router.post('/toggle', (req, res) => {
  try {
    const { filePath, lineNumber } = req.body;
    if (!filePath || lineNumber == null) {
      return res.status(400).json({ error: 'filePath and lineNumber required' });
    }
    const newStatus = obsidian.toggleTask(filePath, lineNumber);
    res.json({ status: newStatus });
  } catch (e) {
    console.error('[Todos] Toggle error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
