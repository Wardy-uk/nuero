# SAiM Alt — A/B treatment of the SAiM desktop companion

An alternative SAiM shell, served on its own hostname, that reads the same canonical NEURO
contracts as the control. **The control (`saim.nickward.co.uk` / `sara.nickward.co.uk`) is
untouched**: no control file was changed, and the control build is byte-identical except for
`version.json`'s build timestamp.

| | Control | Alt (treatment) |
|---|---|---|
| URL | https://saim.nickward.co.uk | https://saim-alt.nickward.co.uk (pending DNS) · https://saim-alt-nickward.netlify.app |
| Netlify site | `saim-nickward` (repo-linked, autodeploys) | `saim-alt-nickward`, id `2f83b58d-8636-444f-82ac-cb1751072a1e` — **NOT repo-linked, manual deploys only** |
| Entry | `index.html` → `src/main.jsx` | `alt/index.html` → `alt/main.jsx` |
| Config | `vite.config.js`, `.env.production` | `vite.config.alt.js`, `.env.alt` (`--mode alt`) |
| Output | `dist/` | `dist-alt/` |
| Service worker / push | yes | **none** (nothing can claim the origin) |
| Screen-usage reporting | yes (`surface: 'saim'`) | **none** (would be counted as the control) |

Same backend (`https://pi5.tailecb90f.ts.net`), same PIN auth, same data. Being a separate
origin, it has its own PIN in localStorage and its own capture outbox in IndexedDB — a capture
queued here is never stranded in, or mixed with, the control's.

## What it is

Five destinations only: **SAiM · Now · Review · Capture · Controls**. Now/Review/Capture/Controls
are the control's own views, mounted unchanged. Any route they ask for that is not one of the five
(Tasks, Chat, Prep, Ritual, Who's in) opens NEURO in a new tab with a note — never a sixth screen.

The SAiM page (`SaimHome.jsx`) over the unchanged `Field`:
presence (place, desk, operation phase, each with an honest unknown) · the current thread
(NEURO's primary/current-work wording verbatim, the next step **he** named on the session or
"No next step named.", lifecycle sentences from the server's utterances) · tool handoff · next
context change (server transition, else next real meeting) · "Holding N back" with a local
Show/Hide disclosure · needs-your-judgement (a statement + "Review in NEURO", no approve) ·
"Ask SAiM or capture anything" (capture through the same outbox; ask matches offered sentences,
else chat).

### Tool handoff rules (`model.mjs → toolHandoff`)
- Only apps in `work.deskOffer.apps` (the agent's declared `canOpen`, intersected server-side with
  `desk-intents.APPS`) are pressable. Not at the desk / desk unseen / undeclared → nothing pressable,
  the server's reason shown.
- Top candidate: the app already in front → a tool the work text names (marked uncertain) → the
  first offered app (marked "not sure"). Never an unoffered app.
- Alternatives in fixed order: AI (always), Music (always), then Browser / VS Code / Terminal.
- ⚠ **There is no `ai` key in `desk-intents.APPS` yet**, so the AI slot is always shown disabled
  with "no AI tool is set up on the desk agent yet". To light it: add `ai` to `APPS` and
  `BUTTON_LABELS` in `backend/services/desk-intents.js` (deploy NEURO) AND map `ai` to a command in
  the laptop's `%LOCALAPPDATA%\neuro-agent\apps.json` + `canOpen`. Two edits, two machines.
- Presses use the existing `/api/desktop/intents` queue and report the server's lifecycle:
  waiting → claimed → opened | failed | expired. Never "done".
- The tool choice is a client-side rule (it picks a TOOL, never which work matters). If the
  experiment wins, move `toolHandoff` into NEURO beside `desk-intents.offer`.

## Build and deploy (manual — never the autodeploy)

```bash
cd saim/app
npm run build:alt                       # → dist-alt/ (includes _redirects + _headers)
cd dist-alt && tar -a -c -f ../alt.zip *   # forward-slash paths; avoid Compress-Archive
TOKEN=...   # %APPDATA%/netlify/Config/config.json → users.<id>.auth.token
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
  --data-binary @../alt.zip \
  https://api.netlify.com/api/v1/sites/2f83b58d-8636-444f-82ac-cb1751072a1e/deploys
```
Verify: `curl -s https://saim-alt-nickward.netlify.app/ | grep -o 'assets/index-[^"]*'` matches
`ls dist-alt/assets`. Local dev: `npm run dev:alt` (port 5186, proxies `/api` to
`NEURO_BACKEND_URL`).

To try it in the desktop Electron shell: `SAIM_URL=https://saim-alt.nickward.co.uk` before
launching `saim/desktop-electron` (the default launcher is unchanged).

## DNS / domain (requires authorisation — not yet applied)

nickward.co.uk is Netlify DNS (zone `6138dd04f49697e5a7cd4377`). One call attaches the domain and
Netlify creates the `saim-alt` NETLIFY record and the certificate itself:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"custom_domain":"saim-alt.nickward.co.uk"}' \
  https://api.netlify.com/api/v1/sites/2f83b58d-8636-444f-82ac-cb1751072a1e
```
No other record changes. No reverse proxy is involved (the API is reached cross-origin; NEURO's
`cors()` already answers the preflight — verified 204 from the alt origin). No traffic is
redirected from the control.

## Rollback / removal

- **Bad alt deploy:** Netlify → `saim-alt-nickward` → Deploys → publish the previous deploy (or
  `POST /api/v1/sites/<id>/deploys/<deployId>/restore`).
- **Take the experiment down:** `PATCH ... {"custom_domain": null}` (removes the hostname; Netlify
  removes its record), then delete the site `DELETE /api/v1/sites/2f83b58d-...`.
- **Remove from the repo:** delete `saim/app/alt/`, `saim/app/vite.config.alt.js`,
  `saim/app/.env.alt`, the `build:alt`/`dev:alt` scripts in `saim/app/package.json`, the
  `dist-alt/` line in `saim/.gitignore`, and `backend/services/saim-alt.test.js`. Nothing else
  references it (pinned by that test).

Tests: `backend/services/saim-alt.test.js` (23 — navigation restriction, capability gating,
honest unavailable states, non-destructive held-work expansion, isolation from the control;
gating / held order / nav / top-candidate rules mutation-checked).
