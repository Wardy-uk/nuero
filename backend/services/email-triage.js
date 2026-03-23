'use strict';

const db = require('../db/database');
const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const TRIAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Classify a batch of emails using Claude
async function classifyEmails(emails) {
  if (!emails || emails.length === 0) return [];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const emailList = emails.slice(0, 20).map((e, i) =>
    `[${i}] From: ${e.from} <${e.fromEmail}>\nSubject: ${e.subject}\nPreview: ${e.preview?.substring(0, 150) || '(no preview)'}`
  ).join('\n\n');

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 800,
    system: `You are classifying emails for Nick Ward, Head of Technical Support at Nurtur.
Classify each email into exactly one category:
- ACTION: Requires Nick to do something or reply (escalations, approvals, questions directed at Nick, complaints)
- FYI: Informational only, no action needed (newsletters, notifications, CCs, status updates)
- DELEGATE: Someone else should handle this, not Nick directly
- IGNORE: Automated, spam, or irrelevant

Respond with ONLY a JSON array, one object per email, in the same order as input.
Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]
No other text.`,
    messages: [{
      role: 'user',
      content: `Classify these ${emails.slice(0, 20).length} emails:\n\n${emailList}`
    }]
  });

  try {
    const text = response.content[0]?.text || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const classifications = JSON.parse(clean);

    return emails.map((email, i) => {
      const cls = classifications.find(c => c.index === i);
      return {
        ...email,
        category: cls?.category || 'FYI',
        reason: cls?.reason || '',
        triaged: true,
        triagedAt: new Date().toISOString()
      };
    });
  } catch (e) {
    console.warn('[EmailTriage] Parse failed:', e.message);
    return emails.map(e => ({ ...e, category: 'FYI', reason: '', triaged: false }));
  }
}

// Run a full triage cycle — fetch, classify, store
async function runTriage() {
  const microsoft = require('./microsoft');
  if (!microsoft.isBridgeConnected() && !(await microsoft.isAuthenticated())) {
    return { ok: false, reason: 'M365 not connected' };
  }

  try {
    const emails = await microsoft.fetchRecentEmails(24, 40);
    if (!emails || emails.length === 0) {
      return { ok: true, count: 0, action: 0 };
    }

    const classified = await classifyEmails(emails);

    // Store results
    const existing = getStoredTriage();

    // Merge: keep existing dismissed items, add/update new ones
    const updated = [
      ...existing.filter(e => e.dismissed),
      ...classified.map(e => {
        const prev = existing.find(p => p.id === e.id);
        return {
          ...e,
          dismissed: prev?.dismissed || false,
          dismissedAt: prev?.dismissedAt || null
        };
      })
    ];

    db.setState('email_triage', JSON.stringify(updated));
    db.setState('email_triage_time', String(Date.now()));

    const actionCount = classified.filter(e => e.category === 'ACTION').length;
    console.log(`[EmailTriage] Classified ${classified.length} emails, ${actionCount} need action`);
    return { ok: true, count: classified.length, action: actionCount };
  } catch (e) {
    console.error('[EmailTriage] Failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getStoredTriage() {
  try {
    const raw = db.getState('email_triage');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function getTriageByCategory() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  return {
    action: all.filter(e => e.category === 'ACTION'),
    fyi: all.filter(e => e.category === 'FYI'),
    delegate: all.filter(e => e.category === 'DELEGATE'),
    ignore: all.filter(e => e.category === 'IGNORE'),
    lastRun: db.getState('email_triage_time')
  };
}

function dismissEmail(emailId) {
  const all = getStoredTriage();
  const updated = all.map(e =>
    e.id === emailId
      ? { ...e, dismissed: true, dismissedAt: new Date().toISOString() }
      : e
  );
  db.setState('email_triage', JSON.stringify(updated));
}

function clearDismissed() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  db.setState('email_triage', JSON.stringify(all));
}

module.exports = {
  runTriage,
  getTriageByCategory,
  dismissEmail,
  clearDismissed,
  TRIAGE_CACHE_TTL
};
