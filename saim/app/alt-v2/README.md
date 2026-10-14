# SAiM Alt v2 — the actionable daily front door

The A/B treatment of the SAiM desktop companion. NEURO is the brain and control room; SAiM is
the front door Nick works from during the day. **The control is untouched** — no control file
changed, and the control build is byte-identical with or without this folder (all files except
`version.json`'s timestamp).

| | Control | Alt v2 (treatment) | Alt v1 (kept for comparison) |
|---|---|---|---|
| URL | https://saim.nickward.co.uk | https://saim-alt.nickward.co.uk | https://saim-alt-v1.nickward.co.uk |
| Netlify site | `saim-nickward` (autodeploys) | `saim-alt-nickward` `2f83b58d-…` — manual only | `saim-alt-v1-nickward` `ada5c60b-…` — manual only |
| Entry / config | `src/`, `vite.config.js` | `alt-v2/`, `vite.config.alt2.js`, `.env.alt2` (`--mode alt2`) | `alt/`, `vite.config.alt.js`, `.env.alt` with host overrides |
| Output | `dist/` | `dist-alt2/` | `dist-alt/` |
| Push / service worker | yes | **none** | none |

## Destinations — six, nothing else

**SAiM · Now · Briefing · Review · Capture · Controls.** Anything else a view asks for opens NEURO.

- **SAiM** (`SaimPage.jsx`): the current task block (`/api/adhd` → `blockNow`; state
  active / upcoming / interrupted / complete), the immediate action (the session's named step,
  NEURO's lifecycle sentences verbatim, Start / Name-the-step), the next transition only within
  30 min, tools only for a named step, and a compact Ask / Capture.
- **Now** (`NowPage.jsx`): *today's remaining open blocks*, meetings and protected time in clock
  order (`/api/task-blocks` + the canonical agenda). Finished blocks are not listed because NEURO
  only reports open ones — the page says so.
- **Briefing** (`BriefingPage.jsx`): `/api/briefings/latest?kind=daily`, verbatim; an older
  briefing is labelled as such; detail routes to NEURO → Briefings.
- **Review** and **Capture**: the control's own views, unchanged (Capture keeps its offline queue).
- **Controls** (`ControlsPage.jsx`): `/api/attention/settings` — interrupt on/off, level, quiet
  hours, pause, work/personal. It does **not** subscribe to push (the control's Controls would,
  doubling every notification), so it is this build's own page.

## Rules the tests pin (`backend/services/saim-alt-v2.test.js`, 31 tests, 16/16 mutations caught)

- **Tools:** none without a named step. With one: the recommended tool first (only if the laptop
  declares it and it is not already in front — if it is, say so), then AI, then Music if
  declared, then at most one more relevant app. Never an inventory, never undeclared.
- **Desk requests** report the server's lifecycle (waiting → taken → opened | failed | expired),
  never "done".
- **Capture** says "Saved to NEURO" only on NEURO's acknowledgement; a failure to store keeps the
  words in the box.
- **Notifications** (`routeNotification`): block / lifecycle / meeting / capture / ritual /
  briefing → SAiM; approval, sending, email/ticket/person detail, editing, admin → NEURO's own
  `?view=`. A payload naming no destination is marked `exact: false` with the reason. Deep links
  are `?tab=&record=&block=`; a stale one says the item has moved on.
- **Honesty:** blind ≠ calm, protected time without a block says so, off duty says so, an unread
  diary ≠ a diary with nothing left today.
- **Field:** `shared-ui/Field` and `fieldDrive.mjs`, unchanged; `driveFrom` is `useFieldDrive`'s
  mapping.

`fixtures.mjs` (synthetic — public repo) drives the tests and screenshots: active block,
upcoming meeting, protected block, out of hours, a notification routed to SAiM, one to NEURO.

## Deploy (manual) and rollback

```
cd saim/app && npm run build:alt2          # → dist-alt2/
# zip dist-alt2 with tar.exe -a (NOT Compress-Archive) and POST it to
#   https://api.netlify.com/api/v1/sites/2f83b58d-8636-444f-82ac-cb1751072a1e/deploys
# then check https://saim-alt.nickward.co.uk/version.json names the new entry.
```

Rollback: restore the previous deploy —
`POST /api/v1/sites/2f83b58d-…/deploys/<deploy_id>/restore` (v1 was `6acf426d74a77a8eb2f2e037`
before v2 went live) — or rebuild `alt/` with `npm run build:alt` and deploy that.

Known limit, deliberately not fixed here: `current-work.liveBlocks` reads snake_case fields, so
NEURO's own "current work" never reports a block; v2 reads `/api/adhd` `blockNow` instead.
