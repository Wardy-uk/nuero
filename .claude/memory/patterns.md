# Patterns That Work

# High-signal learnings from NEURO development. Claude reads this at session start.

- Backend is CommonJS (`require`/`module.exports`). NEVER use `import` statements in backend code. This is the single most common mistake.
- sql.js is in-memory with periodic flush. External scripts must run with server stopped or data gets overwritten on next flush.
- PIN auth is app-level middleware in server.js. New routes under `/api/*` get auth automatically. Push, SSE, and Strava OAuth endpoints are explicitly exempted.
- Machine clients (n8n) authenticate via `X-NEURO-API-TOKEN` header, not PIN. Check `req.apiClient` to identify machine callers.
- AI routing (`ai-routing.js`) decides between Claude API and local Ollama. Don't hardcode AI provider in individual services.
- Vault sync is Syncthing over Tailscale — NOT Git. Don't add Git-based sync code.
- Worker on Pi 4 is stateless. It processes AI tasks and returns results. Never add state management or database access to the worker.
- Frontend uses per-component CSS files, NOT Tailwind. Every new component needs a matching `.css` file.
- IndexedDB caching (`cacheStore.js`, `useCachedFetch.js`) provides offline resilience. API responses should be cacheable where possible.
- The repo name `nuero` is a historical typo. Don't rename it.
