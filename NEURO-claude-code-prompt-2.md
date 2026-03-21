# NEURO — Claude Code Handoff Prompt #2

## Context

NEURO codebase at `C:\Users\NickW\nick-agent`. Same constraints as always:
- Node.js CommonJS backend, React 18 / Vite frontend
- No new npm packages unless explicitly stated
- Do not touch node_modules, do not commit to git
- Read files before editing — do not guess at contents

Previous snags (001–010) are complete. This prompt adds two new ones.

---

## Snag List

---

### SNAG-011 — Chat panel should hide on desktop when closed

**Files:** `frontend/src/App.css`, `frontend/src/components/Topbar.jsx`, `frontend/src/components/Topbar.css`

**The problem:** On mobile, the chat panel is correctly hidden via `display: none` and only shown with `display: flex` when `.chat-open` is applied. On **desktop** (above 768px), the `.chat-panel` has `width: 380px; min-width: 380px` with no hide/show logic — it permanently occupies 380px of horizontal space regardless of the `chatOpen` state. The toggle button in the Topbar (the `?` / `x` button) does nothing visible on desktop.

**Fix — App.css:**

1. On desktop, the chat panel should be hidden by default and shown only when `chatOpen` is true. Update `.chat-panel` to default to hidden, and add a desktop-specific show rule:

```css
.chat-panel {
  width: 380px;
  min-width: 380px;
  border-left: 1px solid rgba(255, 255, 255, 0.04);
  background: var(--bg-secondary);
  display: none;          /* hidden by default on all sizes */
  flex-direction: column;
}

.chat-panel.chat-open {
  display: flex;          /* shown when open on all sizes */
}
```

2. The mobile overrides in the `@media (max-width: 768px)` block already handle the mobile case correctly (position: fixed, full screen). Keep those as-is. Just ensure they still set `display: none` on `.chat-panel` and `display: flex` on `.chat-panel.chat-open` within the media query — these may now be redundant but should stay explicit for clarity.

**Fix — Topbar.jsx:**

The toggle button currently shows `?` when closed and `x` when open. Make this slightly clearer:
- When closed: show `⌨` (or the text `Chat`) to indicate what it opens
- When open: show `✕` to indicate close

Update the button in `Topbar.jsx`:

```jsx
<button className="topbar-chat-btn" onClick={onChatToggle} aria-label="Toggle chat">
  {chatOpen ? '✕' : 'Chat'}
</button>
```

Read `Topbar.css` first and check if `.topbar-chat-btn` has any styles that need updating for the text change (e.g. fixed width that would clip the word "Chat").

No backend changes. No new packages.

---

### SNAG-012 — Weekend mode: less work-focused tone and UI

**The requirement:** On weekends (Saturday and Sunday), NUERO should automatically shift into a lighter, less work-focused mode. This means:
1. The AI system prompt de-emphasises Jira queue, SLA pressure, and 90-day plan urgency
2. The UI shows a subtle indicator that weekend mode is active
3. Weekend mode can be manually overridden back to work mode if needed (e.g. catching up on a Sunday)

This should be automatic based on day of week, with a manual toggle to force work mode if desired.

---

**Backend changes:**

**File: `backend/services/claude.js`**

1. Add a helper function near the top of the file:

```js
function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
}
```

2. Add a `WEEKEND_SYSTEM_PROMPT` constant after `SYSTEM_PROMPT`:

```js
const WEEKEND_SYSTEM_PROMPT = `You are NUERO — Nick's personal AI assistant. It's the weekend.

Nick is Head of Technical Support at Nurtur Limited. He's been navigating a big career step and works hard during the week. Weekends are for recharging.

Weekend mode — your priorities shift:
- De-prioritise Jira queue, SLA timers, and 90-day plan urgency. Don't surface these unless Nick explicitly asks.
- Lead with personal energy: rest, hobbies (D&D, OU study, home tinkering), family, or anything non-work.
- If Nick asks about work topics, help him — but don't initiate work framing.
- Keep a lighter tone. Less chief-of-staff, more thinking partner.
- If Nick mentions feeling like he should be working: gently remind him that rest is part of the strategy.

Nick's interests: D&D, Raspberry Pi / home automation, Open University (MU123, TM254, TT284), cooking, reading.

Still available: vault notes, capture, calendar, todos — but frame them lightly. A weekend todo is different from a work sprint.

When Nick makes a decision in conversation, flag it with [DECISION] so it can be logged.`;
```

3. In the `streamChat` function, update the system prompt selection logic. Currently it builds `systemPrompt` as a template string. Change it to pick the right base prompt:

```js
const basePrompt = isWeekend() ? WEEKEND_SYSTEM_PROMPT : SYSTEM_PROMPT;

const systemPrompt = `${basePrompt}

---

## Live Context (auto-injected)

Today is ${today.toISOString().split('T')[0]}. Day ${dayCount} of Nick's new role.

${contextBlock}`;
```

4. Also update `buildContextBlock` — when in weekend mode, skip injecting the queue and 90-day plan blocks entirely to keep the context clean. Add a `weekend` parameter:

```js
function buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend = false) {
```

Then at the start of the function body, before building `parts`, add:

```js
  if (weekend) {
    // Weekend mode — skip queue and 90-day plan, keep daily note and todos only
    const parts = [];
    if (dailyNote) parts.push(`## Today's Note\n${dailyNote}`);
    else if (previousNote) parts.push(`## Previous Note (${previousNote.date})\n${previousNote.content}`);
    if (todos && todos.active && todos.active.length > 0) {
      const personal = todos.active.filter(t => {
        const src = (t.source || '').toLowerCase();
        return !src.includes('ms ') && !src.includes('planner');
      });
      if (personal.length > 0) {
        parts.push(`## Personal Todos\n` + personal.slice(0, 8).map(t => `- ${t.text}`).join('\n'));
      }
    }
    return parts.join('\n\n---\n\n') || '(Weekend — no work context loaded)';
  }
```

5. Pass `weekend` through in `streamChat`:

```js
const weekend = isWeekend();
const contextBlock = buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend);
```

**File: `backend/routes/context.js`**

Add a `weekend` field to the context endpoint response, and skip injecting queue/plan data on weekends:

```js
const weekend = new Date().getDay() === 0 || new Date().getDay() === 6;
result.weekend = weekend;
```

Add this near the top of the route handler, before the other `try` blocks. Then wrap the queue and 90-day plan blocks in `if (!weekend)` guards so n8n and other consumers also get the hint.

**File: `backend/routes/standup.js`** — no changes needed. The backup standup already handles weekends with `isWeekend` framing text.

---

**Frontend changes:**

**File: `frontend/src/App.jsx`**

1. Detect weekend client-side. Add a helper at the top of the component file (outside the component):

```js
function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}
```

2. Add weekend state with manual override:

```js
const [weekendOverride, setWeekendOverride] = useState(false); // true = force work mode
const weekend = isWeekend() && !weekendOverride;
```

3. Pass `weekend` and `weekendOverride` / `setWeekendOverride` down to `Topbar`:

```jsx
<Topbar
  status={status}
  queueData={queueData}
  onMenuToggle={() => setSidebarOpen(o => !o)}
  onChatToggle={() => setChatOpen(o => !o)}
  chatOpen={chatOpen}
  weekend={weekend}
  onWeekendOverride={() => setWeekendOverride(o => !o)}
  weekendOverride={weekendOverride}
>
```

**File: `frontend/src/components/Topbar.jsx`**

1. Accept the new props:

```js
export default function Topbar({ status, queueData, onMenuToggle, onChatToggle, chatOpen, weekend, onWeekendOverride, weekendOverride, children }) {
```

2. Add a weekend mode indicator in the `topbar-center` area. When `weekend` is true, show a badge. When `weekendOverride` is true (forcing work mode on a weekend), show a different badge:

```jsx
{weekend && (
  <button className="topbar-weekend-badge" onClick={onWeekendOverride} title="Weekend mode active — click to switch to work mode">
    🌿 Weekend
  </button>
)}
{!weekend && isWeekend() && weekendOverride && (
  <button className="topbar-weekend-badge work-override" onClick={onWeekendOverride} title="Work mode override active — click to return to weekend mode">
    💼 Work mode
  </button>
)}
```

Note: `isWeekend()` needs to be available in Topbar.jsx too. Either import a shared helper or inline the check: `const day = new Date().getDay(); const itIsWeekend = day === 0 || day === 6;`

**File: `frontend/src/components/Topbar.css`**

Add styles for the weekend badge:

```css
.topbar-weekend-badge {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid rgba(100, 200, 120, 0.3);
  background: rgba(100, 200, 120, 0.08);
  color: #6dc87d;
  cursor: pointer;
  font-family: var(--font-mono);
  white-space: nowrap;
}

.topbar-weekend-badge:hover {
  background: rgba(100, 200, 120, 0.15);
}

.topbar-weekend-badge.work-override {
  border-color: rgba(79, 156, 249, 0.3);
  background: rgba(79, 156, 249, 0.08);
  color: #4f9cf9;
}
```

**Note on the mobile default view:** Currently `App.jsx` sets `const isMobile = window.innerWidth <= 768` and defaults to `'capture'` on mobile. On weekends, the desktop default view could optionally stay as `'dashboard'` — don't change this, it's fine as-is.

---

## After completing both snags

1. Run `cd frontend && npm run build` — must build clean.
2. Confirm `backend/server.js` and `backend/services/claude.js` have no syntax errors (node --check if needed).
3. Summarise changes file by file, one line each.
4. Flag any judgement calls.
5. Do not commit to git.

---

## Do not touch

Everything outside SNAG-011 and SNAG-012. All previous snags are complete and verified.
