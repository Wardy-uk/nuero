# Offline Resilience — TODO

- [x] Audit existing fetch patterns
- [x] Install `idb` npm package
- [x] Create `src/cacheStore.js` — IndexedDB utility
- [x] Create `src/useCachedFetch.js` — hook with live/cached/unavailable
- [x] Create `src/components/CacheIndicator.jsx` — status pill
- [x] Wire into `App.jsx` (status + queue polling)
- [x] Wire into component-level fetches (TodoPanel, QueueTable, NudgeBanner, ImportsPanel, InboxPanel, NinetyDayPlan, StandupEditor, AdminPanel)
- [ ] Deploy to Pi + test offline behaviour

## Not cached (by design)
- CalendarView — dynamic date params, built-in retry logic
- QATab — dynamic filters/pagination
- PeopleBoard — per-person endpoints (15+ URLs)
- ChatPanel — SSE streaming
- POST/mutation endpoints
