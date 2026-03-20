# Offline Resilience / Data Caching — PLAN

## Goal
Make NEURO usable when the Pi is unreachable. Cache GET responses in IndexedDB so the UI shows stale data with a clear indicator rather than a blank screen.

## Architecture

```
┌─────────────────┐
│  useCachedFetch  │  React hook — returns { data, status, refresh }
│                  │  status: "live" | "cached" | "unavailable"
└───────┬─────────┘
        │ uses
┌───────▼─────────┐
│   cacheStore.js  │  Pure utility — no React. IndexedDB via `idb`.
│                  │  put(key, data), get(key), clear()
└───────┬─────────┘
        │ reads/writes
┌───────▼─────────┐
│   IndexedDB      │  DB: "neuro-cache", Store: "responses"
│                  │  key = endpoint path, value = { data, ts }
└─────────────────┘
```

## What gets cached (GET endpoints only)

| Endpoint | Source | Poll interval |
|----------|--------|---------------|
| `/api/status` | App.jsx | 30s |
| `/api/queue` | App.jsx | 30s |
| `/api/queue?assignee=nick` | QueueTable | on-demand |
| `/api/todos` | TodoPanel | on-demand |
| `/api/todos?all=true` | TodoPanel | on-demand |
| `/api/nudges` | NudgeBanner | 30s |
| `/api/imports/pending` | ImportsPanel | 60s |
| `/api/microsoft/inbox` | InboxPanel | 60s |
| `/api/obsidian/calendar` | CalendarView | 5min |
| `/api/obsidian/ninety-day-plan` | NinetyDayPlan | on-demand |
| `/api/standup` | StandupEditor | on-demand |
| `/api/people` | PeopleBoard | on-demand |
| `/api/qa/health` | QATab | on-demand |
| `/api/qa/drift` | QATab | on-demand |
| `/api/admin/config` | AdminPanel | on-demand |

## What does NOT get cached
- SSE/streaming: `/api/chat`, `/api/nudges/stream`
- POST/mutation: `/api/todos/toggle`, `/api/imports/classify`, `/api/standup` POST, etc.
- Push subscription endpoints

## useCachedFetch hook API

```js
const { data, status, refresh, error } = useCachedFetch('/api/todos', {
  interval: null,       // polling interval in ms (null = no polling)
  transform: null,      // optional (res) => value transform
});
// status: "live" | "cached" | "unavailable"
```

**Behaviour:**
1. On mount: try fetch. If success → cache + return live data.
2. If fetch fails → read cache. If cache hit → return cached data.
3. If fetch fails + no cache → return unavailable.
4. On interval: repeat step 1.

## CacheIndicator component

Small pill in the top-bar area showing current data freshness:
- **live**: hidden (no indicator needed)
- **cached**: amber dot + "Cached · 2m ago"
- **unavailable**: red dot + "Offline"

## Implementation order
1. Install `idb`
2. Create `src/cacheStore.js`
3. Create `src/useCachedFetch.js`
4. Create `src/components/CacheIndicator.jsx` + CSS
5. Wire into App.jsx (status + queue polling)
6. Wire into remaining components
7. Deploy + test
