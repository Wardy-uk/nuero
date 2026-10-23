# Session Handoff — 2026-10-23 (task-context previews — LOCAL ONLY, awaiting Nick's review)

Branch `task-context-previews` (worktree `.claude/worktrees/task-context-previews`). NOT pushed, NOT deployed; linking not enabled/disabled; no backfill; no link changed.
- Diagnosis (read-only, pi5): 39 links (24 suggested, 15 pinned); 10 pinned restricted, all `nightly-scan` origin links into `Meetings/2026/…` — 7 `employee-cases-note`, 3 `hr-wording`+`employee-cases-note`; tasks 344, 350, 189, 322, 369, 372, 442, 459, 460, 461. No manual restricted links, none into Security review/ or excluded folders.
- Fix: classification unchanged; `task-context.viewerOf(req)` (owner = PIN with no machine identity) → owner gets provenance, plain restriction reason, task-bounded excerpt, Open source note; kiosk/API token/MCP/in-process get title only (no path, no open route). Hard exclusions (Security review/, Archive etc., `neuro_context: exclude`) now never pinned/linked/searched — they could be origin-pinned before.
- Tests: `routes/task-context-previews.test.js` (15), `services/task-context-previews-browser.test.js` (5, Electron; screenshots with TC_SHOTS); existing task-context suites updated for the new limited shape.
- Limit to tell Nick: a PIN holder that does not declare itself a machine looks like Nick.
- Next: Nick reviews screenshots → merge → deploy (rebuild frontend + saim/app + kiosk; restart backend). The local MCP needs no change to be safe (it declares itself), but `mcp-server/index.js` prints no path for a restricted row now.

# Session Handoff — 2026-10-23 (AI gate, Settings, receipt truth, Holding the week — release checks done, LOCAL ONLY)

## DEPLOYED 23 Oct 2026 (shadow) — NEURO main 11d0631f, VANTAGE main fa2c890; live verifier ✔ shared ledger f4388203; record in docs/release-2026-10-23-…md

## Built, committed (history)
Branch `saim-budget-gate-slice` (worktree `.claude/worktrees/budget-gate`), REBASED onto main `93e6a04f`, head `ca4064ad`. Commits, evidence and the reviewed Pi steps: `docs/release-2026-10-23-ai-gate-settings-receipts-week.md`.
- B context linking in Settings only (`a26452a6`); A shared AI gate, shadow (`4ffdfe03`; VANTAGE `ai-gate-radar` `fa2c890`); C receipt truth (`5aba24d6` `e530423f` `ba845e54`); D Holding the week (`e9f50203`); ledger contract (`f71fecac` `14eb753b` `9291aac0`); test isolation (`d8ba9243` `ca4064ad`); incident (`e7e61925`).
- Evidence on `ca4064ad`: NEURO 7,867 tests — 7,843 pass, 4 fail (all also fail on clean main), 20 environmental skips; Electron 80/80 twice in parallel; two-app race 8/8; VANTAGE 310/310; four builds OK.
Nothing touched: Pi config/lock, allowances, context-linking enable/backfill, real governed actions.

## Before deploying
- Deploy NEURO and VANTAGE together (shared gate file; parity test in each).
- ⚠ **FIRST** (as nickw, no sudo): `install -d -m 0700 /mnt/data/ai-gate`, back up both `.env` files, then add `AI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db` to BOTH `/mnt/data/nuero/backend/.env` and `/mnt/data/vantage/backend/.env` — without them both servers refuse to start (by design). Exact reviewed steps: `docs/ai-gate-inventory.md` → "Pi configuration". After restarting both (wait 60 s), with Node 22: `node backend/scripts/ai-gate-verify.js --live --lock-probe` must print ✔.
- Branch REBASED onto main `93e6a04f` on 23 Oct (backup ref `saim-budget-gate-slice-prerebase-2026-10-23`).

## ⚠ Incident 23 Oct — main checkout deleted through a node_modules junction (third time)
Closed: tracked files restored; forensic audit found nothing recoverable missing (`.env`/`agent.db`/token cache were already gone since the 19 Oct incident; no uncommitted source existed). Record: `docs/incident-2026-10-23-worktree-junction-deletion.md`. Now ENFORCED by `~/.claude/hooks/guard-link-delete.js` (PreToolUse, all repos): every `git worktree remove` and any recursive delete through a junction/symlink is blocked; use `~/.claude/hooks/safe-remove.js`. Never junction node_modules into a worktree — tests read the main checkout's deps by path (`electron-driver-support.mainCheckout`).
- VANTAGE on the laptop has no better-sqlite3; its tests pass with `NODE_PATH=…/nuero/node_modules`.

## Waiting on Nick
1. Daily USD cap (and any per-class/volume caps) before `AI_GATE_MODE=enforce`; one shadow week first.
2. Radar: keep Sonnet 4.5 at ~10 runs a weekday?
3. TTS: price/allow `openai/gpt-audio-mini` and pick a `max_tokens`. Triage-shadow Mistral: price or remove.
4. Still pending from earlier: rotate the credentials in Security review/; enable context linking (now in Settings).

## Known pre-existing failures (also on clean main)
Ask/Capture byte-identical (CRLF), SOAP executor (CRLF), HiLo real-report + real-PDF route (laptop file).

# Session Handoff — 2026-10-22 (vault cleanup pass 2 — DONE)

## Done and deployed (origin/main, pi5)
- 247 of 257 archived with backups + record; 10 preflight failures left in place (see `docs/vault-cleanup-pass2-2026-10-22.md`).
- Vault Audit writers → NEURO's database (Brain Health → Reports). Archived outcome notes read-only in task-blocks.
- Live DB migrated (backup at /mnt/data/backups/vault-cleanup-2026-10-22-pass2/agent-before-migration.db); behaviour snapshot identical.
- Security review/ walled off from NEURO (c7fda2b7). Credentials still need ROTATING.

## Waiting on Nick
1. Rotate the credentials in Security review/.
2. Enable task-context linking in Brain Health when ready (the backfill).
3. Remaining triage questions (Plaud duplicates, parked projects, captures) — `docs/vault-triage-2026-10-22.md` (branch vault-triage, unpushed).

# Session Handoff — 2026-10-22 (approved vault cleanup — executed)

## Done and deployed (origin/main, pi5)
- Writers stopped (96661fbd, c861bbff + the task-context wording commit): no empty import reports, no `## SAiM Actions` in Daily notes (Activity → SAiM log instead), one rolling Hygiene Sweep.md, Vault Audit retention, no `[[Logs]]` footers.
- Windows vault cleanup applied: 57 archived, 64 edited, record `Documents/System/Vault Audit/Vault Cleanup 2026-10-22.md` (+ JSON in `Scripts/.lint-backups/vault-cleanup-2026-10-22/`, copy on pi5 `/mnt/data/backups/vault-cleanup-2026-10-22/`).
- Automatic task-context linking still OFF; nothing called its routes.

## Waiting on Nick
1. NEURO → Brain Health → Automatic context linking → "Enable automatic context linking…" → tick → "Run the backfill and enable".
2. `Daily/2026-04-04.md` keeps three `- [ ] Skills matrix` lines that sat inside the old SARA section — delete by hand if they are noise.

# Session Handoff — 2026-10-22 (Task context MVP + Holding the week cards)

## Done — COMMITTED on branch `saim-task-context` (worktree ../nuero-task-context). NOT pushed, NOT deployed.
- Task context: nightly scan (durable `task-context-scan`, 03:40), pinned/suggested/stale/removed links in NEURO's DB, manual note/project/area links, surfaces (task card, Now focus task, prepared moves, meeting prep, kiosk read-only), MCP (remote ops + 4 local tools). Model + rules: `docs/task-context.md`; CLAUDE.md entry.
- Holding the week: three cards restored on NEURO's Now with real routes (Monday report → weekly-risk, each judgement promise → its task).
- Vault cleanup MANIFEST (audit only, nothing changed): `docs/vault-cleanup-manifest-2026-10-22.md`.
- Correction 1 (42ba7f77): automatic task-context linking is OFF by default; Nick enables it in Brain Health, which runs the backfill. Deploying cannot backfill.
- Correction 2: Drafts keeps SAVED drafts (sections: confirm / work / communication / history) until the task is ticked or the draft abandoned. Live trace of tasks 350 + 358 in CLAUDE.md.

## Waiting on Nick
1. Approve (or edit) the cleanup manifest. Then: stop the writers (empty import reports, `## SAiM Actions`, dated hygiene sweeps) → archive the candidates on WINDOWS → run the backfill (`POST /api/task-context/scan` from NEURO).
2. Review + merge the branch, then deploy the normal way (NOT done here). After deploy: the 03:40 job runs nightly; first run is the backfill unless triggered by hand.

## Known, pre-existing (not this branch)
- Backend suite: 58 failures in this worktree are identical on clean origin/main (worktree has no node_modules — render/fake-indexeddb/iOS-sibling tests). mcp-server: 2 pre-existing (D&D junction test, stale VANTAGE inventory).

# Session Handoff — 2026-10-12 (Hike safety → personal email identity)

## Done and deployed (origin/main 5581392, pi5, VESTA on Netlify)
- **Hike safety** (`services/hike-safety{,-model}.js`, Life → **Hike safety** page, VESTA "Nick's walk" behind the `hike` scope, iOS `LifeHikeSafetySection`): arm with GPX + approx times → frozen route card (OS grid refs) → check-in pushes → overdue alert email to Helen (no approval: arming IS the approval; writer `hike.safety-alert`; one stated exception in build7 test 33). Edit, walking party (names + phones), Leaflet/OpenTopoMap map (`WalkMap.jsx`, a deliberate copy in frontend/ and vesta/), past walks on the map, trail = trackers merged, ≤30 m fixes, drive trimmed, mode from geometry.
- **Watch GPS track**: Health routes now carry points for Hiking/Walking (nuero-ios 8282d0a, `TrackThinning`, anchor `.r2`) → `workout_routes` → walk map draws it (`trailSource: 'watch'`). Reverses Build 17's "never coordinates" (Nick's call).
- **DMARC added** to nickward.co.uk (Netlify DNS zone 6138dd04f49697e5a7cd4377, record id 6acca41566946bfcf9a688f5): `v=DMARC1; p=none; rua=mailto:contact@nickward.co.uk; adkim=r; aspf=r; fo=1`. SPF (`include:_spf.livemail.co.uk`) and DKIM (`livemail1/livemail2._domainkey` CNAMEs → Fasthosts) ALREADY existed and resolve. Move DMARC to `p=quarantine` after ~2 weeks of clean reports.

## Waiting on the Mac
- Build both iOS apps (nuero-ios up to 8282d0a): hike section (party, edit, idle state), GPS track sending. After install, open NEURO on the phone → Health re-sends past hikes/walks with tracks → Saturday's walk (hike:6aeef77b…) draws the real 14,562-point track.

## PROGRESS — step 1 DEPLOYED (12 Oct 2026, ac2fb28, worktree nuero-mail, branch mail-identity)
- Settings → Personal email (`PersonalMailCard`): 5 mailboxes, password in agent_state `personal_mail_credentials` (never returned), Check connection (IMAP + SMTP login, Gmail Important folder found?), self-only Send test → read back over IMAP for the receiver's Authentication-Results + folder. Routes `/api/mail/{accounts,tests,accounts/:key/{credential,check,test-send}}`, config.security, gateway interactive. `services/personal-mail.js` (registry/pure) + `personal-mail-transport.js` (ONLY file allowed nodemailer — build7 test 33).
- ⚠ HOSTS VERIFIED from pi5: Fasthosts IMAP is **mail.livemail.co.uk:993** (imap.livemail.co.uk resolves but times out — the brief below was wrong); SMTP smtp.livemail.co.uk 465/587; Gmail imap/smtp.gmail.com.
- Nick's rule (12 Oct): every screen dealing with an email shows the address it sends from — `personal-mail.senderFor()` is the one answer; Settings renders it. Carry it onto every compose/approve/reply surface in step 2.
- DECIDED (Nick, 12 Oct): the personal inbox (nick@ + contact@) is a plain list, NEWEST FIRST — no AI sorting for now.
- STEP 2 BUILT (12 Oct): `mail-identity` (the one "which address" answer) + `smtp-mail` (SMTP with the Graph adapter's interface, ledger-first) + hike alert/all-clear from saim@ with work fallback + "From" on approval cards, Inbox composer, hike page. See CLAUDE.md "Personal mailboxes…". ⚠ LIVE 12 Oct 11:00: a nick@ → Gmail test (SPF/DKIM/DMARC passing; the 10:3x tests had landed in Inbox) went to GMAIL SPAM — nickward.co.uk is a new sending domain with no reputation. Risk for hike alerts from saim@ (accepted by Fasthosts ≠ in Helen's inbox; the work fallback does not fire on spam-foldering). DECIDED (Nick): alerts go from saim@ AND a copy from his Gmail — "not work"; work kept ONLY as last resort when neither can send (I pushed back; Nick can have it removed — one line in mail-identity.forHikeAlert). Built + tested 12 Oct.
- DNS 12 Oct (Nick asked): SPF tightened to `v=spf1 include:_spf.livemail.co.uk ~all` (dropped `mx a` — Netlify web hosts; Fasthosts' list 212.227.122.128/25 covers both sending servers). Verified on Netlify's NS, 1.1.1.1, 8.8.8.8, and a saim@ → Gmail send after: all pass, Inbox. Zone backup in that session's scratchpad. DMARC left p=none until the rua reports (contact@) show nothing legitimate failing.
- Live Gmail walk-through 12 Oct: watermark set at Important UIDNEXT 12700 with 0 read; test message (moved out of Spam, labelled Important) → triage (Gmail badge, lane from classification), detail read from Gmail, From = ward.nickj@gmail.com, reply PREPARED with target.mailbox gmail + From Gmail then REJECTED (nothing sent), dismiss marked it read in Gmail.
DONE since: Gmail Important intake + Gmail replies through the governed executor (see CLAUDE.md "Personal mailboxes…"). DONE: personal inbox (nick@ + contact@ newest first, saim@ bounce watch, replies from the same mailbox) — see CLAUDE.md. THEN (Nick): Gmail MOVED out of the work triage into the Personal inbox; Delete (to the mailbox's Bin) and Compose with a From dropdown (new governed type compose_email). NEXT: ASK Nick to confirm neuro@ capture-by-email before building it. Nick has a "Personal inbox check" message in nick@ to reply to (proves the reply path with a real click).
- ✅ 12 Oct: all 5 mailboxes log in (IMAP+SMTP). Gmail = ward.nickj@gmail.com, Important = `[Gmail]/Important` (imapflow leaves specialUse null — found by flag, 5a62121). Tests saim@→Gmail and nick@→Gmail: SPF pass · DKIM pass d=nickward.co.uk · DMARC pass, judged by mx.google.com, landed in Inbox. Gmail INBOX holds 114k messages (111k unread) — the watermark rule matters. NEXT: mail-identity + routing sends; Gmail Important intake. ASK before personal inbox: AI sorting or just a list? CONFIRM neuro@ capture before building it.
- Live-verified: accounts lists 5 with correct hosts/From; 409 without password; API token refused (A4); 401 unauthenticated; bundle has the card. Gate 6162/1 (known JC Ring date bomb).

## NEXT BUILD — personal email identity + personal inbox (Nick, 12 Oct 2026)
**Asks:** (1) EVERYTHING NEURO sends can go from work OR personal, "depending on who sees it"; (2) an inbox in NEURO for the personal mailboxes (contact@ and a new saim@nickward.co.uk — Nick, 12 Oct: SAiM is the one that comes to him, so mail from NEURO goes out as SAiM), SEPARATE from the work inbox.
**Facts:** mail host = Fasthosts (livemail). SMTP `smtp.livemail.co.uk` (465 SSL / 587 STARTTLS), IMAP `imap.livemail.co.uk` 993 — confirm against Fasthosts docs. Fasthosts DKIM-signs (verify in the first test email's headers: dkim=pass d=nickward.co.uk). Work = Graph (nickw@nurtur.tech).
**Mailboxes: DONE (12 Oct) — FOUR separate Fasthosts mailboxes, each one job (proposed to Nick; confirm neuro@'s role at the start):**
| Mailbox | Job | In NEURO |
|---|---|---|
| nick@nickward.co.uk | Nick. From address for mail he wrote/approved to PERSONAL people. | Personal inbox: read + reply |
| saim@nickward.co.uk | NEURO-generated mail (hike alerts, all-clears, reminders), From "SAiM (for Nick Ward)", Reply-To nick@ | Watched for bounces/auto-replies only (a bounced hike alert must be noticed) |
| contact@nickward.co.uk | Public-facing (websites, forms, sign-ups) | Personal inbox, labelled apart from nick@ |
| neuro@nickward.co.uk | INBOUND CAPTURE — mail sent/forwarded to it becomes a NEURO note/task (Capture by email) | Not an inbox; read and filed |
Credentials for all four go into NEURO Settings (never chat / repo). Work mail stays Graph.
**Gmail (Nick, 12 Oct): bring it in — ONLY Gmail's "Important" mail, ONLY new from now — and TRIAGE IT EXACTLY LIKE THE WORK INBOX** (same AI lanes, mute sender, Needs action, age-out; a Gmail badge on each card). Read `[Gmail]/Important` over IMAP with a Google app password (needs 2-step verification); record the folder's UIDNEXT on first connect as a watermark and never read below it — nothing historical, not even once. Replies go from the Gmail address (the mailbox it arrived in) — this also closes task #420. OAuth only if app passwords are blocked. ⚠ The work triage pipeline (email-triage.js, agent_state.email_triage) is Graph-shaped: add Gmail as a SOURCE on each entry rather than a second triage store, and check every reply/dismiss/mark-read path routes by source (a Gmail dismiss must not try Graph).
**Design agreed (to build):**
- Credentials per personal mailbox in agent_state, set from Settings (machine-refused, gateway interactive), never returned (the WU key / RescueTime key idiom).
- `mail-identity` (pure): decides work vs personal per message from WHO SEES IT — nurtur.tech / People notes sphere work → work; family/household/personal People + listed personal addresses → personal; replies go from the mailbox the email arrived in; mixed/unknown → ask/refuse; hike alerts → personal with work as fallback. Every sender (action-executor's governed types, hike-safety, email-sender self mail) goes through it; approval code / ledger / send-once rules unchanged whichever identity sends.
- SMTP transport (nodemailer) beside action-mail.js; SMTP has no Sent Items → verify by IMAP APPEND to Sent + read-back, or record "accepted by server" honestly.
- Personal inbox: IMAP read (contact@ + saim@), own store + own screen (Life → Personal inbox?), mark read / reply via SMTP as the same mailbox; NOT mixed into email-triage (work). Decide whether the AI triage runs on personal mail (Nick's call).
- Watch the build7/build8 scans: "no send path outside the executor" (test 33) and `email-sender` self-only — both need deliberate, named updates.

## Gotchas found this session
- Pi prints TAP, laptop prints spec — the deploy gate must parse both (`not ok N - title` / `✖ title`) and name expected failures by title. Script: scratchpad deploy.sh pattern (pull → npm install → build → test → gate → restart → gateway).
- Date bombs: any test going through a route's real clock must build fixtures off Date.now() (hike test 28, build29 test 43–47 fixed).
- Pre-existing failure still on main: JC Ring "explicit backfill…" (date bomb, other session's area). Push-test-routing flakes under full-suite load only.
- VESTA deploy = vite build + zip POST to Netlify API (CLI fails on ARM64) — memory vesta-deployment.

---

# Session Handoff — 2026-10-09 (Build 31: Personal relationships & people context)

- DEPLOYED: NEURO 0fe184a → 88bcf26 (+ docs/dedupe commit) on origin/main + pi5 (gate 6065/0, 17 skipped; frontend built; neuro-backend restarted; gateway rebuilt for /api/people). Worktree nuero-b26, branch build31 (rebased once over the ring inventory 5bb6d6c).
- New: services/people-model.js (pure), services/people.js (people-v1), routes/people.js, Life → People (PeopleCard / PeopleView), migrate-build31 (wm_people relationship_detail/sphere/importance/likes_json/merged_into), table person_decisions, Activity person-* lines, ledger BUILD_31. Writes machine-refused + gateway interactive.
- Rules: relationship only from a `relationship:` line or a stating field (direct-report: true, Nick's own manager:); corrections are written INTO the People note and audited in personal_ops_events; household = declared or HA resident role via strong identity (exact name/alias, never a first name); no auto-merge; birthdays are facts; no Now/Radar/Needs You producer; reading writes nothing; profile prose shown as "You wrote", never applied.
- LIVE: 43 notes, all work; 0 declared; 14 from fields; 28 unknown; Helen + Isaac are HA residents with NO People note (offered "Create People note"); 3 dates unlinked; 0 duplicates. Live fixes: queue no longer ranks by commitment volume; profile lines bounded + de-duplicated.
- Ledger: #408 (classify people, start with Helen and Isaac). 7 activation tasks open across builds.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 31 Personal Relationships and People Context.md; gap analysis appended. Next domain: cross-domain consolidation of the Life model.

---

# Session Handoff — 2026-10-09 (Build 30: Leisure & media)

- DEPLOYED: NEURO 7dc78c5 → c219122 → 4176aa6 (+ handoff commit) on origin/main + pi5 (gate 6030/0, 17 skipped; frontend built; neuro-backend restarted; gateway rebuilt for /api/leisure). Worktree nuero-b26, branch build30 (rebased once over the ring commits b63745a/e83bf54).
- New: services/leisure-model.js (pure), services/leisure.js (leisure-v1), routes/leisure.js, Life → Leisure (LeisureCard), tables leisure_items + leisure_observations (per-day artist/album aggregates, ≤90 days, no track titles), chat tool get_leisure, Now `leisure` block + context line for a booking, Radar dated items (fold into calendar), Activity leisure-* lines, refresh in personal-ops. Writes machine-refused.
- Rules: passive listening caps at `interest` (strong needs Nick); HA players are household; completion needs evidence; quiet ≠ abandoned; no catalogue → deterministic suggestions are continuations only; no push.
- LIVE: phone Music seeing (shuffle — 10 artists/11 albums in an hour, all "one play is not interest"); 5 HA players power-only (no title); no podcast/game/Apple Music source; cinema 21 Nov in Coming up; Continue/Hobbies empty; 0 Needs You.
- Ledger: #407 (add what you're into in Life → Leisure). Record: vault Projects/NEURO/NEURO-SAIM — Build 30 Leisure and Media Intelligence.md; gap analysis appended. Next domain: Personal relationships / people context.
- Deploy lesson: Pi prints TAP (`# fail 0`) — gate on both formats; the first script skipped the restart (done by hand).

---

# Session Handoff — 2026-10-09 (Build 29: Outdoor Life)

- DEPLOYED: NEURO f1e899a → 32cef20 → 4509e05 (+ docs commit) on origin/main + pi5 (gate 5997/0, 17 skipped; frontend built; neuro-backend restarted; gateway rebuilt for /api/outdoor). Built in worktree nuero-b26, branch build29 (rebased once over another session's d41f971).
- New: services/outdoor-model.js (pure), services/outdoor.js (outdoor-v1), routes/outdoor.js, Life → Outdoor (OutdoorCard holds HikingLoopCard), tables outdoor_routes + outdoor_activity_links, Now `outdoor` block + one presentation context line, Radar route plans + severe-weather needs_you, Activity outdoor-* lines. Writes machine-refused.
- Hike verdict untouched (Build 17 strict). Only loop change: dated hike route plans count as plans.
- LIVE: goal planned (Sat 10 Oct); 0 confirmed hikes in 26 weeks; refused 6/13/19/26 Sep + 3 Oct (not_hike) and 5 recording gaps; GPS-track channel UNPROVEN (build 243 declares it, 0 routes ever). Daylight 64 min / 5 of 5 days. Now relevant (hike tomorrow); no Needs You.
- Ledger: #405 (record next hike as a Watch workout → proves routes), #406 (Hiking workout minimum length — Nick's call).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 29 Outdoor Life Intelligence.md; gap analysis appended. Next domain: Leisure / media.

---

# Session Handoff — 2026-10-09 (Build 28: Home intelligence)

- DEPLOYED: NEURO 292d372 (+ docs commit) on origin/main + pi5 (gate 5945/0, 17 skipped; frontend built; neuro-backend restarted). No route/inventory change → gateway not rebuilt. Built in worktree nuero-b26, branch build28 (the main checkout's node_modules is still broken — use b26).
- New: services/home-intelligence.js (home-intel-v1), folded additively into /api/household/home; Life → Home rebuilt (exceptions, rooms on folds, devices problems-only, hazard capability, network, source health); Now `home.exceptions` + `home.relevant`; Activity kinds home-exception-opened/resolved (heating/network/source only); bedroom-climate.fetchStatisticsMany.
- Stores: agent_state `home_intel_inputs` (household registry, 8d hourly temp/RH means, boiler on/off) + `home_intel_state` (open + 24h-resolved exceptions). Written only by home.refresh (personal-ops, :13/:43).
- LIVE: 252 entities, 11 rooms, occupied (Nick/Helen/Isaac), heating idle (Office calling), 0 exceptions, 0 Needs You, Now relevant:false, 0 home Radar items. No hazard/door/window/energy sensors (said, never "safe"). 4 sockets long-offline since 15–27 Sep → ledger #404 (Home domain; appears on Life once world-obligations-sync projects it).
- Replay of the rules over 2–9 Oct: 3 short context episodes (Kitchen below setpoint 4 Oct; Kitchen warm+dry 8 Oct afternoon — likely cooking). Watch whether the kitchen one recurs before tuning.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 28 Home Intelligence.md; gap analysis appended. Next domain: Leisure.

---

# Session Handoff — 2026-10-09 (Build 27: Transport intelligence; vehicle finance moved into Tally)

- BOUNDARY CLOSED: NEURO's tally-vehicle.js (ssh+sqlite3), its 3 tables + vehicle_monthly_summaries and all vehicle money maths are deleted; /api/vehicle/finance/* answer 410. Tally owns car spend (src/server/intelligence/vehicle.ts, Outlook → Motoring, vehicleFinance in finance-intelligence-v1).
- DEPLOYED: Tally 7465b32 (pi-dev by copy, backup ~/tally-predeploy-20261009-1252; Netlify; pushed to GitHub). NEURO 644f393 → fb70ad7 → 90f1bbf on origin/main + pi5 (gate 5859/0; frontend built; backend restarted; gateway rebuilt). Built in worktree nuero-b26 (branch build27, own npm ci, no junctions).
- MIGRATION: Nick's 67 decisions + 9 rules imported into Tally (8 rules, 17 explicit, 50 re-derived). Export kept at pi5 /mnt/data/backups/build27/. Month compare: 6 equal, 4 differ — all Tally being more correct (pending TESCO PFS double-count, 3 car-park rows NEURO missed).
- LIVE: Captur LD65BHP TDi; MOT 5 Nov (upcoming); tax/insurance/mileage/VIN unknown. Tally: Sep £101.48, Jul–Sep £418.87; 12m + trend unavailable (only 3 consecutive complete months). Cost/mile refused (no odometer). Health incomplete_data. Needs You empty. Radar: MOT only.
- Ledger: #383 reused (mileage, tax, insurance); #398 created (make the MOT booking #374 the MOT's action).
- New: services/transport.js + GET /api/transport, Life → Transport (TransportCard), fuel fills (POST /api/vehicle/:id/fuel), vehicles.vin/first_registered/ownership_start.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 27 Transport Intelligence.md; gap analysis appended. Next domain: deeper Home.
- Known: mcp-server's VANTAGE inventory test fails (stale VANTAGE inventory, pre-existing, untouched).

---

# Session Handoff — 2026-10-09 (Build 26: Tally finance intelligence + NEURO operational finance)

- BOUNDARY: Tally calculates all finance (`C:\Users\NickW\Claude\Tally`, `src/server/intelligence/`); NEURO reads `finance-intelligence-v1` (GET /api/intelligence/contract via tally-api) and calculates nothing. finance-model.js deleted; NEURO's recurring/unusual/category/rule routes answer 410.
- DEPLOYED: Tally 449fe85 to pi-dev by copy (backup ~/tally-predeploy-20261009-1142) + Netlify (Outlook page). Tally local main fast-forwarded, NOT pushed to GitHub. NEURO 91de6ce + c8644fe on origin/main and pi5 (gate 5859/0), gateway rebuilt. Built in worktree nuero-b26 (own npm ci, no junctions).
- Live: feeds all healthy (Helen reconnected 8 Oct); household usable £81.82; 30-day forecast partial (variable salary/DWP); pressure comfortable; 35 established recurring; E.ON +£333.72/yr, Virgin +£109.20/yr; 3 unusual; category trends blocked (Aug 34% categorised); 0 synthesis, 0 finance Radar items today.
- Ledger: #396 (categorise Jul–Aug in Tally), #397 (record annual bills as Tally planned payments).
- Gap: Build 21 vehicle spend (tally-vehicle.js) still reads Tally over ssh and calculates in NEURO → Build 27 = deeper Transport; first job, move it into Tally.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 26 Tally Finance Intelligence and NEURO Operational Finance.md; gap analysis appended.

---

# Session Handoff — 2026-10-09 (Build 25: Personal Admin activation)

- DEPLOYED: origin/main + pi5 at 0df2c92 (gate 5886/0; frontend built; neuro-backend restarted; gateway rebuilt via docker compose up -d --build gateway in mcp-server/). Built in worktree nuero-b25 (node_modules, backend/node_modules, mcp-server/node_modules JUNCTIONED to nuero-b24) — do NOT git worktree remove it (it follows junctions).
- Live: Personal Admin list tracked + fresh + EMPTY. View = 2 needs-you (#383, #384), 1 open (#385), 2 recently done (#380, #382); 375 work/unclassified excluded incl. #374 (car MOT booking, work by default) until linked to the Captur. Feeds all healthy. 0 vehicle/finance/care admin records.
- Ledger: BUILD_25 created #395 (fill the Personal Admin list; personal + admin domain). #393/#394 still open but done in fact (25 project statements, 3 links confirmed) — Nick to tick.
- New: services/personal-admin.js, personal_admin_annotations table, POST /api/canonical/personal-admin/annotations (machine-refused, gateway interactive), view on GET /api/canonical/personal-admin, Life card rebuilt.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 25 Personal Admin Activation.md; gap analysis appended. Next domain: deeper Finance.

---

# Session Handoff — 2026-10-08 (Build 24: Personal projects)

- DEPLOYED: origin/main + pi5 at ae5929b (feature 1007814; gate 5838/0; frontend built; gateway rebuilt). Built in worktree `nuero-b24` (node_modules junctioned to nuero-b23's — the main checkout's node_modules is missing `accepts`).
- Live: `/api/projects`, `/personal`, `/repos`, Life → Personal projects. 18 vault projects, 30 repos in scope of 1,803 visible. 1 work (NOVA, rule), 1 personal (Hill Bagging, side-project tag), 16 unknown. 4 confirmed repo links, 3 likely. No blockers, no deadlines → Radar impact 0.
- GitHub reaches NEURO only via `backend/scripts/github-snapshot.js` on this laptop (GET only, Git Credential Manager token). Scheduled task "NEURO GitHub snapshot" daily 07:40 runs a copy in `%LOCALAPPDATA%\neuro\github-snapshot\` — re-run `--register` after changing the script or projects-model.js.
- Vault: added `Projects/NEURO/NEURO.md` (hub: parked Watch work + SAiM visual redesign, repos nuero + nuero-ios; NO status/sphere), updated `Projects/_about.md`.
- For Nick: tasks #393 (classify projects on Life → Personal projects) and #394 (confirm likely links: onemorehill, vantage, DandD).
- Shared tree `C:\Users\NickW\Claude\nuero` is still on stale local main with ANOTHER session's uncommitted training-sync removal — untouched.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 24 Personal Projects.md; gap analysis appended. Next domain recommended: Personal admin activation.

---

# Session Handoff — 2026-10-08 (Build 23: Finance activation)

- DEPLOYED: origin/main + pi5 at cfde836 (gate 5782/0, gateway rebuilt). NatWest reconnect was already done (13:26) → live validation done: Nick/Joint/Bills relinked and healthy, backfill from 29 Jun, 0 double imports; Helen stale → household partial. Live fixes: relink = data older than the link (Tally deleted the dead connection), unpaired transfers to Helen kept as transfers (45 rows), live-accounts month comparison. Follow-up ledger applied (#380–#387 linked, 0 created). #380 can be ticked; #388 unblocked.
- Validated on the real Tally read: 4 complete months (Feb–May, ~£4.3–4.6k spending), 34 strong recurring, E.ON down / Virgin up, 53% of spending has a domain, 87/122 Tally auto-rules keyed on card+date, 0 Helen merchants leaked, feed reconnect_required on all 4 accounts.
- Follow-ups: all already real tasks (#380–#388 by Sara). Personal Admin list now on the phone (12:44), unclassified, untracked = #382.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 23 Finance Activation.md; gap analysis appended. Next domain: Personal projects.

---

# Session Handoff — 2026-10-08 (Build 22: Household/Home + Tally security)

- Deployed nuero dfbdef2 + 0fc5244 to pi5 (gate 5753 / 5736 pass / 0 fail, frontend built, neuro-backend restarted, MCP gateway rebuilt). Built in worktree `nuero-b22`. Record: vault Projects/NEURO/NEURO-SAIM — Build 22 Household Home and Tally Security.md.
- Tally (finance 66b0622 + fcf398a, on pi-dev by copy): JWT secret now real (settings.json, generated on pi-dev, never printed); production refuses to start without one; forged/old tokens 401, new + MCP login 200. finance commits NOT pushed to GitHub — Nick's call.
- TrueLayer: both NatWest connections dead since 27 Jun (invalid_grant). Reconnect code deployed (relink + immediate sync from newest txn). WAITING ON NICK: Settings → TrueLayer → Connect bank (his NatWest, then Helen's). Then verify relink/retire/newest dates/24 Jun–10 Jul backfill.
- Live home: occupied, 1 household task (test reminder), 5 offline devices, 0 low batteries, no hazard sensors, Needs You empty.
- For Nick: reclassify Bathroom + Ikea to Home (recommended, not done); Personal Admin list not on the phone yet.
- Next domain recommended: Finance (after the reconnect).
- Main tree still behind origin with another session's uncommitted training-sync removal — untouched.

---

# Session Handoff — 2026-10-08 (Build 21: vehicle intelligence + Tally finance ingestion)

- Deployed nuero 9a4ae3f + 133e6be to pi5 (gate 5736/0, frontend built, neuro-backend restarted, MCP gateway rebuilt). Built in worktree `nuero-b21` (own `npm ci --ignore-scripts`). Record: vault Projects/NEURO/NEURO-SAIM — Build 21 Vehicle Intelligence and Tally Finance Ingestion.md; gap analysis appended.
- Live: all 7 reminder lists tracked (21A done). Captur created (Renault, 65-plate, diesel; reg/mileage/dates unknown). First Tally read: 1,150 → 44 kept, 43 awaiting Nick, 0 confirmed. No Personal Admin list on the phone yet.
- ⚠ Tally JWT secret is the public fallback 'dev-insecure-secret' (finance repo auth.ts:16) and Tally is public — told Nick; NOT changed (Build 21 forbids Tally changes). Tally's TrueLayer sync dead since 26 Jun.
- ⚠ Main tree `node_modules` was broken at 11:15 (unmet deps everywhere, likely another session's install ~10:25). I restored only array-flatten@1.1.1 there. Whoever owns that tree: `npm ci --ignore-scripts` fixes it (better-sqlite3 13 ships prebuilds; a source build fails on Node 25 ARM64).
- Other session's training-sync removal still uncommitted in the main tree — untouched.
- Next: Nick's ten minutes (vault note §21), then Build 22 = Household/Home.

---

# Session Handoff — 2026-10-08 (Build 20: Ember care + personal-ops activation + anniversary lead reminders)

- Deployed nuero caf5ac9 then 4222399 to pi5 (gate 5678/0, gateway 49/0, frontend built, MCP gateway rebuilt). Record: vault Projects/NEURO/NEURO-SAIM — Build 20 Ember Care and Personal Operations Activation.md; gap analysis appended.
- Reminder lists: name rule GONE. Live: Alexa Shopping List, Family, Shopping tracked; both "Reminders" (List 1/2 of 2), Bathroom, Ikea UNDECIDED until Nick chooses — the one reminder NEURO used to read is hidden until he tracks List 1.
- Open Uni reclassified Home -> Learning (as Nick). Anniversary lead reminders [10,5,1] set live: Radar context from 9 Oct, prompt 14 Oct, one push 18 Oct 09:00 unless linked prep is done.
- Waiting on Nick's data: Personal Admin list + MOT/insurance dates, Ember care items, anniversary prep task. Next domain recommended: transport/vehicle.
- ⚠ The MAIN working tree (C:/Users/NickW/Claude/nuero) is behind origin and holds another session's uncommitted training-sync removal, which overlaps scheduler.js, authority-matrix.js, api-inventory.json and CLAUDE.md that Build 20 changed: stash, pull --ff-only, pop, then regenerate the inventory. Build 20 was built in worktree C:/Users/NickW/Claude/nuero-b20 (branch build20) — remove it once main is synced.
- nuero-63 (medical records session) was told to rebase onto 4222399 and regenerate the inventory.
# Session Handoff — 2026-10-08 (medical records from the NHS app)

- Live on pi5 at 79db704: LIFE → Medical page, /api/medical/{records,records/:id,tests/:name,scan}, table medical_records. Gateway offers get_medical_records, get_medical_tests_by_name, post_medical_records (ChatGPT path), post_medical_scan; delete is Nick-only (403 for machines, interactive in gateway).
- NOT proven: a real vision read of an NHS screenshot (no model call made in tests), and a real ChatGPT post. First real use should be checked against the screenshot.
- Medical record is empty (0 rows). Records are not in the vault/embeddings/Notion; chat cannot read them (no chat tool) — a possible follow-up.
- Shared tree still holds another session's uncommitted training-sync removal (server.js, scheduler.js, authority-matrix.js, mcp-server/index.js, api-inventory.json, CLAUDE.md row, staged deletions). Untouched; they must rebase onto main (79db704) and re-run catalogue:refresh.

---

# Session Handoff — 2026-10-08 (Build 18 follow-up: NEURO iOS launch crash)

- SAiM 0.1 (241) installed and reporting: build identity, device status, 60-day calendar coverage and personal-date coverage all PROVEN live. It was built from a DIRTY Mac tree (77f90fc + uncommitted changes) — check `git status` on the Mac first.
- NEURO iOS crashes on launch: CLMonitor.init NSAssertion from LocationTracker.startMonitor (geofencing, first real run, iOS 27.0). Fix nuero-ios a50b5fa = geofencing OFF by default (`neuro.geofence.enabled`), unbuilt. Server 16e75de (live) judges geofence only as a place capability.
- EVENING: on the Mac — sort the dirty tree, `git pull && bash reinstall.sh neuro`, open NEURO, confirm /api/setup/native shows its commit and location/health/calendar go fresh. Then run NEURO from Xcode with the switch on to read the CLMonitor assertion text, before re-enabling geofences. Rest of runbook: docs/build-18-mac-runbook.md.

---

# Session Handoff — 2026-10-08 (Build 19: personal operations + Future Radar)

- Deployed nuero a0af05c to pi5 (gate 5642/0, frontend built, neuro-backend restarted, MCP gateway container rebuilt). Live: /api/canonical/radar?days=7|14|30, /reminder-lists, /obligations, /personal-admin; Life page has Future Radar, Personal admin, Reminder lists cards; Now carries a 7-day `radar` block.
- Committed via a clean worktree (HEAD + Build 19 only) because ANOTHER SESSION's training-sync removal is still uncommitted in this tree (server.js, scheduler.js comment, authority-matrix line, mcp-server/index.js, api-inventory training entries, CLAUDE.md row, staged deletions). Left untouched; they must regenerate the inventory when they commit.
- Live facts: phone sends 2 reminders across 7 lists; 0 personal-admin data; Radar 30d = 5 hikes + anniversary 19 Oct + Julie 25 Oct, nothing needs action. Per-list reminder counts appear after the next push.
- For Nick: both "Reminders" lists ride the built-in-name rule; Bathroom/Ikea classified but not read; Open Uni classified Home. Next domain recommended: Ember/care (not built).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 19 Personal Operations and Future Radar.md; gap analysis appended.

---

# Session Handoff — 2026-10-07 (Build 18: native identity + personal-data integrity — SERVER HALF)

- Mac OFFLINE all session → NOTHING native proven. Build 18 is NOT complete. Do docs/build-18-mac-runbook.md on the Mac (18A–18M), record evidence in vault Build 18 note § Mac day.
- nuero 709b3a4 (Pi gate 5528/0, frontend built on Pi); weather session's f29e06a on top, THEY own the restart. nuero-ios 77f90fc pushed, UNBUILT (X-Neuro-Build, 60-day calendar window + kinds, route permission report, reinstall.sh stamps commit/dirty/commit-count).
- New: /api/setup/native (builds + capability states + visits/geofence), /api/apple/calendar/coverage, /api/loops/personal-dates/{entities,declared}. Setup: build items, SAiM device status, workout routes (done only when a route arrives).
- Live facts: 0 visits/region events ever, 0/53 workouts with a route, phone diary pushed only 15 days (4 events) — thin is explained, not proven broken.
- Degradation replay 17 Aug–7 Oct: threshold 3 → 0 investigations; left unchanged.
- After the Mac day: flip device.saim-ios to expected in native-sources.js.
- Shared working tree: cron-once.js + scheduler hunk (another session) still uncommitted; runtime-jobs "wraps every node-cron job" fails locally until they land it.

---

# Session Handoff — 2026-10-07 (Build 17: repeated degradation, personal dates, hiking rule, legacy prep retired)

- Deployed nuero 25f2f27 to pi5 (gate 5510/0; MCP gateway rebuilt). nuero-ios dbf53da (route summary) PUSHED, UNBUILT (Mac tonight: build + swift test + install; prove a Hiking workout route arrives with pointCount and confirms without Nick; Health permission prompt for routes; .r1 anchor re-read).
- Hiking: GPS track within 24h or Nick only. Live reclassification: 6/13/19/26 Sep + 3 Oct = not a hike; 6 Aug + 29 Aug = can't tell. No route reaches NEURO until the iOS build.
- Degradation investigation live (job :17/:47); replay on 5 days of spine: threshold 3 → 0 investigations. Re-replay in a fortnight (di.replay()).
- Personal dates live: wedding anniversary 19 Oct (nothing needed). Tracey Allen's 16th (Fri 9 Oct) was REMOVED from the phone's diary on 4 Oct — tell Nick; the phone's push is thin (4 events / 23 calendars).
- Legacy meeting-prep RETIRED (switch 'Legacy meeting-prep pushes' brings it back).
- ⚠ ANOTHER SESSION has uncommitted backend/services/cron-once.js (+test) and a scheduler.js top hunk (node-cron double-fire fix); runtime-jobs 'wraps every node-cron job' test fails until they update it. I committed ONLY my scheduler hunks. HANDOFF-neuro-mcp-claude-code.md is not mine either.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 17 Repeated Degradation and Personal Dates.md; gap analysis appended.

---

# Session Handoff — 2026-10-07 (Build 16: native reliability + convergence)

- Deployed nuero 2eddf98 + 1e241ce to pi5 (Pi gate 5458/0 on 2eddf98). nuero-ios 8733c2c PUSHED, UNBUILT (Mac: swift test, build both apps, install, then the real-device runbook in the vault Build 16 note section 5).
- Phone runs 58df50a (inferred; apps send Neuro/1 so the server can't name it). Place-sensing was never installed (0 visits, 0 region events).
- Durable location queue (NeuroKit DurableQueue) compiled + tested under swift:6.0 in docker on pi5 (27 pass, 2 mutations) — scratch package recipe: copy the Foundation-only files + a stub NeuroAPIClient.APIError, `docker run --rm -v /tmp/nk:/nk -w /nk swift:6.0 swift test`.
- Free standup is a meeting again (calendar_cache.is_organizer fills on next sync — verify Team Standup row shows 1). Legacy meeting-prep stays live, fixed (solo blocks, per-occurrence key). Hiking confirm window 120 days.
- For Nick: confirm/deny 19 Sep (likely) + planned Saturdays; product call on "role + last 1-2-1" pushes (that retires legacy prep); Build 17 = Mac day, then repeated-source-degradation investigation, then personal dates.
- Another session was editing standup-session.js / task-blocks.js / chat-tools.js concurrently — not touched, not committed by me.

---

# Session Handoff — 2026-10-06 (Build 15: Activity, safe self-heal, meeting age bound, hiking loop)

- Deployed nuero 5ba6338 → 2922a68 to pi5 (Pi gate 5361/0 before restart; local 5376/0). MCP gateway rebuilt (hike-write routes interactive). No iOS work.
- Live: SYSTEM → Activity (`/api/activity/timeline`); Life → hiking card (`/api/loops/hiking`, this week "Saturday hike planned", forecast rain 13.5°C); canary source `neuro.selftest`; self-heal switch "Let NEURO retry a stopped sync by itself" (default ON).
- Commitment-risk: the 22 findings from the 21 Sep standup resolved on the first pass (dry-run on a snapshot first: 28 → 6, nothing else moved). Standup write-ups can link again (free is a tie-breaker).
- Self-heal PROVEN live on the canary: first run MEDIUM and correctly refused (blind-state holds reason codes, so a failure class was one fact); fixed with ONE new probe (provider-check); second run 14:35 UTC High → A1 retry → 14:40 verified recovered. All in Activity.
- Not done / for Nick: old meeting-prep stays live (parity 2/5 days, 3 old-only — two are the old pipeline firing on solo blocks); confirm or plan hikes on Life; iOS homework untouched (nuero-ios 9ac7f0f + other session's uncommitted 5 Oct place-sensing files).
- Known: `one-to-one-cadence-routing.test.js` fails as a whole file intermittently in parallel runs (pre-existing, passes alone); `due-ahead-render.test.js` and `one-to-one-cadence-state.test.js` contain literal backspace bytes (pre-existing, untouched); mcp-server's VANTAGE inventory test is stale (known, out of deploy path).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 15 Safe Self-Healing and Activity.md; gap analysis appended.

---

# Session Handoff — 2026-10-06 (Build 14: authority matrix + bounded investigation)

- Deployed nuero f8dca93 to pi5 (Pi gate 5320/0; local 5335/0). SAiM backend restarted (now authenticates with NEURO_KIOSK_TOKEN, added to BOTH .env files). MCP gateway container rebuilt; live gateway shows post_rooms_by_key_accept interactive. Local MCP server change takes effect on next Claude Code restart.
- Live checks: passthrough 410 (token and PIN), machine approve/flag/escalation/room 403, declared machine + PIN 403, kiosk room accept reaches the route, machine reads 200, investigations route 200 (empty).
- Investigation: durable job source-blind-investigation live; historical replay 13 findings → 0; controlled run on a DB snapshot copy proved detect → high-confidence agent-not-running → open-app (not executed) → recovery resolves + cancels. Copy deleted.
- Not done / for Nick: merge duplicate tasks #283/#333 (Parsons breakdown); old meeting-prep stays live (parity evidence continues); commitment-risk latest-occurrence rule has no age bound (Build 15); iOS homework untouched (nuero-ios 9ac7f0f + other session's uncommitted 5 Oct place-sensing files).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 14 Bounded Autonomous Investigation.md; gap analysis appended.

---

# Session Handoff — 2026-10-06 (Build 13: activation + autonomous reliability)

- Deployed nuero 01398c7 + 0711948 to pi5 (full suite green locally 5289/0; Pi test gate passed before each restart). nuero-ios 9ac7f0f pushed, UNBUILT.
- Live now: HA presence on the spine (/api/events/world/presence: Nick work, household Helen+Isaac); source-blind LIVE behind 30h/failing threshold, kill switch Settings → "Tell me when a sense has really stopped" (ON); Jira escalation human-only + ledgered; Planner/To Do completion converged + read back.
- DONE: governed calendar proof pa_ea693960ea35d2ad approved 12:35 and VERIFIED by read-back (201, all checks true). Still for Nick: classify 7 reminder lists (Reminders x2), add relationship:/household: to family People notes.
- ⚠ nuero-ios has ANOTHER session's 5 Oct place-sensing changes UNCOMMITTED (LocationTracker, AppState, SaimState, APIClient, HealthSync, DeviceReporter, PlacePayload). Location durable queue + the two `transient: OutboxQueue.isTransient(error)` call sites (AppState ~230, SaimState ~1339) are blocked until that is committed or dropped.
- Not done: legacy meeting-prep parity (needs role + last-1-2-1 in meeting-intelligence); NOVA PATCH passthrough unwhitelisted; MCP gateway too broad on action routes; Confluence not published (record contains household/family details — Nick's call).
- client-routes.test.js flaked once in a full parallel run (subtests all passed; passes alone).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 13 Activation and Autonomous Reliability.md; gap analysis appended.

---

# Session Handoff — 2026-10-04 (Build 12.4: watch proof prep + native makeover)

- Windows only, no Mac route: NOTHING ran on a phone or watch. The acceptance test (SAiM in the real face picker) is NOT done. Mac steps: docs/build-12.4-mac-runbook.md.
- Deployed nuero 6e006e8 to pi5 (tests 5166/0 fail on the Pi): synthesis themes carry `sentence` + `support`; verified live.
- nuero-ios 10c8f42 PUSHED, UNBUILT: SituationScene beats, one hero per mode, chip correction, edgeless ask; SaimWatch now signed with its App Group (was missing, read returned silently); reinstall.sh warns when the complication appex/group is missing.
- Still to do on the Mac: add the SaimWatchComplication target in Xcode, prove the group in the signed .appex, picker photo, synthetic P0 table, device screenshots vs vault 12.4-layout-MOCK-not-device.png.

---

# Session Handoff — 2026-10-04 (Build 12.3: synthesis + watch attention)

- Deployed nuero a49a20a (+ wording fix) to pi5; tests green; live /api/canonical/presentation carries `synthesis` + `p0`. Live synthetic P0 inject → count 1 eligible → cleared → 0, verified.
- nuero-ios 8626397 COMMITTED, UNBUILT: Mac must `swift test` (Build123SynthesisTests), build SAiM, screenshot the Sunday (12.3S acceptance: does it read as interpreted?).
- Then E2E proof: POST /api/canonical/needs-you/synthetic {"kind":"escalation"} with PIN, lock phone, open/wait for SAiM, tap alert (watch or phone), DELETE the synthetic. Setup → "Prove an urgent alert" turns done only on opened.
- Watch app still cannot install (free profile; WATCH-WITHOUT-XCODE.md) → 12.3T blocked; decision for Nick: paid Apple Developer account vs Xcode 27 Mac.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 12 Adaptive Ambient Surface.md § Build 12.3.

---

# Session Handoff — 2026-10-04 (Build 12.2: native composition reset + watch complication)

- nuero-ios 0f43f2d PUSHED, UNBUILT. The Mac had Remote Login off, so nothing was compiled, installed or screenshotted. Steps are in `docs/build-12.2-mac-steps.md`.
- New: `NativeComposition` (three compositions chosen by mode: calm, upcoming, attention), rewritten `SituationView`, ask moved into the flow, content-safe mesh frame, quieter nav, evidence in a sheet, ⋯ menu, a way back from the classic surface.
- Watch: `ComplicationContent` + `WatchPresentationSnapshot` (App Group), complication rewritten to read presentation-v1, watch app writes on bootstrap/foreground, two new entitlements files. The TARGET still has to be added in Xcode. Test 17 stays red until it is.
- PWA untouched by design (native first). Vault Build 12 note has a Build 12.2 section.
- Next: on the Mac, swift test → build SAiM → iPhone screenshot vs IMG_0415 → iterate → add the watch target → install → put it on a face.

---

# Session Handoff — 2026-10-04 (Build 12.1: visual composition)

- Deployed nuero d9ced5d + 2068bb0 to pi5 (desktop + kiosk built, 5124 tests 0 fail before restart). PWA on Netlify confirmed by bundle content. Pi 4 wall panel reloaded and captured — unchanged.
- New: phone focal object, grouped context (`groupContext`), activity pill, "What this is based on" attached, "Show me everything" disclosure (was missing on the PWA situation layout), `AskDock`, reading scrim, field fills the screen, phone context cap 5. Household label now "X and Y are home".
- nuero-ios b11aa1b + ba79179 COMMITTED, UNBUILT: SituationView rewrite, dock, quieter nav, `ContextGroups`/`.focal`, Build121CompositionTests. On the Mac: swift test, build SAiM, install, screenshot the live Quiet Sunday state and compare with vault `Build 12 screens/12.1-after-live-sunday-phone-440.png`.
- Watch: `SaimWatchComplication/SaimComplication.swift` has NO target in Neuro.xcodeproj — never built, hence zero complications. Add a watchOS Widget Extension target on the Mac (Nick raised the watch being basic; not started).
- Not done: looking at the real iPhone PWA; bedtime room duplicate (composer); Confluence (Atlassian MCP not authorised).
- Harness for visual checks: render real Situation+Field+AskDock in headless Chrome (scratchpad, recipe in vault 12.1 section) — Chrome will not go below ~500px wide, so pin body width and crop.

---

# Session Handoff — 2026-10-04 (Set-up wizard)

- Deployed nuero 8aefb5d + fix to pi5 (tests green before restart). NEURO desktop → SYSTEM → Set up; GET /api/setup. Windows: `powershell -ExecutionPolicy Bypass -File desktop-agent\setup.ps1` (laptop reports clean). nuero-ios 9c43a1c: Set up in NEURO menu + SAiM Controls (sheet) — UNBUILT.
- Live open items: APNs key on the Pi (blocks push for both apps), approval code, reminders stale on both apps, 12 calendars unclassified, no goals, no Ember note.

---

# Session Handoff — 2026-10-04 (Build 12: adaptive ambient surface)

- Deployed nuero b3973c3 → 640da96 → 7ad193e to pi5 (desktop + kiosk built, tests green on the Pi before each restart, neuro-backend + saim-backend online). PWA on Netlify serving the new bundle (verified by content, not by eye).
- New: `presentation-v1` on /api/canonical/now (+ GET /api/canonical/presentation), shared `saim/shared-ui/presentation/` renderer + budgets, default `layout='situation'`, kiosk ambient chrome, desktop Now uses the desktop profile. Duplicate birthday folded live.
- Pi 4 desk panel restarted and photographed — matches the target. Study tablet unreachable over ADB (no route); when back, add `?mic=1` to its start URL.
- nuero-ios 9c49caf COMMITTED, UNBUILT: Presentation.swift, SituationView.swift, SurfaceView wiring, Build12PresentationTests. On the Mac: swift test, build, look at it.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 12 Adaptive Ambient Surface (screens in `Build 12 screens/`); Gap Analysis appended. Not on Confluence (Atlassian MCP not authorised).
- Untracked `HANDOFF-neuro-mcp-claude-code.md` in repo root is not mine — left alone.

---

# Session Handoff — 2026-10-03 (Build 11: personal world model + governed calendar)

- Deployed nuero 87af6d5/83944da to pi5 (frontend built, tests 5042/0 fail on Pi, neuro-backend restarted, gated on tests). Kiosk untouched.
- New: calendar/reminder-list classification (Life screen), reminders as canonical tasks (eventkit-reminders), stated relationships, Ember as a companion (type: pet), goals with importance/links on the spine, personal-deadline evaluator (SHADOW), off-duty later-unknown, governed create/reschedule/cancel_calendar_event behind NEW switch "Send approved calendar changes" (OFF). 1-2-1 Book/Move, composer with attendees and chat create_meeting now PREPARE.
- nuero-ios f16b795 COMMITTED, UNBUILT: calendar ids, reminders with ids from every list, canonical Now in both apps. On the Mac: swift test, build both, install; then flip `reminders.*` to expected in backend/services/native-sources.js.
- Live personal data is still empty: 0 goals, 0 companions, 0 classified calendars, 0 reminder tasks (old builds send no ids). Nick's to do: classify calendars/lists on Life, write goals, create Companions/Ember.md.
- One validation invite (to nickw@, 2026-12-31) was prepared as a machine client and REJECTED with a note — expect it in Actions history.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 11 Personal World Model and Sensing (incl. restorative-drift readiness and updated domain matrix). Not published to Confluence (Atlassian MCP not authorised this session).
- Not done: logged-in visual check of Life/Actions; mcp-server VANTAGE inventory gate still fails (pre-existing).

---

# Session Handoff — 2026-10-03 (Build 10: canonical UI + Nick-first Now)

- Deployed nuero 4466f6c/9bb8da9 to pi5 (frontend + kiosk built, tests 5004/0 fail, neuro-backend + saim-backend restarted). Phone PWA live via Netlify.
- New: /api/canonical/* (now, commitments, sources, findings, life, goals, annotations); NEURO screens Commitments, Sources, Findings, Life; Now reads /api/canonical/now.
- Retired: Briefing/Focus (→ Now), SAiM Today/Focus, KPI Tracker (→ VANTAGE), QA, Strava, /api/focus (410), kiosk engine, sara/ + _incoming-daypilot-sara/ (docs archived into saim/attractor).
- nuero-ios e329cd4 COMMITTED, UNBUILT: run `cd NeuroKit && swift test` + build both apps on the Mac.
- ⚠ Obsidian Sync wedged both ways since ~14:28 3 Oct (Pi lacks Builds 6–10 notes; Pi had the newer Target Architecture, copied to Windows by hand). Restart Obsidian on Windows (see memory obsidian-sync-wedge).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 10 Canonical UI and Nick-First Now (includes the life-domain maturity matrix and Build 11 plan).
- Not done: logged-in visual check of new screens (browser harness wouldn't start); mcp-server VANTAGE inventory gate fails (pre-existing, VANTAGE's to refresh).

---

# Session Handoff — 2026-10-03 (Build 9: surface convergence)

- Deployed nuero e0d1366 to pi5 (frontend + kiosk built, tests green, neuro-backend restarted). Phone PWA live via Netlify.
- nuero-ios a3c7928 COMMITTED, UNBUILT: iOS Actions decode fix (pending vs actions), governed queue read-only, phone never approves outbound older-queue kinds, SAiM iOS approvals line. Run NeuroKit tests + build on the Mac.
- First live sighting of the SAiM "Needs you" line will be Monday's weekly risk report once queued. Send switch is still OFF.
- Record + target surface map: vault Projects/NEURO/NEURO-SAIM — Build 9 Surface Architecture and Convergence. Build 10 = govern invites, first world-model screens (Commitments, Sources), retire kiosk stateEngine.
- For Nick: delete untracked sara/ and _incoming-daypilot-sara/; decide merges (Briefing/Focus/Today), KPI Tracker to VANTAGE, retire qa/strava.

---

# Session Handoff — 2026-10-02 16:00

## What was done (all deployed to pi5 and verified live unless marked)
- **Fire tablet layout** — headline clamp could shrink, shelf wrapped into the cards; fixed for short landscape (`Approach.css`).
- **Screens follow place + time** — display verdict carries `place`/`area` + `night{dim}` (21:00–07:00, setting); NightDim overlay, Fully brightness and Pi backlight agent obey one flag; household board on home screens (`/api/rooms/board`, VESTA redaction); work Fire keeps its clock.
- **Life-state** — `services/life-state.js`: what Nick is doing + evidence + `showWork`; asks "What are you up to?" when it's a guess; gate + surface hide work when he isn't working; off-duty view takes home/out/night shapes.
- **Working hours 08:00–18:00** (setting); past 18:00 only a real meeting or focus session keeps him on duty.
- **Voice** — useful or silent (greetings need a brief line; feed speech only critical/meeting/asked); living room greets nobody and replies in the natural voice via `saim-voice` Wyoming bridge (pi5 :10201); iOS + tablet play the natural clip.
- **HA router integration** had frozen 16 days (person.nick "home" in Derby) — reloaded; watchdog script on pi5 cron.
- **Senses watchdog** (`watchdog.checkSenses`, `sense_alert`); **rain-while-out** moment in ambient-push.
- **CI** — android-sensor build fixed (dropped setup-android); tests workflow fixed (install web apps' deps) — first green run in 40+.

## What's still pending
- **iOS build on the Mac** — natural voice + 90s unprompted gap (`nuero-ios` 79d78a6, c0687ae). Not built.
- **Study tablet APK** — built on release `android-sensor-latest`, NOT installed: needs USB once at home (wireless ADB off), uninstall + re-provision. Exact steps in memory `study-tablet-saim`.
- **Bedroom P30** — BLE deaf, not charging; needs hands.
- **Decisions for Nick:** Apple Developer account (NOT bought); `SAIM_SENSOR_KEYSTORE_*` GitHub secrets; Focus-name Shortcuts (parked — helper `input_select.nick_focus` + scripts `nick_focus_on/off` exist).
- **Not built:** "leave now" (no travel-time source), heading-home heat pre-warm, wind-down push, learned routines (spec Phase 5).

## Key decisions made
- Kept router tracker on `person.nick` (fixed the integration instead) — the router beats the ~90m GPS offset at home.
- Dead "held" UI branches left: `HoldNotice` is reused for MS failures and `held` is in API payloads iOS reads.
- TV: the "Living room extension" plug is switch-only (no power meter); life-state uses socket-on + watch in living room.

## Gotchas for next session
- Spec: vault `Projects/NEURO/SAiM — Situational Intelligence` (Phase 0 measurements + fixes recorded there).
- Deploy: gate the pm2 restart on `npm test` (see mistakes.md, 2 Oct).
- HomePod is NOT used; speakers are the living-room satellite + study tablet (memory `saim-voice-must-earn-it`).
- `office` room sensor = WORK Fire; study tablet IP is now 192.168.1.200.
