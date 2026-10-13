# SAiM Alt — A/B treatment of the SAiM desktop companion

An alternative SAiM shell, served on its own hostname, that reads the same canonical NEURO
contracts as the control. **The control (`saim.nickward.co.uk` / `sara.nickward.co.uk`) is
untouched**: no control file was changed, and the control build is byte-identical except for
`version.json`'s build timestamp.

| | Control | Alt (treatment) |
|---|---|---|
| URL | https://saim.nickward.co.uk | https://saim-alt.nickward.co.uk (attached 13 Oct 2026) · https://saim-alt-nickward.netlify.app |
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

Frame (`AltShell.jsx`, pure): the unchanged `Field` full-screen; a discreet corner (SAiM Alt
marker, Control/NEURO links, lock); a persistent bottom bar — tagline left, the five icon buttons
centre, "Updated HH:MM" (the read on screen) right.

The SAiM page (`SaimHome.jsx`) ALWAYS has a work surface — the field gives presence, the foreground
gives orientation. (A "quiet uncertainty" variant that removed the surface, e309755f, was reverted
on 13 Oct 2026: it read as an empty screensaver and said "away from the laptop" while the page was
in use.)
- **Presence** follows an evidence priority (`model.mjs → presence`): recent use of THIS page
  (memory-only, 2 min) > the desk agent (which app is in front) > a watch heard in a room (support
  only, never places Nick). It never says "away from the laptop" while the page is in use; when
  signals contradict, a compact qualifier: "Signals disagree — desk active; watch last heard in the
  living room." A NEURO activity read that cannot be true at a desk (watching TV, driving…) is not
  presented as the thread while the page is in use — it is named as "NEURO last read you as …".
- **Main work area**: NEURO's thread wording verbatim, or one compact uncertainty line; the step HE
  named; the server's lifecycle sentences; Best next place + Open only when a named step points at
  a declared app that is not already in front ("You're already in X. Carry on there." otherwise);
  "Help me move this forward" reveals the app row on request; "Bring work back" when work is held;
  and an always-present one-line Ask / Save.
- **Rail** only when it holds something: a waiting approval, a relevant transition, held work
  (count + Show held work), and context only when it helps resolve uncertainty.

### Development scenarios (`scenarios.mjs`)

For design review against stable states rather than whatever the live day is doing:
`https://saim-alt.nickward.co.uk/?scenario=<id>` with `working` (the primary design target),
`stuck`, `transition`, `judgement`, `calm`, `home`, `conflict`. Anything else — or no parameter —
is live data.
- **Alt only.** The control never imports `alt/`; the fixtures are a separate chunk loaded by a
  dynamic import only when `?scenario=` names a known id. Pinned by `saim-alt-scenarios.test.js`
  and checked against the control `dist/` (no fixture string, no scenario code).
- **Real payload shape, real renderer.** Fixtures are `/api/canonical/now` + `/api/session` +
  the page-activity flag; the live renderer draws them. Each is validated by
  `model.checkCoherence`.
- **No side effects.** Nothing is fetched or polled for the SAiM page; every write path (desk
  open, lifecycle, Bring work back, Ask, Save) returns "Scenario mode — nothing was sent to NEURO or
  the laptop." The other four tabs remain the live control screens.
- A dashed `scenario: <id> · live data` marker sits beside the SAiM Alt marker; "live data" drops
  the parameter.
- `model.leadOf` decides the ONE state that leads (transition > judgement > thread > calm >
  context), so contradictions such as "Nothing needs you right now" + "EOD outstanding" cannot
  render together.

### Tool handoff rules (`model.mjs → toolHandoff`)
- Only apps in `work.deskOffer.apps` (the agent's declared `canOpen`, intersected server-side with
  `desk-intents.APPS`) are pressable. Not at the desk / desk unseen / undeclared → nothing pressable,
  the server's reason shown.
- Top candidate: the app already in front → a tool the work text names (marked uncertain) → the
  first offered app (marked "not sure"). Never an unoffered app.
- Alternatives in fixed order: AI tools (Claude, ChatGPT — or one disabled "AI assistant" if
  neither is offered), Music (always), then Outlook, Teams, Obsidian, Excel, Word, NOVA, VANTAGE,
  NEURO, Plaud, Browser, VS Code, Terminal, SSMS, Postman — whichever the laptop offers.
- Evidence for the top pick, in order: the app already in front (certain) → the card's kind
  (email → Outlook) → a word in the work text (both marked "not certain") → first offered (a guess).
- Adding an app takes two edits on two machines: `APPS` + `BUTTON_LABELS` in
  `backend/services/desk-intents.js` (deploy NEURO), and the id → `shell:AppsFolder\<AUMID>` line in
  the laptop's `%LOCALAPPDATA%\neuro-agent\apps.json` (restart the agent). `Get-StartApps` lists
  the AUMIDs. NEURO keeps up to 32 declared apps per machine.
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

## DNS / domain (APPLIED 13 Oct 2026, authorised by Nick)

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
