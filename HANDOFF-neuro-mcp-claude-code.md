# Claude Code handoff: NEURO full-access remote MCP

Date: 15 September 2026

## Objective

Finish deployment and live acceptance of the remote MCP gateway. The user clarified that if a capability exists in NEURO, MCP must expose it. The implementation now exposes the complete backend route inventory through fixed, searchable MCP operation tools.

## Repositories

- Backend: `C:\Users\NickW\Claude\nuero`
- iOS: `C:\Users\NickW\Claude\nuero-ios`
- MCP: `C:\Users\NickW\Claude\nuero\mcp-server`
- Proposed endpoint: `https://neuro.nickward.co.uk/mcp`
- Related hostnames supplied: `sara.nickward.co.uk`, `saim.nickward.co.uk`

Both repositories have extensive intentional uncommitted SARA → SAiM migration changes. Preserve them. Do not reset, clean, mass-rename, or revert unrelated files.

## Completed

The remote gateway is under `mcp-server/remote/`:

- Streamable HTTP MCP at `/mcp`; original `npm start` stdio server remains intact.
- OAuth JWT validation via remote JWKS: issuer, audience, algorithm, subject, expiry, token age and scopes.
- Protected-resource discovery at `/.well-known/oauth-protected-resource/mcp` and safe 401 challenges.
- Central validated configuration and `.env.example`; no source credentials.
- Backend adapter with fixed routes, separate NEURO/vault/D&D/capture credentials, timeouts, redirect rejection, response limits, PATCH/DELETE/multipart and safe error codes.
- Bounded metadata logging, Host/Origin checks, rate limits, request limits and liveness/readiness health endpoints.
- Initial named tools for memory, capture, context, SAiM, device, presence, events and timeline.
- Full-access tools: `neuro_capabilities`, `neuro_read`, `neuro_write`, `neuro_action`, `neuro_admin`, and `neuro_result_get`.
- Generated `remote/api-inventory.json`: currently **512 operations across 87 domains** from the mounted NEURO Express routes.
- `scripts/inspect-api.js` regenerates the inventory; the test fails if backend routes silently diverge.
- Four classifications: read, write, action, admin. GET routes with mutation switches are treated as actions. Browser login/OAuth callbacks return `interactive_required` rather than bypassing auth.
- Temporary result paging is scope-bound and expires after five minutes; NEURO remains the source of truth.
- Dockerfile, Compose profile and optional outbound Cloudflare Tunnel.
- D&D vault containment was hardened against sibling and junction/symlink escapes.

Key files: `remote/app.js`, `remote/index.js`, `remote/auth.js`, `remote/config.js`, `remote/backend.js`, `remote/tools.js`, `remote/api-catalogue.js`, `remote/api-policy.js`, `remote/api-inventory.json`, `remote/results.js`, `scripts/inspect-api.js`, `remote/gateway.test.js`, `remote/full-access.test.js`, `Dockerfile`, `compose.yaml`, `README.md`.

## Verification completed

From `mcp-server`:

```text
npm test       23 passed, 0 failed
npm audit      0 vulnerabilities
npm run catalogue:refresh  512 operations in 87 domains
```

Tests cover signed OAuth, scopes, MCP SDK initialization/discovery/reconnect, all inventory bindings, typed schemas, path/query injection, secret redaction, fixed dispatch, large-result paging, GET mutation classification, multipart/PATCH/DELETE, backend failure/timeout/invalid/oversized responses, health, rate limits, Host/Origin checks, D&D containment and legacy stdio discovery.

Not tested: Docker runtime (Docker Desktop Linux engine is stopped), live OAuth, public deployment, real NEURO backend, ChatGPT clients or Claude clients.

## Remaining work

### 1. Auth0 setup

Auth0 is the recommended simplest provider. The user must create/sign into the tenant; never request or store passwords/secrets in chat or source.

1. Enable Auth0 **Resource Parameter Compatibility Profile** and **Include Issuer in Authorization Responses**.
2. Create an API/resource server with identifier exactly `https://neuro.nickward.co.uk/mcp`, RS256, RBAC and scopes `neuro:read`, `neuro:write`, `neuro:action`, `neuro:admin`.
3. Grant Nick only desired scopes and ensure they appear in the token `scope` claim.
4. Register ChatGPT and Claude OAuth clients with exact callback URLs supplied by those clients, Authorization Code + S256 PKCE, no wildcards.
5. Set `MCP_AUTH_ISSUER` to the exact OIDC issuer, `MCP_AUTH_JWKS_URL` to `jwks_uri`, and `MCP_AUTH_SUBJECT` to Nick’s immutable Auth0 user ID.
6. Configure backend secrets locally in `remote/.env`: `NEURO_API_TOKEN` (preferred) or `NEURO_PIN`, `NEURO_VAULT_KEY`, optional `NEURO_DND_VAULT_KEY`, and optional `NEURO_CAPTURE_SESSION` for VESTA/capture-session routes.

```powershell
cd C:\Users\NickW\Claude\nuero\mcp-server
Copy-Item remote/.env.example remote/.env
# edit remote/.env locally; never commit it
npm run check:auth
```

### 2. Regenerate and test after any backend route change

```powershell
npm run catalogue:refresh
npm test
```

Do not weaken fixed route/path/credential guards. Do not add arbitrary HTTP, shell, SQL, filesystem or Home Assistant tools.

### 3. Deploy privately, then expose only MCP paths

Prefer the existing HTTPS reverse proxy for `neuro.nickward.co.uk`; otherwise use the outbound Cloudflare Tunnel profile. Do not expose backend port 3001 or open router ports.

```bash
cd /path/to/nuero/mcp-server
docker compose up -d --build gateway
docker compose logs --tail=50 gateway
curl --fail http://127.0.0.1:3100/health
```

Ingress must route these exact paths to private `http://127.0.0.1:3100` (or `http://gateway:3100` in the tunnel): `/mcp`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource`, optional `/health`, and protected `/health/ready`. Preserve existing website/SAiM routes, pass `Authorization`, disable caching and redirect public HTTP to HTTPS.

Cloudflare alternative:

```bash
docker compose --env-file remote/.env --profile tunnel up -d --build
```

Keep `TUNNEL_TOKEN` only in `remote/.env`. Pin the tunnel image to a tested digest before long-term production use.

### 4. Live checks

```bash
curl -i -X POST https://neuro.nickward.co.uk/mcp
curl --fail https://neuro.nickward.co.uk/.well-known/oauth-protected-resource/mcp
```

Expected: 401 plus `WWW-Authenticate` for the first; discovery JSON whose `resource` is exactly `https://neuro.nickward.co.uk/mcp` for the second.

Use MCP Inspector, then test `neuro_capabilities` (empty query and domain queries), `neuro_read` for status/context/tasks/vault/health/calendar/mobile, an intentional `neuro_write`, and explicitly approved `neuro_action` operations. Verify read-only tokens cannot dispatch writes/actions/admin. Verify a timed-out write before retrying; the gateway never retries writes automatically.

### 5. Client acceptance

Connect the same remote endpoint to ChatGPT Web, Desktop and iOS, then Claude Web, Desktop and iOS. Record actual tool-call results per surface; do not assume private developer connections are available on every account/workspace. Do not add client-specific state or an iOS MCP process. Use `mcp-server/README.md` for exact ChatGPT, Claude, Auth0 and ingress instructions.

### 6. Update status

After live acceptance, update `mcp-server/README.md` with the actual Auth0 issuer hostname, ingress type, Docker result, Inspector result, each client result, and any browser-only operations that remain interactive.

## Important safety decisions

“Full access” means every fixed NEURO backend operation is discoverable and callable through the authenticated registry. It does not mean arbitrary execution. Actions and admin operations need extra scopes and explicit user intent. Incoming OAuth tokens are never forwarded to NEURO. Retrieved data remains untrusted source material. Missing SAiM state stays unknown. Never log payloads, memory content, bearer tokens or secrets. Never run destructive Git cleanup in these dirty repositories.

References: `mcp-server/README.md`; OpenAI auth https://developers.openai.com/plugins/build/auth; OpenAI connection testing https://developers.openai.com/plugins/deploy/connect-chatgpt; Auth0 MCP setup https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile; Cloudflare Tunnel https://developers.cloudflare.com/tunnel/get-started/.
