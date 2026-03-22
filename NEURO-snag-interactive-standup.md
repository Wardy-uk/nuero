# NEURO — Interactive Standup Ritual

## Problem

The Standup tab is a static textarea — Nick fills it in manually, formats it
himself, then saves. The PowerShell ritual (Ritual-Standup.ps1) is much better:
it passes a rich context prompt to Claude which reads the vault, asks questions
conversationally, and writes the daily note automatically.

NEURO should replace the textarea with a guided conversational standup that:
1. Reads today's context (queue, carry-overs, 90-day plan, calendar)
2. Asks Nick 3-4 questions in sequence (one at a time)
3. Takes his answers
4. Writes the daily note and marks standup done — no manual formatting

The existing textarea editor stays available as a fallback ("Manual" mode).

---

## Files to read before changing anything

- `frontend/src/components/StandupEditor.jsx`
- `frontend/src/components/StandupEditor.css`
- `frontend/src/components/ChatPanel.jsx` (for SSE streaming pattern)
- `backend/routes/standup.js`
- `backend/services/claude.js` (for context building and streaming)
- `backend/services/obsidian.js` (for daily note writing)

Read all files in full before making any changes.

---

## Backend: new endpoint `POST /api/standup/interactive`

Read `backend/routes/standup.js`. Add a new streaming endpoint that:
1. Loads all context (queue, carry-overs, todos, 90-day plan, calendar, daily note)
2. Sends a guided standup prompt to Claude
3. Streams the response back as SSE
4. On completion, parses the response and writes the daily note

```js
// POST /api/standup/interactive — Claude-guided standup session
router.post('/interactive', async (req, res) => {
  const { messages = [], phase = 'start' } = req.body;
  // phase: 'start' | 'answering' | 'finalise'

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build context block
    const today = new Date();
    const todayStr = obsidianService.todayDateString();
    const dow = today.toLocaleDateString('en-GB', { weekday: 'long' });
    const isMonday = today.getDay() === 1;

    // Gather context
    let carryOvers = [];
    try {
      const prev = obsidianService.readPreviousDailyNote();
      if (prev) {
        const lines = prev.content.split('\n');
        let inFocus = false;
        for (const line of lines) {
          if (line.startsWith('## Focus Today') || line.startsWith('## Carry')) { inFocus = true; continue; }
          if (line.startsWith('## ') && inFocus) break;
          if (inFocus && (line.match(/^\s*-\s+\[\s\]/) || line.match(/^\s*-\s+\[>\]/))) {
            const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
            if (text) carryOvers.push(text);
          }
        }
      }
    } catch {}

    let queueContext = '';
    try {
      const db = require('../db/database');
      const queue = db.getQueueSummary();
      if (queue.total > 0) {
        queueContext = `Queue: ${queue.total} open tickets, ${queue.at_risk_count} at risk, ${queue.open_p1s} P1s.`;
        if (queue.at_risk_tickets.length > 0) {
          queueContext += ` At risk: ${queue.at_risk_tickets.slice(0, 3).map(t => t.ticket_key + ' ' + t.summary).join('; ')}.`;
        }
      }
    } catch {}

    let planContext = '';
    try {
      const plan = obsidianService.parseNinetyDayPlan();
      if (plan) {
        planContext = `90-day plan: Day ${plan.currentDay} of ${plan.totalDays}. ${plan.totalDone}/${plan.totalTasks} tasks done.`;
        if (plan.todayTasks.length > 0) {
          planContext += ` Today's tasks: ${plan.todayTasks.map(t => t.text).join('; ')}.`;
        }
        if (plan.overdueTasks.length > 0) {
          planContext += ` ${plan.overdueTasks.length} overdue tasks.`;
        }
      }
    } catch {}

    let calendarContext = '';
    try {
      const startStr = todayStr + 'T00:00:00';
      const endStr = todayStr + 'T23:59:59';
      const events = await obsidianService.fetchCalendarEvents(todayStr, todayStr);
      if (events && events.length > 0) {
        const upcoming = events.filter(e => e.showAs !== 'cancelled');
        if (upcoming.length > 0) {
          calendarContext = `Today's calendar: ${upcoming.map(e => {
            const time = e.start ? e.start.substring(11, 16) : '';
            return time ? `${time} ${e.subject}` : e.subject;
          }).join(', ')}.`;
        }
      }
    } catch {}

    // System prompt for the guided standup
    const systemPrompt = `You are NEURO running Nick's morning standup ritual. Nick is Head of Technical Support at Nurtur Limited.

Your job: guide Nick through a focused standup in 3-4 short exchanges, then write his daily note.

TODAY: ${dow} ${todayStr}${isMonday ? ' (Monday — ask about the week ahead, not just today)' : ''}

CONTEXT:
${queueContext || 'Queue data unavailable.'}
${planContext || ''}
${calendarContext || ''}
${carryOvers.length > 0 ? `Carry-overs from yesterday: ${carryOvers.join('; ')}` : 'No carry-overs.'}

STANDUP FLOW — follow this exactly:

Phase 1 (start): Give a brief, sharp morning brief (2-3 lines max — queue status, any at-risk, one key thing from the plan). Then ask ONE question: "What's your main focus today?"

Phase 2 (after focus answer): Ask: "Any blockers or things that need escalating?"

Phase 3 (after blockers answer): ${isMonday ? 'Ask: "How are you going into the week — anything to flag energy or capacity-wise?"' : 'Ask: "Anything else before I write this up?"'}

Phase 4 (finalise): Say "Writing your daily note now..." then output the daily note in this EXACT format between the markers:

===DAILY_NOTE_START===
---
type: daily
date: ${todayStr}
---
# Daily Note — ${dow} ${todayStr}

## Focus Today
[checkbox list of focus items Nick mentioned, each as: - [ ] item text]

## Carry-Overs
${carryOvers.length > 0 ? carryOvers.map(c => `- [ ] ${c}`).join('\n') : '- None'}

## Blockers
[blockers Nick mentioned, or: - None]

## Queue Watch
${queueContext || '- No queue data'}

## Notes
[any other notes from the conversation]
===DAILY_NOTE_END===

Then end with one short line — something brief and human. No fluff.

RULES:
- One question at a time. Never ask two things in one message.
- Keep your messages short — 3 lines max except the daily note.
- Don't repeat what Nick just said back to him.
- Don't add unnecessary affirmations ("Great!", "Perfect!").
- The daily note markers must appear EXACTLY as shown — the app parses them.
- After writing the daily note, do not ask any more questions.`;

    // Build message history
    const claudeMessages = messages.map(m => ({ role: m.role, content: m.content }));

    // If starting, add the trigger
    if (phase === 'start' || claudeMessages.length === 0) {
      claudeMessages.push({ role: 'user', content: 'Start my standup.' });
    }

    // Stream response
    const stream = client.messages.stream({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: claudeMessages
    });

    let fullResponse = '';

    stream.on('text', (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
    });

    res.on('close', () => stream.abort());

    await new Promise((resolve) => stream.on('end', resolve));

    // Check if daily note is present in the response
    const noteMatch = fullResponse.match(/===DAILY_NOTE_START===\n([\s\S]*?)\n===DAILY_NOTE_END===/);
    if (noteMatch) {
      try {
        const noteContent = noteMatch[1].trim();
        obsidianService.writeTodayDailyNote(noteContent);
        nudges.markStandupDone();
        console.log('[Standup] Interactive standup complete — daily note written');
        res.write(`data: ${JSON.stringify({ type: 'done', noteSaved: true })}\n\n`);
      } catch (e) {
        console.error('[Standup] Failed to write daily note:', e.message);
        res.write(`data: ${JSON.stringify({ type: 'done', noteSaved: false, noteError: e.message })}\n\n`);
      }
    } else {
      res.write(`data: ${JSON.stringify({ type: 'done', noteSaved: false })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error('[Standup] Interactive error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  }
});
```

`node --check backend/routes/standup.js`

---

## Frontend: rewrite `StandupEditor.jsx`

Replace the entire component with a new version that has two modes:
- **Guided** (default): conversational standup driven by Claude
- **Manual**: the existing textarea editor (kept as fallback)

The EodCapture and BackupStandup sub-components stay unchanged.

```jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import ReactMarkdown from 'react-markdown';
import './StandupEditor.css';

// EodCapture — unchanged, paste existing component here

// BackupStandup — unchanged, paste existing component here

// ── Guided standup ────────────────────────────────────────────────────────

function GuidedStandup({ onDone }) {
  const [messages, setMessages] = useState([]); // { role: 'user'|'assistant', content: string }
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState('start');
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState(null);
  const [started, setStarted] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendToNeuro = useCallback(async (userMessage, isStart = false) => {
    const newMessages = isStart
      ? []
      : [...messages, { role: 'user', content: userMessage }];

    if (!isStart) {
      setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    }

    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    setStreaming(true);
    setInput('');

    try {
      const res = await fetch(apiUrl('/api/standup/interactive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          phase: isStart ? 'start' : phase
        })
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text') {
              fullText += data.content;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: fullText };
                return updated;
              });
            } else if (data.type === 'done') {
              if (data.noteSaved) {
                setNoteSaved(true);
                setPhase('done');
              }
            } else if (data.type === 'error') {
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.content}` };
                return updated;
              });
            }
          } catch {}
        }
      }

      // Update messages with the full assistant response for next round
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: fullText };
        return updated;
      });

      setPhase(prev => {
        if (prev === 'start') return 'answering';
        return prev;
      });

    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: `Connection error: ${err.message}` };
        return updated;
      });
    }

    setStreaming(false);
    inputRef.current?.focus();
  }, [messages, phase]);

  // Auto-start on mount
  useEffect(() => {
    if (!started) {
      setStarted(true);
      sendToNeuro('', true);
    }
  }, [started, sendToNeuro]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming || phase === 'done') return;
    sendToNeuro(text, false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Filter out the daily note markers from display
  const cleanContent = (content) => {
    return content
      .replace(/===DAILY_NOTE_START===[\s\S]*?===DAILY_NOTE_END===/g, '')
      .trim();
  };

  if (noteSaved) {
    return (
      <div className="guided-done">
        <div className="guided-done-icon">✓</div>
        <div className="guided-done-title">Daily note written</div>
        <div className="guided-done-sub">Standup complete. Have a good one.</div>
        {onDone && (
          <button className="btn btn-secondary" style={{ marginTop: '16px' }} onClick={onDone}>
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="guided-standup">
      <div className="guided-messages">
        {messages.length === 0 && (
          <div className="guided-loading">Starting your standup...</div>
        )}
        {messages.map((msg, i) => {
          const content = msg.role === 'assistant' ? cleanContent(msg.content) : msg.content;
          if (!content && msg.role === 'assistant' && i === messages.length - 1 && streaming) {
            return (
              <div key={i} className="guided-bubble assistant">
                <span className="guided-thinking">thinking...</span>
              </div>
            );
          }
          if (!content) return null;
          return (
            <div key={i} className={`guided-bubble ${msg.role}`}>
              {msg.role === 'assistant'
                ? <ReactMarkdown>{content}</ReactMarkdown>
                : <span>{content}</span>
              }
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {phase !== 'done' && (
        <div className="guided-input-row">
          <textarea
            ref={inputRef}
            className="guided-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={streaming ? '' : 'Your answer...'}
            rows={2}
            disabled={streaming}
            autoFocus
            spellCheck={true}
            autoCorrect="on"
          />
          <button
            className="guided-send"
            onClick={handleSend}
            disabled={streaming || !input.trim()}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main StandupEditor ────────────────────────────────────────────────────

export default function StandupEditor() {
  const [mode, setMode] = useState('guided'); // 'guided' | 'manual'
  const [content, setContent] = useState('');
  const [contentSet, setContentSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showEod, setShowEod] = useState(false);
  const [guidedDone, setGuidedDone] = useState(false);

  const { data: standupData, status: standupStatus } = useCachedFetch('/api/standup');
  const { data: ritualData } = useCachedFetch('/api/standup/ritual-state');

  // Check if standup already done today
  const standupDone = ritualData?.standupDoneToday || guidedDone;

  useEffect(() => {
    if (standupData && !contentSet) {
      setContent(standupData.content || '# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    } else if (standupStatus === 'unavailable' && !contentSet) {
      setContent('# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    }
  }, [standupData, standupStatus, contentSet]);

  // Auto-show EOD after 5pm
  useEffect(() => {
    const now = new Date();
    if (now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= 17) setShowEod(true);
  }, []);

  const handleSaveToDaily = async () => {
    setSaving(true);
    try {
      await fetch(apiUrl('/api/standup/save-to-daily'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      setMessage('Saved to daily note');
      setTimeout(() => setMessage(''), 2000);
    } catch {
      setMessage('Save failed');
    }
    setSaving(false);
  };

  return (
    <div className="standup-editor">

      {/* EOD always available */}
      {showEod && <EodCapture onDone={() => setShowEod(false)} />}

      {/* Mode toggle + EOD button */}
      <div className="standup-header">
        <div className="standup-mode-toggle">
          <button
            className={`mode-btn ${mode === 'guided' ? 'active' : ''}`}
            onClick={() => setMode('guided')}
          >
            Guided
          </button>
          <button
            className={`mode-btn ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => setMode('manual')}
          >
            Manual
          </button>
        </div>
        <div className="standup-header-actions">
          {message && <span className="standup-message">{message}</span>}
          {!showEod && (
            <button className="btn btn-secondary" onClick={() => setShowEod(true)}>
              EOD
            </button>
          )}
        </div>
      </div>

      {/* Already done banner */}
      {standupDone && mode === 'guided' && !guidedDone && (
        <div className="standup-done-banner">
          ✓ Standup already done today.
          <button className="standup-redo-btn" onClick={() => setGuidedDone(false)}>
            Redo
          </button>
        </div>
      )}

      {/* Guided mode */}
      {mode === 'guided' && !standupDone && (
        <GuidedStandup onDone={() => setGuidedDone(true)} />
      )}

      {/* Guided done */}
      {mode === 'guided' && (standupDone || guidedDone) && !showEod && (
        <div className="guided-done">
          <div className="guided-done-icon">✓</div>
          <div className="guided-done-title">Standup complete</div>
          <div className="guided-done-sub">Daily note written to vault.</div>
        </div>
      )}

      {/* Manual mode */}
      {mode === 'manual' && (
        <>
          <textarea
            className="standup-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />
          <div className="standup-actions" style={{ marginTop: '8px' }}>
            <button className="btn btn-primary" onClick={handleSaveToDaily} disabled={saving}>
              {saving ? 'Saving...' : 'Save to daily note'}
            </button>
          </div>
        </>
      )}

    </div>
  );
}
```

---

## CSS additions to `StandupEditor.css`

Read the file. Add at the end:

```css
/* Mode toggle */
.standup-mode-toggle {
  display: flex;
  gap: 4px;
}

.mode-btn {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 3px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.mode-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

/* Guided standup */
.guided-standup {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 160px);
  min-height: 300px;
}

.guided-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.guided-loading {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 20px 0;
}

.guided-bubble {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
}

.guided-bubble.assistant {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  align-self: flex-start;
  color: var(--text-primary);
}

.guided-bubble.user {
  background: rgba(79, 156, 249, 0.12);
  border: 1px solid rgba(79, 156, 249, 0.25);
  align-self: flex-end;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
}

.guided-thinking {
  color: var(--text-muted);
  font-style: italic;
  font-size: 12px;
  font-family: var(--font-mono);
}

.guided-bubble.assistant p { margin: 0 0 6px; }
.guided-bubble.assistant p:last-child { margin-bottom: 0; }
.guided-bubble.assistant ul, .guided-bubble.assistant ol { margin: 4px 0; padding-left: 18px; }

.guided-input-row {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.guided-input {
  flex: 1;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: var(--font-sans, 'IBM Plex Sans', sans-serif);
  font-size: 14px;
  padding: 8px 12px;
  resize: none;
  outline: none;
  line-height: 1.4;
}

.guided-input:focus {
  border-color: var(--accent);
}

.guided-send {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 16px;
  cursor: pointer;
  align-self: flex-end;
}

.guided-send:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Done state */
.guided-done {
  text-align: center;
  padding: 40px 0;
}

.guided-done-icon {
  font-size: 36px;
  color: var(--success, #22c55e);
  margin-bottom: 12px;
}

.guided-done-title {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.guided-done-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

/* Already done banner */
.standup-done-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: rgba(34, 197, 94, 0.08);
  border: 1px solid rgba(34, 197, 94, 0.2);
  border-radius: 6px;
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--success, #22c55e);
}

.standup-redo-btn {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  background: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  margin-left: auto;
}

@media (max-width: 768px) {
  .guided-standup {
    height: calc(100vh - 200px);
  }
}
```

---

## Verification

```
node --check backend/routes/standup.js
cd frontend && npm run build
```

Must pass clean.

## Expected behaviour

1. Open Standup tab → Guided mode is default
2. NEURO immediately starts: gives a 2-3 line brief (queue, plan, at-risk) then asks
   "What's your main focus today?"
3. Nick types his answer, presses Enter or →
4. NEURO asks about blockers
5. NEURO asks one more question (Monday: energy/capacity, other days: anything else)
6. NEURO says "Writing your daily note now..." and writes it
7. Tab shows ✓ Done screen — standup complete, nudge cleared
8. Manual tab still available as fallback at any time

## Notes for CC

- The daily note markers `===DAILY_NOTE_START===` / `===DAILY_NOTE_END===` are
  stripped from the displayed conversation — Nick never sees them
- If Claude API is unavailable (no ANTHROPIC_API_KEY), the endpoint will fail and
  show an error — fall back to Manual mode in that case. Add a try/catch in the
  frontend: if the stream returns an error on the first message, show a banner
  "Guided mode unavailable — switch to Manual" with a button
- The existing BackupStandup component is no longer shown by default — it's replaced
  by the Guided flow. Remove the Quick Backup button from the header.
- EodCapture stays exactly as-is

## Do not commit to git
