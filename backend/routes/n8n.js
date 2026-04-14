const express = require('express');
const router = express.Router();
const n8n = require('../services/n8n');

// POST /api/n8n/121 — run 1-2-1 snapshot for an agent
router.post('/121', async (req, res) => {
  if (!n8n.isConfigured()) {
    return res.status(400).json({ error: 'n8n API key not configured (N8N_API_KEY)' });
  }

  const { nameHint, mode, lookbackDays, nextStepsDays, isProbationary } = req.body;
  if (!nameHint) {
    return res.status(400).json({ error: 'nameHint is required' });
  }

  try {
    const result = await n8n.run121Snapshot(nameHint, mode || '30day', {
      lookbackDays,
      nextStepsDays,
      isProbationary,
    });
    res.json(result);
  } catch (err) {
    console.error('[n8n] 1-2-1 execution error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/n8n/status
router.get('/status', (req, res) => {
  res.json({ configured: n8n.isConfigured() });
});

// --- Approval endpoints (called by n8n workflow + NUERO frontend) ---

// POST /api/n8n/121/draft — n8n sends draft review here instead of emailing
router.post('/121/draft', (req, res) => {
  const secret = req.headers['x-ingest-secret'];
  if (secret !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { agentName, agentEmail, subject, draftHtml, markdown, executionId } = req.body;
  if (!agentName || !draftHtml) {
    return res.status(400).json({ error: 'agentName and draftHtml are required' });
  }
  const entry = n8n.addPendingApproval({ agentName, agentEmail, subject, draftHtml, markdown, executionId });
  res.json({ success: true, id: entry.id });
});

// GET /api/n8n/121/pending — list pending approvals for the UI
router.get('/121/pending', (req, res) => {
  res.json({ approvals: n8n.getPendingApprovals() });
});

// GET /api/n8n/121/pending/:id — get a single pending approval
router.get('/121/pending/:id', (req, res) => {
  const approval = n8n.getPendingApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  res.json(approval);
});

// POST /api/n8n/121/approve/:id — approve, save to vault, and resume the n8n workflow
router.post('/121/approve/:id', async (req, res) => {
  try {
    // Get the approval data before it's deleted
    const approval = n8n.getPendingApproval(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });

    // Save to vault first
    let vaultPath = null;
    if (approval.markdown) {
      try {
        const obsidianService = require('../services/obsidian');
        const date = new Date().toISOString().split('T')[0];
        const agentName = approval.agentName;
        const fileName = `${date} – ${agentName} 30-Day Performance Review.md`;

        // Merge additional steps into markdown if provided
        let markdown = approval.markdown;
        const additionalSteps = (req.body.additionalSteps || '').trim();
        if (additionalSteps) {
          const extra = additionalSteps.split('\n').map(s => '- [ ] ' + s.trim()).filter(s => s.length > 6).join('\n');
          markdown = markdown.replace(/## Tracking/, extra + '\n\n## Tracking');
        }

        const frontmatter = [
          '---',
          'type: performance-review',
          `person: "[[People/${agentName}|${agentName}]]"`,
          `date: ${date}`,
          'source: n8n-workflow',
          '---',
          '',
        ].join('\n');

        vaultPath = obsidianService.writeReviewToVault(agentName, fileName, frontmatter + markdown);
        console.log(`[n8n] Review saved to vault: ${vaultPath}`);
      } catch (e) {
        console.error('[n8n] Vault save error (non-blocking):', e.message);
      }
    }

    // Resume the n8n workflow (sends agent email)
    const result = await n8n.submitApproval(req.params.id, req.body);
    res.json({ ...result, vaultPath });
  } catch (err) {
    console.error('[n8n] Approval error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/n8n/121/dismiss/:id — dismiss without approving
router.post('/121/dismiss/:id', (req, res) => {
  const removed = n8n.removePendingApproval(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Approval not found' });
  res.json({ success: true });
});

// POST /api/n8n/121/final — n8n sends final review MD here for vault storage
router.post('/121/final', (req, res) => {
  const secret = req.headers['x-ingest-secret'];
  if (secret !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { agentName, markdown, reviewDate } = req.body;
  if (!agentName || !markdown) {
    return res.status(400).json({ error: 'agentName and markdown are required' });
  }
  try {
    const obsidianService = require('../services/obsidian');
    const date = reviewDate || new Date().toISOString().split('T')[0];
    const fileName = `${date} – ${agentName} 30-Day Performance Review.md`;

    // Add frontmatter for vault linking
    const frontmatter = [
      '---',
      'type: performance-review',
      `person: "[[People/${agentName}|${agentName}]]"`,
      `date: ${date}`,
      `source: n8n-workflow`,
      '---',
      '',
    ].join('\n');

    const fullContent = frontmatter + markdown;
    const savedPath = obsidianService.writeReviewToVault(agentName, fileName, fullContent);
    console.log(`[n8n] Review saved to vault: ${savedPath}`);
    res.json({ success: true, path: savedPath });
  } catch (err) {
    console.error('[n8n] Vault save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
