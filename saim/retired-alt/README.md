# SAiM Alt — RETIRED (21 Oct 2026)

**There is one SAiM: <https://sara.nickward.co.uk>** — the locked Keep My Word
home, the same responsive app on phone, desktop (Electron) and kiosk. Alt v1,
v2, v3 and the legacy control desktop are retired as product variants.

This folder is the ENTIRE deploy for each retired hostname. It replaces the old
app with a permanent redirect; it does not delete anything.

| What it does | How |
|---|---|
| Every path → `https://sara.nickward.co.uk/<same path>` (query kept) | `_redirects`: `/*  https://sara.nickward.co.uk/:splat  301!` |
| Neutralises a stale service worker on the old origin | `/sw.js` (and `/service-worker.js`) stay a real 200 serving a kill-switch: deletes caches, unregisters, reloads the tab onto the redirect. `Clear-Site-Data` on that response as a second route. |
| Fallback if anything reaches a page | `index.html` unregisters workers, clears caches and `location.replace`s to the same path + query + hash on sara. |

⚠ Never make `/sw.js` redirect: a browser only replaces a worker with one
fetched from the SAME origin, so a cross-origin redirect leaves the old shell
serving for ever.

## Sites (manual deploys only — none is repo-linked)

| Hostname | Netlify site | Site id |
|---|---|---|
| saim.nickward.co.uk | `saim-alt-nickward` (was Alt v3) | `2f83b58d-8636-444f-82ac-cb1751072a1e` |
| saim-alt.nickward.co.uk | `saim-legacy-nickward` (was the legacy control) | `6e7e4e32-e982-4f9e-8eff-616d865b170d` |
| saim-alt-v1.nickward.co.uk | `saim-alt-v1-nickward` (was Alt v1) | `ada5c60b-b68e-423e-a08b-f41ebc9a1033` |

`sara.nickward.co.uk` is site `saim-nickward` (autodeploys from `main`) and is
NOT touched by this folder.

## Deploy (by hand, per site)

Zip the CONTENTS of this folder (not the folder) with Windows `tar.exe` — bash's
GNU tar and `Compress-Archive` both break on Windows paths — and POST it to the
site's deploys API, exactly as for the old Alt deploys:

```
cd saim/retired-alt
/c/Windows/System32/tar.exe -a -c -f ../../retired-alt.zip _redirects _headers sw.js index.html
curl -H "Authorization: Bearer $NETLIFY_TOKEN" -H "Content-Type: application/zip" \
  --data-binary @../../retired-alt.zip https://api.netlify.com/api/v1/sites/<site id>/deploys
```

Record each new deploy id here.

## Check after deploying

```
curl -sI https://saim.nickward.co.uk/some/path?x=1        # 301, Location: https://sara.nickward.co.uk/some/path?x=1
curl -sI https://saim-alt.nickward.co.uk/                 # 301, Location: https://sara.nickward.co.uk/
curl -sI https://saim-alt-v1.nickward.co.uk/?tab=now      # 301, Location: https://sara.nickward.co.uk/?tab=now
curl -s  https://saim-alt.nickward.co.uk/sw.js | head -2  # 200, the kill-switch (not a redirect)
```

## Rollback

Nothing was deleted: restore the previous deploy on each site (Netlify →
Deploys → the deploy before the redirect → Publish, or
`POST /api/v1/sites/<site id>/deploys/<deploy id>/restore`).

Last product deploys before the cutover (from the deploy log):
- saim. (Alt v3): `6ad340e06f3645d980c840ba`
- saim-alt. (legacy control): `6ad22a1f49de03018e5ba1f1`
- saim-alt-v1.: check the site's deploy list (not recorded in the repo)

The Alt source trees (`saim/app/alt*`, `vite.config.alt*.js`) are kept but their
build commands refuse to run unless `SAIM_BUILD_RETIRED=1` is set — a rollback
is a deploy RESTORE, not a rebuild.
