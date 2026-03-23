# NOVA → NEURO O365 Bridge

## Context

NOVA (C:\Users\NickW\Claude\windows automation\daypilot) has a full Microsoft Graph
integration via McpClientManager and existing O365 routes. NEURO needs M365 data
(calendar, mail, Planner, ToDo) but can't authenticate independently yet.

This adds a locked bridge endpoint to NOVA that NEURO calls with a shared secret.
It's a deliberate dirty workaround — hardcoded to nickw / nickw@nurtur.tech only.
To be replaced with proper auth later.

## Security constraints

- Bridge only responds to requests carrying NEURO_BRIDGE_SECRET header
- Only serves data for username=nickw / email=nickw@nurtur.tech
- No new user data is exposed
- Bridge secret stored in NOVA .env only

---

## Step 1 — Add NEURO_BRIDGE_SECRET to NOVA .env

Read `C:\Users\NickW\Claude\windows automation\daypilot\.env`.

Add:
```
# NEURO bridge — shared secret for Pi-to-NOVA internal API
NEURO_BRIDGE_SECRET=neuro-nova-bridge-2026
```

Also add to `C:\Users\NickW\nick-agent\backend\.env`:
```
NOVA_BRIDGE_URL=http://localhost:3001
NOVA_BRIDGE_SECRET=neuro-nova-bridge-2026
```

(NOVA runs on localhost:3001 on the Windows machine; NEURO on the Pi calls it via
Tailscale — the URL on the Pi will be the Windows machine's Tailscale IP, but for
now hardcode localhost for local testing)

---

## Step 2 — Create bridge route in NOVA

Read `C:\Users\NickW\Claude\windows automation\daypilot\src\server\routes\o365.ts`
and `C:\Users\NickW\Claude\windows automation\daypilot\src\server\index.ts` in full.

Create new file:
`C:\Users\NickW\Claude\windows automation\daypilot\src\server\routes\neuro-bridge.ts`

```typescript
import { Router } from 'express';
import type { McpClientManager } from '../services/mcp-client.js';
import type { Request, Response } from 'express';

// Hardcoded allowed identity — this bridge is for Nick only
const ALLOWED_USERNAME = 'nickw';
const ALLOWED_EMAIL = 'nickw@nurtur.tech';

function parseToolResult(result: unknown): unknown {
  const obj = result as { content?: Array<{ text?: string }> };
  const text = obj?.content?.[0]?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

function bridgeAuth(req: Request, res: Response): boolean {
  const secret = process.env.NEURO_BRIDGE_SECRET;
  if (!secret) {
    res.status(503).json({ ok: false, error: 'Bridge not configured' });
    return false;
  }
  const provided = req.headers['x-neuro-bridge-secret'];
  if (provided !== secret) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function createNeuroBridgeRoutes(mcpManager: McpClientManager): Router {
  const router = Router();

  // GET /api/neuro-bridge/status — check bridge is up and Graph is connected
  router.get('/status', (req, res) => {
    if (!bridgeAuth(req, res)) return;
    const tools = mcpManager.getServerTools('msgraph');
    res.json({
      ok: true,
      identity: { username: ALLOWED_USERNAME, email: ALLOWED_EMAIL },
      graphTools: tools.length,
      tools: tools.slice(0, 20)
    });
  });

  // GET /api/neuro-bridge/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
  router.get('/calendar', async (req, res) => {
    if (!bridgeAuth(req, res)) return;
    const tools = mcpManager.getServerTools('msgraph');
    const toolName = tools.find(t =>
      t === 'list-calendar-events' || t === 'get-calendar-events' || t === 'list-events'
    );
    if (!toolName) {
      res.status(501).json({ ok: false, error: 'Calendar events tool not available', tools });
      return;
    }
    try {
      const args: Record<string, unknown> = {};
      if (req.query.start) args.startDateTime = `${req.query.start}T00:00:00`;
      if (req.query.end) args.endDateTime = `${req.query.end}T23:59:59`;
      if (req.query.calendarId) args.calendarId = req.query.calendarId;
      const result = await mcpManager.callTool('msgraph', toolName, args);
      res.json({ ok: true, data: parseToolResult(result) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  // GET /api/neuro-bridge/mail?count=20
  router.get('/mail', async (req, res) => {
    if (!bridgeAuth(req, res)) return;
    const tools = mcpManager.getServerTools('msgraph');
    const toolName = tools.find(t =>
      t === 'list-mail-messages' || t === 'get-mail-messages' || t === 'list-messages'
    );
    if (!toolName) {
      res.status(501).json({ ok: false, error: 'Mail list tool not available', tools });
      return;
    }
    try {
      const args: Record<string, unknown> = {};
      if (req.query.count) args.top = parseInt(req.query.count as string, 10);
      if (req.query.folder) args.folderId = req.query.folder;
      if (req.query.unreadOnly) args.filter = "isRead eq false";
      const result = await mcpManager.callTool('msgraph', toolName, args);
      res.json({ ok: true, data: parseToolResult(result) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  // GET /api/neuro-bridge/planner/tasks
  router.get('/planner/tasks', async (req, res) => {
    if (!bridgeAuth(req, res)) return;
    const tools = mcpManager.getServerTools('msgraph');
    const toolName = tools.find(t =>
      t === 'list-planner-tasks' || t === 'get-planner-tasks' || t === 'list-my-planner-tasks'
    );
    if (!toolName) {
      res.status(501).json({ ok: false, error: 'Planner tasks tool not available', tools });
      return;
    }
    try {
      const args: Record<string, unknown> = {};
      if (req.query.planId) args.planId = req.query.planId;
      const result = await mcpManager.callTool('msgraph', toolName, args);
      res.json({ ok: true, data: parseToolResult(result) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  // GET /api/neuro-bridge/todo/tasks
  router.get('/todo/tasks', async (req, res) => {
    if (!bridgeAuth(req, res)) return;
    const tools = mcpManager.getServerTools('msgraph');
    const toolName = tools.find(t =>
      t === 'list-todo-tasks' || t === 'get-todo-tasks' || t === 'list-tasks'
    );
    if (!toolName) {
      res.status(501).json({ ok: false, error: 'ToDo tasks tool not available', tools });
      return;
    }
    try {
      const args: Record<string, unknown> = {};
      if (req.query.listId) args.taskListId = req.query.listId;
      const result = await mcpManager.callTool('msgraph', toolName, args);
      res.json({ ok: true, data: parseToolResult(result) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  return router;
}
```

---

## Step 3 — Register bridge route in NOVA index.ts

Read `C:\Users\NickW\Claude\windows automation\daypilot\src\server\index.ts`.

Find the import section and add:
```typescript
import { createNeuroBridgeRoutes } from './routes/neuro-bridge.js';
```

Find where O365 routes are registered (search for `createO365Routes`) and add
immediately after:
```typescript
app.use('/api/neuro-bridge', createNeuroBridgeRoutes(mcpManager));
```

Note: the bridge route has NO authMiddleware — it uses its own secret check instead.
This is intentional. Do not add the NOVA JWT middleware to this route.

---

## Step 4 — Create NEURO microsoft.js bridge client

Read `C:\Users\NickW\nick-agent\backend\services\microsoft.js` in full.

The existing microsoft.js uses MSAL device code auth which isn't working.
Add a bridge fallback that hits NOVA when MSAL auth is unavailable.

Add at the top of the file after the existing requires:
```js
// NOVA bridge — fallback when MSAL not authenticated
async function novaBridgeFetch(path, params = {}) {
  const baseUrl = process.env.NOVA_BRIDGE_URL;
  const secret = process.env.NOVA_BRIDGE_SECRET;
  if (!baseUrl || !secret) return null;

  try {
    const url = new URL(`/api/neuro-bridge${path}`, baseUrl);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const res = await fetch(url.toString(), {
      headers: { 'x-neuro-bridge-secret': secret },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.warn(`[Bridge] ${path} returned ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.ok ? json.data : null;
  } catch (e) {
    console.warn(`[Bridge] ${path} failed:`, e.message);
    return null;
  }
}

function isBridgeConfigured() {
  return !!(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}
```

---

## Step 5 — Update fetchCalendarEvents to use bridge

Read `C:\Users\NickW\nick-agent\backend\services\microsoft.js`.

Find the `fetchCalendarEvents` function. Add bridge as Priority 2 (between MSAL
and the fallback):

```js
  // Priority 2 — NOVA bridge (when MSAL not authenticated)
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/calendar', { start: startDate, end: endDate });
      if (bridgeData) {
        // Bridge returns Graph API format — map to NEURO format
        const events = Array.isArray(bridgeData) ? bridgeData :
          (bridgeData.value || []);
        if (events.length > 0) {
          console.log(`[Calendar] Bridge returned ${events.length} events`);
          return events.map(e => ({
            id: e.id,
            subject: e.subject,
            start: e.start?.dateTime || e.start,
            end: e.end?.dateTime || e.end,
            location: e.location?.displayName || null,
            isAllDay: e.isAllDay || false,
            organizer: e.organizer?.emailAddress?.name || null,
            showAs: e.showAs || 'busy'
          }));
        }
      }
    } catch (e) {
      console.warn('[Calendar] Bridge failed:', e.message);
    }
  }
```

Insert this block after the existing MSAL/Graph block and before the ICS fallback.

---

## Step 6 — Update fetchRecentEmails to use bridge

Read the `fetchRecentEmails` function in `microsoft.js`. Add bridge fallback:

```js
  // Bridge fallback
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/mail', {
        count: maxCount || 40,
        unreadOnly: false
      });
      if (bridgeData) {
        const messages = Array.isArray(bridgeData) ? bridgeData :
          (bridgeData.value || []);
        return messages.map(m => ({
          id: m.id,
          subject: m.subject,
          from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '',
          fromEmail: m.from?.emailAddress?.address || '',
          received: m.receivedDateTime,
          isRead: m.isRead,
          importance: m.importance,
          isFlagged: m.flag?.flagStatus === 'flagged',
          preview: m.bodyPreview || '',
          hasAttachments: m.hasAttachments || false
        }));
      }
    } catch (e) {
      console.warn('[Mail] Bridge failed:', e.message);
    }
  }
```

---

## Step 7 — Test the bridge

### On Windows (NOVA side):
```bash
cd "C:\Users\NickW\Claude\windows automation\daypilot"
npm run build
# Restart NOVA server if running
```

### Test bridge status:
```bash
curl -s http://localhost:3001/api/neuro-bridge/status \
  -H "x-neuro-bridge-secret: neuro-nova-bridge-2026"
```

Should return `{"ok":true,"identity":{"username":"nickw","email":"nickw@nurtur.tech"},...}`

### Test calendar:
```bash
curl -s "http://localhost:3001/api/neuro-bridge/calendar?start=2026-03-23&end=2026-03-29" \
  -H "x-neuro-bridge-secret: neuro-nova-bridge-2026"
```

---

## Step 8 — Add Windows Tailscale IP to Pi .env

Once NOVA bridge is working locally, find the Windows machine's Tailscale IP:
```powershell
tailscale ip
```

Update Pi's `.env`:
```
NOVA_BRIDGE_URL=http://[windows-tailscale-ip]:3001
NOVA_BRIDGE_SECRET=neuro-nova-bridge-2026
```

Then restart nuero on Pi:
```bash
pm2 restart nuero --update-env
```

---

## After all changes

1. `node --check` on any modified NEURO backend files
2. `npm run build` in NOVA (TypeScript)
3. Test `/api/neuro-bridge/status` returns ok
4. Test `/api/neuro-bridge/calendar` returns events
5. Write one-line summary to `NEURO-nova-bridge-results.md`
6. Do not commit to git

## Notes

- This bridge has NO rate limiting — it's internal only, Tailscale-protected
- The `x-neuro-bridge-secret` is not a JWT — it's a simple shared secret
- NOVA's existing O365 routes are unchanged and still require NOVA JWT auth
- This can be removed once proper NEURO MSAL auth is set up
