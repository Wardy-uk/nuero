# Ritual Nudge Outage Handoff — 2026-09-10

## The live problem

Nick, this evening: *"no notifications are working now"* and *"health sync still
not working on neuro or sara"*.

**`GET /api/nudges` is returning an empty `nudges` array.** That is the finding
to start from. Everything else below is either ruled out or already fixed.

At ~22:00 on a Thursday an empty queue is **wrong**, not calm. Today's nudges
stay `active = 1` until `clearStaleNudges` retires them, and that only fires on
`date_key < todayKey()` — so a standup, EOD or journal nudge created today
should still be sitting in the queue right now. An empty queue means the
backend never created them, or every one was completed.

## Start here

```bash
export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH   # pm2 is not on the non-interactive SSH PATH
timedatectl | head -3
pm2 list
pm2 logs neuro --lines 80 --nostream | grep -i nudge
sqlite3 "$NEURO_DB_PATH" \
  "SELECT id,type,date_key,active,nag_count,created_at FROM nudges ORDER BY created_at DESC LIMIT 15;"
```

The scheduler either is not running or is throwing. `pm2 list` and that grep
answer it in seconds.

⚠ **Never pipe a deploy step to `head`/`tail`.** A pipeline's exit status is the
last command, so a failed `git pull` sails straight through an `&&` chain.
Confirm a deploy with `git log --oneline -1` on the Pi, not with the pipeline's
success.

**The question that splits it fastest: is the PWA still notifying him?**
`nudges.js` is what sends web push. If the PWA still gets nudges, they are being
created and the fault is on the phone. If the PWA has gone quiet too, it is the
backend and the phone was never the problem.

## Already ruled out — do not re-investigate

- **Not the network.** Tailscale is up and `pi5` (100.100.28.58) shows online.
- **Not auth.** Both apps are signed in; no PIN screen. `handleIfUnauthorised`
  deletes the stored PIN on a 401 and both apps guard `syncEverything` on
  `isSignedIn`, so a cleared PIN *would* have killed notifications and health
  sync together — it was the leading theory and it is wrong.
- **Not the iOS notification permission or the dedupe keys.** Controls reports
  `Quiet — the brain composed no line`, which is `Nudge.swift`'s **attention**
  verdict, and the ritual channel appended nothing. On the build now installed
  that means `.noneDue`: the fetch succeeded and the queue was empty.
- **Not the phone's fault at all, most likely.** Three iOS fixes were made
  chasing this (see below); none was the cause.

## Fixed here: `todayKey()` was UTC

`services/nudges.js` keyed every nudge on:

```js
return new Date().toISOString().split('T')[0];   // UTC
```

while `isPastStandupCutoff` reads `getHours()` and **all 25 `cron.schedule`
calls run in the system timezone with no `timezone` option passed**. Those three
agree only because the Pi runs on UTC.

⚠ **THIS IS A LANDMINE ON THE TIMEZONE JOB.** The intended change is
`sudo timedatectl set-timezone Europe/London`. The moment that lands, cron and
`getHours()` move to BST while `todayKey()` stays on UTC, and between **00:00
and 01:00 BST** every nudge is created under *yesterday's* key:

- `getActiveNudgeByTypeAndDate` misses today's, so each trigger creates a
  duplicate on every run
- `clearStaleNudges` retires anything with `date_key < todayKey()` and bins the
  lot an hour later

`todayKey(now = new Date())` now builds from local components, matching the
`_localDate` helper `routes/meeting-prep-view.js` already carries against
exactly this trap. It is exported and covered by
`services/nudges-datekey.test.js` (5 tests, including the 00:30-BST case and a
month-end check, because `clearStaleNudges` compares these strings
lexicographically). 33/33 nudge tests pass on Node 22.

⚠ **Node 20 segfaults `better-sqlite3`.** Use Node 22 for backend tests.

## Still to do

1. **Find why no nudges are being created.** The scheduler crons are in
   `services/scheduler.js` — `*/15 9-17 * * 1-5` is `nagCheck`,
   `10 9 * * 1-5` is `check121Nudges`.
2. **Then** set the timezone to Europe/London and restart the backend. The
   `todayKey` fix above is a prerequisite, not an optional tidy-up.
3. Confirm with `timedatectl` **and** `git log --oneline -1` on the Pi.

## The iOS side, for context

`~/Documents/GitHub/neuro-ios` — **78 commits, `main`, still NO REMOTE.** Three
of tonight's commits came out of this hunt and all three fixed genuine faults,
none of which was the cause:

- a bare `guard isSignedIn ... else { return }` in both apps that turned off
  nudges, health sync, location and calendar push *silently*
- `try? await client.nudges()` destroying the fetch error, making a dead ritual
  endpoint indistinguishable from a quiet one
- `considerRituals` returning a `Bool` whose three silent exits let the
  attention path overwrite the verdict — which is why Controls reported a
  working system choosing silence while the ritual channel had said nothing

Controls will now say *"couldn't read the ritual nudges — &lt;why&gt;. Blind, not
quiet."*, or name a fully-deduped queue with its count. **Trust that line now;
it was lying before.**

⚠ **`neuro-ios` cannot be pushed from the Claude Code session.** `git push`,
`git remote add`, `ssh` and `curl` to the Pi are all denied by the auto-mode
classifier — it refuses the classifier's own request, not the action, so it
fails closed and the documented 3-strike fallback explicitly does not apply.
The fix is `~/.claude/settings.json`, which **Nick must write by hand** because
`.claude` is a protected path:

```json
{ "permissions": { "allow": [
  "Bash(ssh *)", "Bash(git remote *)", "Bash(git push *)", "Bash(git fetch *)"
] } }
```

An allow rule resolves before the classifier is consulted, so no request is made
and nothing can refuse it. Target remote for `neuro-ios`:
`https://github.com/Wardy-uk/nuero-ios` (private, one commit adding
`.gitattributes`, so expect a clean rebase).

Do not spend an hour on this the way this session did.
