const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/do-next
router.get('/', (req, res) => {
  try {
    const showAll = req.query.all === 'true';
    const tasks = showAll ? db.getAllDoNext() : db.getActiveDoNext();
    res.json({ tasks });
  } catch (e) {
    console.error('[DoNext] GET error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/do-next — add a task
router.post('/', (req, res) => {
  try {
    const { text, source, source_ref, priority, due_date } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });
    db.createDoNext(text.trim(), source, source_ref, priority, due_date);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DoNext] POST error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/do-next/:id/complete
router.patch('/:id/complete', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    db.completeDoNext(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DoNext] PATCH error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/do-next/:id
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    db.deleteDoNext(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DoNext] DELETE error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
