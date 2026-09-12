'use strict';

// "Open the thing this task is about." (12 Sep 2026)
//
// PURE and browser-safe (`shared/*.cjs`, imported directly by both frontends,
// the way `ms-task.cjs` and `working-days.cjs` are). No DB, no network.
//
// Nick's ask was *"do I need a particular piece of software? give me a launch
// button — but only if I'm at my desk and working on my laptop."* Measured
// before building, most of that needs NO launcher and no channel into the
// laptop at all:
//
//   ⚠ A JIRA TASK ALREADY CARRIES ITS OWN URL. `origin_path` on the four live
//     `jira-assigned` tasks is literally
//     `https://nurturtech.atlassian.net/browse/NT-24848`. Opening the ticket is
//     a LINK, which every surface can already follow — phone included. Building
//     an inbound command channel to a work laptop to achieve that would be the
//     largest new attack surface in the system in exchange for nothing.
//
//   ⚠ A VAULT NOTE IS A LINK TOO, via `obsidian://`, but only on a machine
//     running Obsidian. So it is marked `desktopOnly` and the caller decides —
//     that is the one place Nick's "only if I'm at my desk" gate genuinely
//     earns its keep, and `current-work` already knows the answer.
//
//   ⚠ AN OPAQUE ID IS NEVER A LINK. An email-promoted task carries
//     `email:AAMkAGI1MjNl…`, a Graph id that names the message to Microsoft and
//     to nobody else. There is a plausible-looking Outlook deeplink format and
//     it is NOT used here, because a button that 404s is worse than no button —
//     and this is the same id that `candidate-provenance` exists to stop being
//     rendered as if it meant something. No link is offered, and the reason is
//     returned so a surface can say so rather than going quiet.
//
// Launching an actual APPLICATION (a repo in VS Code, say) is deliberately not
// here. It needs the desktop agent to accept inbound instructions, which today
// it cannot by design — it only ever POSTs out. That is a separate decision
// with a real security cost, and nothing above requires it.

// Obsidian addresses a vault by NAME, not by path — and the path differs per
// machine anyway (the Pi has a replica at /home/nickw/nuero-vault; the canonical
// one is on Windows). ⚠ Unset means NO note link rather than a guessed one.
const DEFAULT_VAULT_NAME = 'Nicks knowledge base';

function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v);
}

/** Does this look like a vault-relative note path? */
function isVaultPath(v) {
  return typeof v === 'string'
    && v.length > 0
    && !isHttpUrl(v)
    && !v.includes(':')          // rules out `email:…` and any other scheme
    && /\.md$/i.test(v);
}

function obsidianHref(notePath, vaultName) {
  if (!vaultName) return null;
  return 'obsidian://open?vault=' + encodeURIComponent(vaultName)
    + '&file=' + encodeURIComponent(notePath.replace(/\.md$/i, ''));
}

/**
 * @param {object} task    { origin_path, jiraKey, source }
 * @param {object} [opts]  { jiraBaseUrl, vaultName }
 * @returns {{ links, refused }}
 *   links   [{ kind, href, label, desktopOnly }]
 *   refused [{ kind, why }] — named, so a surface can explain a missing button
 */
function linksFor(task, opts = {}) {
  const links = [];
  const refused = [];
  if (!task) return { links, refused };

  const vaultName = opts.vaultName === undefined ? DEFAULT_VAULT_NAME : opts.vaultName;
  const origin = typeof task.origin_path === 'string' ? task.origin_path : null;

  // --- Jira ----------------------------------------------------------------
  // The stored URL wins over a constructed one: it is what the sync actually
  // recorded, and constructing from a base URL is a second source of truth for
  // the same fact.
  if (origin && isHttpUrl(origin)) {
    links.push({ kind: 'jira', href: origin, label: 'Open the ticket', desktopOnly: false });
  } else if (task.jiraKey && isHttpUrl(opts.jiraBaseUrl)) {
    const base = String(opts.jiraBaseUrl).replace(/\/+$/, '');
    links.push({ kind: 'jira', href: base + '/browse/' + task.jiraKey, label: 'Open ' + task.jiraKey, desktopOnly: false });
  } else if (task.jiraKey) {
    refused.push({ kind: 'jira', why: 'no Jira address is configured, so ' + task.jiraKey + ' cannot be linked' });
  }

  // --- The note it came out of ---------------------------------------------
  if (origin && isVaultPath(origin)) {
    const href = obsidianHref(origin, vaultName);
    if (href) {
      links.push({ kind: 'note', href, label: 'Open the note', desktopOnly: true });
    } else {
      refused.push({ kind: 'note', why: 'no Obsidian vault name is configured' });
    }
  }

  // --- Things that are NOT links -------------------------------------------
  if (origin && origin.startsWith('email:')) {
    refused.push({
      kind: 'email',
      // ⚠ Deliberately does not quote the id. It identifies the message to
      // Microsoft and to nobody else; printing it is the bug
      // `candidate-provenance` was written to remove.
      why: 'this came from an email, and the id Microsoft gave it cannot be turned into a link',
    });
  }

  return { links, refused };
}

/** The links a surface should actually show, given where it is running. */
function visibleLinks(task, { atDesktop = false, ...opts } = {}) {
  const { links, refused } = linksFor(task, opts);
  return {
    links: links.filter(l => !l.desktopOnly || atDesktop),
    refused,
    // ⚠ Reported rather than silently dropped: "there is a note but you are not
    // at the machine that can open it" is a different fact from "there is no
    // note", and a surface that conflates them looks broken on the phone.
    hiddenHere: atDesktop ? [] : links.filter(l => l.desktopOnly).map(l => l.kind),
  };
}

/**
 * Filter ALREADY-COMPUTED links for the surface about to render them.
 *
 * ⚠ This exists because the obvious thing is wrong. The server attaches
 * `links` to each suggested task, and a client that called `linksFor(row)`
 * again would be recomputing from `origin_path` — a field the row does not
 * carry — and would silently get NOTHING. That is exactly what happened on
 * 12 Sep 2026 and the render harness is what caught it: the rows appeared,
 * every button was missing, and nothing threw.
 *
 * So: the server decides WHAT the links are, the client decides WHICH are
 * openable where it is running, and neither re-derives the other's half.
 */
function showable(links, atDesktop = false) {
  return (Array.isArray(links) ? links : []).filter(l => l && (!l.desktopOnly || atDesktop));
}

module.exports = { linksFor, visibleLinks, showable, isVaultPath, isHttpUrl, obsidianHref, DEFAULT_VAULT_NAME };
