# NEURO / SAiM remote MCP gateway

Status: implemented and locally tested; **not deployed or linked to a live OAuth provider**. Public resource: `https://pi5.tailecb90f.ts.net/mcp`.

⚠ **The originally proposed `neuro.nickward.co.uk` does not exist** — NXDOMAIN on public DNS, checked 15 September 2026. The live spelling is `nuero.nickward.co.uk` (the repo's historical typo), and that host is **Netlify static hosting, not a reverse proxy to the Pi**. `saim.nickward.co.uk` does not exist either; DNS still carries `sara.`. Both were taken from the brief rather than resolved.

This matters more than a typo normally would: the resource URL **is the OAuth audience**, and it must match byte for byte on the gateway, at the provider and in both clients. Getting it wrong is not a redirect — it is a full redo of the provider API and every client registration. It is therefore pinned to the one endpoint that is already public with valid TLS and proven path routing: **pi5's Tailscale Funnel**. Moving later to a custom domain means changing `MCP_PUBLIC_URL`, the provider identifier and both clients together.

## Architecture audit

The existing `index.js` is a Node MCP SDK server using **stdio**. It exposes focus, suggestions/approval, vault search/read/write/delete/maintenance, daily notes, people, meeting preparation, tasks, team management, health and status tools. It registers no MCP resources or prompts. Authentication is implicit local process access; backend calls use `X-Neuro-Pin` and vault `X-Api-Key`. Vault operations can fall back to a local Syncthing vault, including filesystem writes. It has no remote listener, OAuth resource metadata, public health route or gateway request limits.

NEURO's Express backend runs on port 3001. It already provides vault retrieval and write hooks, task/capture services, activity logging, device ingestion, location and SAiM signal adapters. Machine authentication accepts `X-Neuro-Api-Token` (preferred) or the older PIN. Vault routes additionally require their API key. SAiM's separate runtime is on port 3005; room and Home Assistant integrations are already mediated by NEURO. The gateway does not directly connect to Home Assistant.

Repository infrastructure references Tailscale, Syncthing, Netlify and existing public hostnames. `CLAUDE.md` documents Pi Funnel exposure and warns that loopback requests can originate from the public internet. No deployable MCP reverse-proxy or Docker configuration existed in `mcp-server`. These repository references are not verification of the currently deployed ingress.

`nuero-ios` contains Swift sensor clients and an offline outbox feeding the same NEURO backend. It does not host the MCP server. No native app changes are needed to give external ChatGPT/Claude clients access to this gateway. The active SARA → SAiM migration has widespread uncommitted changes across the shared working tree. ⚠ `mcp-server/index.js` **is** in commit `02c68bc`: the rename sweep had already edited it in the working tree when the gateway was staged, so seven `saim` references travelled with it. The content is correct — `/api/focus` emits `saim` (`routes/focus.js:191`) — and the commit message says so, but the earlier claim that this implementation left that entry point untouched was wrong and is corrected here. The iOS repository is genuinely untouched. Coordinated with the session holding the rename (`nuero-9f`), which stays off `mcp-server/**`.

```text
ChatGPT / Claude cloud clients
          | HTTPS + OAuth access token
Existing HTTPS ingress (or outbound Cloudflare Tunnel)
          | private origin connection
remote/index.js → JWT checks → Streamable HTTP MCP → bounded API adapters
                                                       |
                           NEURO :3001 (source of truth)
                                                       |
                           existing SAiM / HA / device integrations
```

The remote server uses stateless Streamable HTTP with JSON responses at `/mcp`; the SDK negotiates protocol versions. Each request gets a fresh MCP server/transport and independently validated identity. It needs no client-local data, shared session cache or sticky routing. GET/DELETE at `/mcp` return 405 after authentication; unsolicited SSE streams and legacy SSE transport are not offered. The original `npm start` remains stdio.

## Significant files

| File | Purpose |
|---|---|
| `remote/config.js`, `remote/.env.example` | Validated central configuration, legacy backend URL/PIN compatibility |
| `remote/auth.js` | JWKS signature, issuer, audience, expiry, age, subject and read-scope enforcement |
| `remote/backend.js` | Fixed backend routes, separate machine credentials, deadlines, response-size limit, safe errors |
| `remote/tools.js` | 18 typed tools, explicit classifications, bounded results and write scope |
| `remote/app.js`, `remote/index.js` | Remote transport, discovery, health, logging, limits, startup/shutdown |
| `remote/gateway.test.js` | Real SDK clients, signed test JWTs and HTTP backend fixtures; stdio regression |
| `remote/check-auth.js`, `remote/smoke.js` | Provider discovery preflight and live HTTPS smoke test |
| `Dockerfile`, `.dockerignore`, `compose.yaml` | Non-root gateway and optional outbound tunnel |
| `package.json`, `package-lock.json` | Startup/test scripts, locked dependencies and audit fixes |

## Tool catalogue

Every input is a strict Zod object: unknown keys fail validation. Every successful output is validated against the advertised schema and returned as both `structuredContent` and JSON text. Errors use `isError: true` with a safe error code. Retrieved content is data, not trusted instructions.

Common output shapes:

- **List:** `results[{id, source, title, timestamp, score, snippet}]`, `coverage`, `partial`, `truncated`. Unknown IDs/timestamps/scores are null. At most 20 results, snippets at most 900 characters.
- **Evidence:** `source`, `fetched_at`, `evidence` (JSON), `truncated`. Evidence preserves backend freshness/known/unknown fields. `fetched_at` is retrieval time, not observation time. Dynamic signal fields remain JSON during the SAiM migration; the outer contract is stable. Evidence is bounded to 20,000 text characters, 30 array entries, 60 object fields and 10 nesting levels.
- **Write:** `id`, `saved`, `partial`. No absolute backend filesystem paths are returned.

| Tool | Purpose / input | Output | Class |
|---|---|---|---|
| `memory_search` | Vault search; `query` (1–300 chars), optional `limit` (1–20, default 10) | List; search coverage marked incomplete/unverified where appropriate | Read |
| `neuro_search` | Same unified backend vault retrieval; same inputs | List; does not claim to search every NEURO store | Read |
| `memory_get` | `id` relative Markdown path; optional `max_chars` (100–16000, default 4000) | `id, source, content, truncated` | Read |
| `memory_recent` | Recent captured notes; optional `limit` | List; latest 20 capture records only, not all vault modifications | Read |
| `memory_create` | `title` (1–180 chars), `content` (1–16000 chars) | Write; generated UUID note under `MCP_MEMORY_DIR` | Write |
| `capture_memory` | Alias of `memory_create`; same inputs | Write | Write |
| `memory_update` | `id`, `content`; only an existing UUID note inside `MCP_MEMORY_DIR` | Write; replaces entire content, last writer wins | Write |
| `capture_note` | `title`, `content` | Write; verified NEURO capture filename | Write |
| `capture_task` | `text` (1–16000 chars) | Write; NEURO task ID; partial if vault copy failed | Write |
| `context_current` | No inputs; presence, phone and meeting evidence | Evidence; unavailable sections explicit; all-section failure is an error | Read |
| `presence_get` | No inputs; observed room/whereabouts | Evidence; does not establish whether another person is home | Read |
| `location_context` | No inputs; today's known location dwells | Evidence; does not infer a current location from old dwells | Read |
| `device_state` | No inputs; merged phone state and freshness | Evidence; not an inventory of all devices or proof of current interaction | Read |
| `activity_current` | No inputs; current scheduled meeting | Evidence; scheduled attendance is not observed activity | Read |
| `environment_get` | No inputs; SAiM sensor/context signal health | Evidence; no physical actions | Read |
| `events_recent` | Optional `limit`; logged events today | List, newest first; UTC backend day | Read |
| `events_search` | `query`, optional `limit`; search today's event labels/snippets | List; not a historical/global event search | Read |
| `timeline_get` | Optional `limit`; today's logged activity | List, newest first | Read |

No action/automation tools are exposed remotely. Legacy approvals, vault deletion, maintenance, arbitrary filesystem access and local fallback remain outside the remote gateway. Remote writes use existing backend services and indexing hooks. A timed-out write may already have committed: verify before retrying. No automatic write retries or cross-client deduplication are promised.

## Local development

Use Node 22 or later. From `mcp-server`:

```powershell
npm ci
npm test
Copy-Item remote/.env.example remote/.env
# Edit remote/.env locally; never paste credentials into chat or commit them.
npm run check:auth
npm run start:remote
```

On Linux use `cp remote/.env.example remote/.env` and `chmod 600 remote/.env`. Existing ignore rules cover `.env`; Docker excludes it from the image. Tests use ephemeral RSA keys and an in-process backend; no real personal data or live writes are needed. Production auth is never disabled for development. Local MCP Inspector can target `http://127.0.0.1:3100/mcp` with a token whose audience remains the configured public HTTPS resource.

`npm start` still runs the existing stdio implementation. Its environment variables and broader local trust model remain unchanged.

## Configuration

See `remote/.env.example` for every variable.

| Variable | Meaning / default |
|---|---|
| `MCP_HOST`, `MCP_PORT` | `127.0.0.1`, `3100`; Compose binds internally to all interfaces but publishes only host loopback |
| `MCP_PUBLIC_URL` | Required canonical HTTPS URL ending exactly in `/mcp`; also the required token audience |
| `MCP_AUTH_ISSUER` | Required exact provider issuer, including its trailing slash if present |
| `MCP_AUTH_JWKS_URL` | Required HTTPS signing-key endpoint |
| `MCP_AUTH_SUBJECT` | Required immutable Nick user ID; all other users rejected even with valid provider tokens |
| `MCP_AUTH_ALGORITHMS` | `RS256` (or `ES256`) |
| `MCP_AUTH_MAX_TOKEN_AGE` | Maximum token age in seconds, default 3600, maximum 86400; provider should issue short-lived tokens |
| `NEURO_API_URL` | Backend URL; legacy `NEURO_URL` accepted; default local port 3001 |
| `NEURO_API_TOKEN` / `NEURO_PIN` | Separate backend credentials; machine token takes precedence |
| `NEURO_VAULT_KEY` | Required vault API credential |
| `MCP_MEMORY_DIR` | Dedicated remote memory folder, default `MCP Memories` |
| `MCP_UPSTREAM_TIMEOUT_MS` | Default 15000; applies to headers and full response body |
| `MCP_RATE_LIMIT` | Requests per minute per source IP, default 120; in-memory, per process |
| `MCP_TRUST_PROXY` | Default `false`; only set a supplied trusted network option when origin networking excludes all other callers |
| `LOG_LEVEL` | `info`, `error`, `silent` |
| `TUNNEL_TOKEN` | Only for optional Cloudflare tunnel profile |

## Authentication setup (Auth0 reference deployment)

The gateway is an OAuth **resource server**. A managed authorization server owns login, consent, authorization-code + S256 PKCE, client registration, refresh tokens and revocation. No custom login/password flow is implemented here. Another provider works if it satisfies the same contract.

1. Create/select an Auth0 tenant and your user account. Enable MFA for the account.
2. In tenant **Settings → Advanced**, enable **Resource Parameter Compatibility Profile** and **Include Issuer in Authorization Responses**. This makes MCP's `resource` parameter select the correct API audience. [Auth0 instructions](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile).
3. Create an API named `NEURO MCP`, identifier exactly `https://pi5.tailecb90f.ts.net/mcp`, signing algorithm RS256. Add **all four** permissions: `neuro:read`, `neuro:write`, `neuro:action`, `neuro:admin`. Enable RBAC; assign only the permissions Nick should use to his role/account. Configure access-token lifetime to 900 seconds (or another short period below the gateway maximum). Ensure granted permissions appear in the OAuth `scope` claim; a `permissions` array alone is insufficient.

   ⚠ **All four, not two.** Classifying the live inventory gives **218 read, 52 write, 212 action, 30 admin**. `scopesFor` requires a kind's own scope on top of read/write, so creating only `neuro:read` and `neuro:write` leaves **242 of 512 operations — 47% — permanently unreachable**: the tools still appear in discovery and refuse every call. `neuro:action` is not an exotic edge case; POST defaults to `action` unless its domain is a local-write domain, so it carries the largest share after plain reads. Create all four at the API, then grant Nick only the ones he wants live — that is the decision point, not the API definition.
4. Register OAuth clients for ChatGPT, Claude and Inspector using each client's provided callback URL; use exact redirect matching, authorization-code flow and S256 PKCE. Use a predefined OAuth client with client ID/secret where the connecting UI supports it; otherwise enable your provider's supported MCP DCR/CIMD flow. Do not register wildcard callbacks or accept arbitrary client redirect URLs in this gateway. Provider-specific client registration must be verified in the actual tenant. [OpenAI authentication contract](https://developers.openai.com/plugins/build/auth).
5. Set `MCP_AUTH_ISSUER` to the exact `issuer` from the provider's `/.well-known/openid-configuration`, and `MCP_AUTH_JWKS_URL` to its `jwks_uri`. Set `MCP_AUTH_SUBJECT` to Nick's immutable user ID, not his email. Set backend credentials independently.
6. Run `npm run check:auth`. It checks OIDC discovery, HTTPS endpoints, advertised S256 and signing-key availability without logging secrets. Then complete an interactive OAuth flow in MCP Inspector to test client registration, consent, resource audience and scope grants. This live provider login has not been performed in this checkout.

Unauthenticated `/mcp` responds 401 with the protected-resource metadata URL in `WWW-Authenticate`. Discovery documents are public; tools, schemas and readiness are protected. Every MCP request checks the JWT signature, approved algorithm, exact issuer, public resource audience, subject, expiry, issue time, maximum age and `neuro:read`. Writes additionally need `neuro:write`; external/cascading operations need `neuro:action` and administrative ones `neuro:admin`, each on top of read and write. Insufficient-scope tool errors include a reauthorization challenge. Incoming OAuth tokens are never forwarded to NEURO.

Rotation: rotate backend credentials in NEURO and the gateway environment, then recreate the gateway. Rotate OAuth signing keys at the provider; JWKS refresh is handled by `jose`. Disable/revoke the client grant or refresh token at the provider on compromise. Already-issued JWTs may remain valid until expiry/maximum age; for immediate cut-off, stop the gateway or change its allowed subject before restart. Do not assume refresh-token revocation instantly invalidates existing access tokens.

## Production startup and HTTPS ingress

Preserve the existing NEURO website and SAiM migration. **Do not replace the hostname's whole routing table.** Keep backend port 3001 private; publish only the gateway's intended paths.

For a gateway container on the same host as NEURO, set `NEURO_API_URL=http://host.docker.internal:3001` in `remote/.env` if the backend is reachable from Docker's bridge. A backend listening only on host loopback is not reachable from a Linux bridge: in that case run the gateway directly on the Pi beside NEURO, or configure a private Docker network. Do not fix this by publishing port 3001 to the internet. A remote backend connection should use existing tailnet connectivity or validated HTTPS.

```bash
cd mcp-server
docker compose up -d --build gateway
docker compose logs --tail=50 gateway
curl --fail http://127.0.0.1:3100/health
```

### Measured on pi5, 15 September 2026

Checked rather than assumed, so the deploy is one step instead of a reconnaissance:

| Fact | Value | Consequence |
|---|---|---|
| Docker / Compose | 26.1.5 / 2.26.1, installed | The compose path above works **on the Pi**. A stopped Docker Desktop on the Windows workstation is irrelevant — it is not the deploy target. |
| `node:24-bookworm-slim` | multi-arch | Covers the Pi 5's arm64; no image change needed. |
| NEURO backend | listening on `0.0.0.0:3001` | Reachable from the Docker bridge, so `NEURO_API_URL=http://host.docker.internal:3001` is the correct value here. This is **not** the loopback-only case described above. |
| Port 3100 | free | No conflict. |
| Tailscale | 1.102.2, `--set-path` supported | The Funnel commands below run as written. |
| `/mnt/data/nuero` | has no `mcp-server/remote` yet | The gateway must be pushed and pulled onto the Pi before any of this runs. |

⚠ **If you run the gateway directly rather than in Docker, the default `node` is the wrong one.** `/usr/bin/node` on pi5 is **v20.19.2**, while `package.json` requires `>=22`; Node 22 exists only under nvm. npm will refuse on `engines`, and forcing past it runs express 5 and jose 6 on an unsupported runtime. Use the explicit path:

```bash
/home/nickw/.nvm/versions/node/v22.22.2/bin/node --env-file=remote/.env remote/index.js
```

The container does not have this problem — it pins its own Node.

### Preferred: extend the existing Tailscale Funnel on pi5

pi5 already serves `https://pi5.tailecb90f.ts.net` over Funnel with a valid certificate, and already does path routing on it (`/`, `/quest`, `/vantage`), so this needs no DNS record, no certificate and no new party in the path of a bearer token:

```bash
# on pi5
tailscale serve --bg --set-path /mcp 3100
tailscale serve --bg --set-path /.well-known/oauth-protected-resource/mcp 3100
tailscale serve --bg --set-path /.well-known/oauth-protected-resource 3100
tailscale serve status        # confirm the existing / , /quest and /vantage rules survived
```

⚠ **Funnel proxies public traffic from loopback.** A guard that trusts `127.0.0.1` is therefore a guard that trusts the internet. The gateway does not make that mistake — `/mcp` and `/health/ready` require a verified OAuth token regardless of source address — but anything added here later must hold the same line. `/health` is deliberately public and returns only `{"status":"running"}`.

⚠ The existing `/` rule already exposes the NEURO backend (port 3001) publicly behind its PIN. That is pre-existing, not introduced here, but it is the reason the MCP paths are mounted as siblings rather than the gateway being given the root.

Whichever ingress is used, route exactly these paths to private `http://127.0.0.1:3100`:

```text
/mcp
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource
/health                 optional public liveness
/health/ready           optional, gateway still requires OAuth
```

### Alternative: an HTTPS reverse proxy

Only needed if the endpoint moves to a custom domain. For an existing Nginx installation, add these exact locations inside its **existing TLS server block**, keeping the existing certificate and site routes:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 65s;
    client_max_body_size 64k;
}
location = /.well-known/oauth-protected-resource/mcp {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
}
location = /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
}
```

Validate with `sudo nginx -t` before `sudo systemctl reload nginx`. Nginx is an example adapter, not an assertion that it is installed. The existing HTTP listener must redirect to HTTPS; reject plaintext MCP at the edge. Disable caching for MCP and discovery. Do not log authorization headers or request/response bodies. The private origin accepts HTTP because TLS terminates at the trusted ingress; public HTTPS is an ingress responsibility.

### Alternative: outbound Cloudflare Tunnel

Use this if there is no suitable existing proxy. A tunnel requires no home-router port forwarding. Create/select a named tunnel in Cloudflare and configure published-application routes for the exact MCP/discovery paths above on the existing hostname, ordered ahead of its existing catch-all route. Preserve existing routes. Target `http://gateway:3100` when using the bundled tunnel container. Confirm the existing DNS route is compatible before changing it. [Cloudflare setup](https://developers.cloudflare.com/tunnel/get-started/).

Set the tunnel token only in `remote/.env`, then run:

```bash
docker compose --env-file remote/.env --profile tunnel up -d --build
```

Enable HTTPS-only access/HTTP-to-HTTPS redirect at Cloudflare and bypass caching for these paths. Do not put a Cloudflare browser-login challenge in front of `/mcp` or OAuth discovery; remote MCP clients use the gateway's OAuth flow. Pin the tunnel image to a tested digest for controlled production upgrades (the example uses the vendor's current tag).

### Deployment verification

```bash
curl -i -X POST https://pi5.tailecb90f.ts.net/mcp
# Expected: 401 and WWW-Authenticate, not a website/redirect/Cloudflare login page.
curl --fail https://pi5.tailecb90f.ts.net/.well-known/oauth-protected-resource/mcp
# Expected: resource exactly https://pi5.tailecb90f.ts.net/mcp.
```

With a short-lived OAuth access token in `MCP_SMOKE_ACCESS_TOKEN` and `MCP_PUBLIC_URL` set, run `npm run smoke`. It tests public HTTPS, auth rejection, initialization, discovery and a presence read without printing personal results. Use authenticated `/health/ready` privately to check NEURO, vault and SAiM API reachability. Liveness alone is not a backend health check. Readiness indicates endpoint availability, not that every sensor is fresh or every integration is configured.

## Connect ChatGPT and Claude

Official guidance checked 15 September 2026. Labels and availability can vary by account/workspace; server compatibility does not override client policy.

### ChatGPT Web

1. Open **Settings → Security and login → Developer mode** where available.
2. Open **Plugins**, select **+**, enter `NEURO / SAiM`, and use the public MCP URL `https://pi5.tailecb90f.ts.net/mcp`.
3. Choose/configure OAuth and supply the provider client ID/secret if the setup UI requests predefined credentials. Complete provider login as Nick and consent to read access, plus write access only if wanted.
4. Review the discovered 18 tools. In a new conversation, select the connection from the tools menu. Ask for current SAiM context, then an intentional test capture.
5. After schema changes, refresh the connection metadata and start a new conversation. [Current OpenAI connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### ChatGPT Desktop and iOS

Sign into the same account and workspace, open a new chat and select the account's NEURO plugin/connection. There is no iPhone-local MCP process and no separate NEURO data sync: all calls reach the same backend. Current OpenAI documentation says plugins work across web, desktop and mobile, with mobile limited to plugins available to that account. A private developer connection's availability still needs verification on the actual account and app versions; if it is absent, resolve workspace/plugin distribution or client availability rather than duplicating the server. Do not claim iOS acceptance testing has passed until a tool call succeeds there. [OpenAI cross-surface guidance](https://learn.chatgpt.com/docs/plugins).

### Claude Web, Desktop and iOS

Add a custom remote connector from **Settings → Connectors** on Claude Web/Desktop using the same HTTPS endpoint; configure the OAuth client and complete sign-in. Use the account-connected remote connector on other supported Claude surfaces. This is separate from a Desktop-only stdio configuration. Verify the same read on iOS. [Claude remote connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [surface guidance](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors).

### Claude Code

```bash
claude mcp add --transport http --scope user neuro-remote https://pi5.tailecb90f.ts.net/mcp
# Open Claude Code and run /mcp to complete OAuth authentication.
```

For a predefined OAuth client use Claude Code's `--client-id`, `--client-secret` (masked prompt) and `--callback-port` options, registering its exact callback at the provider. Existing local `index.js` clients can continue alongside this remote entry. [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## Test each tool

Run `npm test` for fixture-backed coverage of all 18 tools. For a live acceptance test, use MCP Inspector (`npx @modelcontextprotocol/inspector@latest`), choose Streamable HTTP, enter the endpoint, complete OAuth and call tools from its discovery list.

| Group | Representative live inputs |
|---|---|
| `memory_search`, `neuro_search` | `{"query":"MCP acceptance test","limit":5}` |
| `memory_recent` | `{"limit":5}` |
| `memory_get` | `{"id":"<ID returned by search>","max_chars":1000}` |
| `memory_create`, `capture_memory`, `capture_note` | `{"title":"MCP acceptance test","content":"Intentional test record."}` |
| `memory_update` | `{"id":"<UUID ID returned by memory_create>","content":"Updated test record."}` |
| `capture_task` | `{"text":"Review the intentional MCP acceptance test"}` |
| All six context/presence/location/device/activity/environment tools | `{}` |
| `events_recent`, `timeline_get` | `{"limit":5}` |
| `events_search` | `{"query":"capture","limit":5}` |

These live writes create real data; only run them intentionally. Test empty/stale data, read-only token write refusal, malformed IDs, and backend outages too. Do not expose an auth-bypass test endpoint. The included HTTPS smoke script is read-only.

## Security review and remaining risks

- Trust boundary: public clients authenticate before discovery/tools; only Nick's configured subject is accepted. The gateway holds independent backend credentials. No anonymous personal data access or arbitrary execution/HTTP/SQL/HA calls.
- Network: listener defaults to loopback; Compose publishes loopback only. Host/Origin checks mitigate unwanted browser origins and host routing. HTTPS, access logs and network isolation must be configured at ingress; trusting loopback as user identity is explicitly avoided.
- Secrets: environment only, excluded from image/source; known backend credential values are redacted from successful tool results, upstream error text is never returned. Logs contain request IDs, status, tool name/classification, latency and error code, not payloads or auth tokens. This is not a universal DLP filter: unrelated secrets deliberately stored inside vault notes may still be retrieved.
- Data access: `neuro:read` allows personal vault reading; this is a single-user gateway, not multi-tenant isolation. Write scope covers captures and the dedicated memory folder. The backend API credential has a broader underlying scope than the exposed gateway tools, so protect the host and environment.
- Write semantics: annotation hints do not replace scope checks. Updates are last-writer-wins; there is no optimistic-lock transaction or idempotency ledger. A timeout can leave an uncertain committed write. The gateway reports uncertainty and never automatically retries it.
- Limits: 64 KiB request bodies, 1 MiB upstream bodies, bounded tool output, backend deadlines and per-process IP rate limiting. Keep one gateway instance or use ingress-wide limits when scaling. With proxy trust disabled, proxied callers share one rate bucket; conservative but safe. No distributed limiter is implied.
- OAuth: managed provider owns login/PKCE/consent; live provider configuration, refresh/rotation behaviour and client acceptance still need testing. JWT revocation is bounded by expiry/maximum age.
- Compatibility: existing stdio functionality is retained and tested for discovery. Its broader local filesystem/action surface is not hardened by this remote gateway. Future schema additions should preserve the stable names and refresh client metadata.

## Results and troubleshooting

Local results: **23 tests passed, 0 failed**, covering unauthorized access, signed JWT checks, SDK initialization/discovery, all tools, representative reads/writes, malformed input, traversal, scopes, upstream failure/timeout/oversized or invalid response, secret-safe outputs/logs, health, Host/Origin checks, rate limiting, bounded partial context, retrieval coverage and existing stdio discovery. `npm audit` reports **0 vulnerabilities** after lockfile remediation. Compose configuration validates. Docker engine is unavailable on this Windows workstation, so image build/container runtime are **not tested** here — but the workstation is not the deploy target, and pi5 has Docker 26.1.5 and Compose 2.26.1 installed (see *Measured on pi5*). No live OAuth login, public deployment, real-backend smoke or ChatGPT/Claude client acceptance test has been performed.

| Symptom | Check |
|---|---|
| Startup fails | Required issuer/JWKS/subject, vault key and backend credential; HTTPS public URL must end in `/mcp` |
| 401 after login | Exact issuer/audience/subject; expiry, issue time, read scope and resource-parameter support |
| Write returns `insufficient_scope` | Reauthorize with `neuro:write` and grant that permission at the provider |
| HTML instead of MCP JSON | Existing ingress catch-all is taking precedence over MCP/discovery paths |
| `backend_unavailable` | Backend address/auth/vault key; no upstream body is exposed |
| `backend_timeout` | Backend latency; inspect backend privately; verify a write before retrying |
| `backend_response_too_large` | Upstream result exceeds 1 MiB; narrow the source or add backend pagination |
| Unknown/stale presence | Check SAiM sensor feeds; retrieval time must not be interpreted as observation time |
| Readiness 503 | One of NEURO/vault/SAiM endpoints cannot be read; public `/health` remains liveness only |
| 403 Origin/Host | Route preserves the public Host; MCP service is not intended for arbitrary browser-origin calls |
| 429 behind proxy | Shared bucket; configure trustworthy proxy networking or ingress limits before enabling forwarded-IP trust |
| Mobile connection absent | Same account/workspace, current app and plugin availability; no local phone server is needed |
