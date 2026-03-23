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

// POST /api/todos/complete-ms — complete a Microsoft task via bridge + toggle in vault
router.post('/complete-ms', async (req, res) => {
  try {
    const { msId, source, filePath, lineNumber } = req.body;
    if (!msId) return res.status(400).json({ error: 'msId required' });

    const microsoft = require('../services/microsoft');

    // Complete in Microsoft via bridge
    if (source === 'MS Planner') {
      await microsoft.updatePlannerTask(msId, { percentComplete: 100 });
    } else if (source === 'MS ToDo') {
      // Need the listId — fetch lists and find default
      const lists = await microsoft.fetchTodoLists();
      const defaultList = lists?.find(l => l.wellknownListName === 'defaultList') || lists?.[0];
      if (defaultList) {
        await microsoft.updateTodoTask(msId, defaultList.id, { status: 'completed' });
      }
    }

    // Also toggle in vault if we have file info
    if (filePath && lineNumber != null) {
      obsidian.toggleTask(filePath, lineNumber);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[Todos] MS complete error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
