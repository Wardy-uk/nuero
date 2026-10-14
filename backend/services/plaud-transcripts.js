/**
 * PLAUD transcripts — list every transcript in the vault, say whether it has a
 * summary, and let Nick refresh or archive one (14 Oct 2026).
 *
 * Why it exists: a transcript is pulled ONCE. The routine sync only lists the last
 * 14 days and only re-pulls a recording whose PLAUD `updated_at` moved, so naming
 * speakers in PLAUD a month later reached nothing. The only route back was
 * `repullPlaudRecordings`, which re-routes the SUMMARY too and lands it as
 * "<title> 2.md" beside the original — the duplicate this repo has cleaned up twice.
 *
 * ── The two actions, and what they will NOT do ─────────────────────────────────
 * REFRESH re-fetches the transcript and rewrites it IN PLACE: same file, same name,
 * frontmatter and everything above the segments kept, `speakers_named` and the
 * "never named" warning brought up to date. A copy goes to
 * Scripts/.lint-backups/plaud-refresh-<date>/ first. It pulls a SUMMARY only when the
 * transcript has none at all — an existing summary is never rewritten (Nick and the
 * enrichment pass edit those), and an ARCHIVED one is never recreated unless asked,
 * because archiving is a decision and routing must not undo it.
 *
 * ARCHIVE is the "delete". It MOVES the transcript (and, if asked, its summaries)
 * under Archive/ — never unlink. The sync ledger is left alone on purpose, so the
 * next sync does not pull the recording straight back.
 *
 * The listing is PURE over what the walk read (`buildInventory`), so it pins
 * without a vault.
 */
const fs = require('fs');
const path = require('path');
const { canonicalPlaudId } = require('../../shared/plaud-id.cjs');
const { RETIRED_DIRS } = require('./vault-exclusions');
const plaudSync = require('./plaud-sync');

const I = plaudSync._internal;

const ARCHIVE_ROOT = 'Archive/Plaud transcripts (archived from NEURO)';

// ── Pure ─────────────────────────────────────────────────────────────────────

/** Frontmatter keys as raw strings. CRLF-safe (half the vault is CRLF). Pure. */
function readFrontmatter(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    out[kv[1]] = v;
  }
  return out;
}

/** 'transcript' | 'summary' | null. A note with no plaud_id is neither. Pure. */
function classify(fm) {
  if (!fm || !fm.plaud_id || fm.plaud_id === 'null' || fm.plaud_id === 'undefined') return null;
  if (fm.note_type === 'transcript' || fm.type === 'transcript') return 'transcript';
  return 'summary';
}

const SEGMENT_RE = /^\*\*(.+?)\*\* `[0-9:]+` {2}/gm;

/**
 * Who speaks in a transcript note, read off its segment lines. Pure.
 * `unnamed` is every label still in PLAUD's "Speaker N" form.
 */
function speakerStats(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const labels = new Set();
  let segments = 0;
  const lines = [];
  SEGMENT_RE.lastIndex = 0;
  let m;
  while ((m = SEGMENT_RE.exec(text))) {
    segments += 1;
    labels.add(m[1].trim());
  }
  SEGMENT_RE.lastIndex = 0;
  for (const line of text.split('\n')) if (/^\*\*.+?\*\* `[0-9:]+` {2}/.test(line)) lines.push(line);
  const speakers = [...labels];
  return {
    segments,
    speakers,
    unnamed: speakers.filter((s) => I.GENERIC_SPEAKER_RE.test(s)),
    stub: text.includes('No transcript returned by Plaud'),
    repeated: new Set(lines).size < lines.length,
  };
}

function dateOf(fm, rel) {
  const fromName = path.basename(rel).match(/(\d{4}-\d{2}-\d{2})/);
  return fm.date || (fm.start_at && fm.start_at !== 'null' ? fm.start_at.slice(0, 10) : null) || (fromName && fromName[1]) || null;
}

/**
 * The listing, from what the walk read. Pure.
 * @param {Array<{rel:string, archived:boolean, content:string}>} notes
 */
function buildInventory(notes) {
  const byId = new Map();
  for (const n of notes) {
    const fm = readFrontmatter(n.content);
    const kind = classify(fm);
    if (!kind) continue;
    const id = canonicalPlaudId(fm.plaud_id);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { transcripts: [], archivedTranscripts: [], summaries: [], archivedSummaries: [] });
    const slot = byId.get(id);
    const key = kind === 'transcript'
      ? (n.archived ? 'archivedTranscripts' : 'transcripts')
      : (n.archived ? 'archivedSummaries' : 'summaries');
    slot[key].push({ rel: n.rel, fm, content: n.content });
  }

  const rows = [];
  let archivedTranscripts = 0;
  let summariesWithoutTranscript = 0;
  for (const [plaudId, slot] of byId) {
    archivedTranscripts += slot.archivedTranscripts.length;
    if (!slot.transcripts.length && slot.summaries.length) summariesWithoutTranscript += 1;
    for (const t of slot.transcripts) {
      const stats = speakerStats(t.content);
      const named = t.fm.speakers_named;
      rows.push({
        path: t.rel,
        plaudId,
        title: t.fm.title || path.basename(t.rel, '.md'),
        date: dateOf(t.fm, t.rel),
        // Three-valued, as written by the sync: null = never judged.
        speakersNamed: named === 'true' ? true : named === 'false' ? false : null,
        segments: stats.segments,
        speakers: stats.speakers,
        unnamed: stats.unnamed,
        stub: stats.stub,
        repeated: stats.repeated,
        summaries: slot.summaries.map((s) => s.rel).sort(),
        archivedSummaries: slot.archivedSummaries.map((s) => s.rel).sort(),
        summaryStatus: slot.summaries.length ? 'present' : slot.archivedSummaries.length ? 'archived' : 'none',
        // Another live transcript for the same recording — worth seeing, never merged here.
        duplicateTranscripts: slot.transcripts.filter((o) => o.rel !== t.rel).map((o) => o.rel),
      });
    }
  }
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.path.localeCompare(b.path));
  return {
    transcripts: rows,
    counts: {
      transcripts: rows.length,
      withSummary: rows.filter((r) => r.summaryStatus === 'present').length,
      summaryArchived: rows.filter((r) => r.summaryStatus === 'archived').length,
      noSummary: rows.filter((r) => r.summaryStatus === 'none').length,
      unnamedSpeakers: rows.filter((r) => r.unnamed.length > 0).length,
      archivedTranscripts,
      summariesWithoutTranscript,
    },
  };
}

/** Set one frontmatter key, adding it before the closing `---` when absent. Pure. */
function setFrontmatterLine(content, key, value) {
  const text = String(content || '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const block = re.test(m[1]) ? m[1].replace(re, `${key}: ${value}`) : `${m[1]}${eol}${key}: ${value}`;
  return text.replace(m[0], `---${eol}${block}${eol}---`);
}

const WARNING_RE = /^> ⚠ Speakers were never named in PLAUD.*(\r?\n)?(\r?\n)?/m;

/**
 * The transcript note with its segments replaced, everything above them kept.
 * `speakers_named` and the warning line follow the NEW naming. Pure.
 */
function rewriteTranscriptNote(content, body, naming) {
  let text = String(content || '');
  text = setFrontmatterLine(text, 'speakers_named', naming && naming.known ? String(naming.complete) : 'null');
  text = text.replace(WARNING_RE, '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let cut = lines.findIndex((l) => /^\*\*.+?\*\* `[0-9:]+` {2}/.test(l) || l.includes('No transcript returned by Plaud'));
  let head;
  if (cut >= 0) head = lines.slice(0, cut).join(eol);
  else {
    // ⚠ A layout we do not recognise is REFUSED (null), never appended to: adding a
    // second transcript under an old one we could not find would double the note.
    const idx = lines.findIndex((l) => l.trim() === '## Transcript');
    if (idx < 0) return null;
    head = lines.slice(0, idx + 1).join(eol);
  }
  head = head.replace(/\s*$/, '') + eol + eol;
  const warning = naming && naming.known && !naming.complete
    ? `> ⚠ Speakers were never named in PLAUD — ${naming.reason}. Attribution below is unreliable.${eol}${eol}`
    : '';
  return `${head}${warning}${String(body || '').trim().replace(/\r?\n/g, eol)}${eol}`;
}

/** Point the transcript's `Summary: [[...]]` line at a new summary. Pure. */
function setSummaryLink(content, summaryRel) {
  const link = `Summary: [[${String(summaryRel).replace(/\.md$/i, '')}]]`;
  return /^Summary: \[\[.*\]\]\s*$/m.test(content)
    ? content.replace(/^Summary: \[\[.*\]\]\s*$/m, link)
    : content;
}

// ── Vault ────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([...I.RECONCILE_EXCLUDE].filter((d) => d !== 'Archive'));
const RETIRED = new Set(RETIRED_DIRS);

function vaultRoot() {
  const root = I.getVaultPath();
  if (!path.isAbsolute(root) || !fs.existsSync(root)) throw new Error('vault is not readable');
  return root;
}

const HEAD_BYTES = 4096;
function readHead(full) {
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

/** Every note that mentions a plaud_id, marked archived or not. */
function walkPlaudNotes(root) {
  const out = [];
  const stack = [{ dir: root, archived: false }];
  while (stack.length) {
    const { dir, archived } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push({ dir: full, archived: archived || RETIRED.has(e.name) });
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        // Read the HEAD only: thousands of notes, and only transcripts need their body.
        // The full file is read when the head is a transcript, or when the frontmatter
        // runs past the head (a long people list) so it cannot be judged from it.
        const head = readHead(full);
        if (head == null || !head.includes('plaud_id')) continue;
        const fm = readFrontmatter(head);
        const closed = /^---\r?\n[\s\S]*?\r?\n---/.test(head);
        let content = head;
        if (!closed || classify(fm) === 'transcript') {
          try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        }
        out.push({ rel: path.relative(root, full).replace(/\\/g, '/'), archived, content });
      }
    }
  }
  return out;
}

function list() {
  const root = vaultRoot();
  const notes = walkPlaudNotes(root);
  const syncState = I.readSyncState();
  const inv = buildInventory(notes);
  for (const row of inv.transcripts) {
    const led = syncState.syncedRecordings?.[row.plaudId];
    row.syncedAt = led?.syncedAt || null;
  }
  const running = I.readRunningState();
  return { ...inv, busy: Boolean(running.active && !running.stale) };
}

/** A vault-relative path to an ACTIVE transcript note, or a thrown 4xx. */
function resolveTranscript(rel) {
  const root = vaultRoot();
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0') || !/\.md$/i.test(rel)) {
    throw httpError(400, 'path must be a vault-relative .md path');
  }
  const full = path.resolve(root, rel);
  const back = path.relative(root, full);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw httpError(400, 'path is outside the vault');
  const relNorm = back.replace(/\\/g, '/');
  if (relNorm.split('/').some((seg) => RETIRED.has(seg))) throw httpError(400, 'that transcript is already archived');
  if (!fs.existsSync(full)) throw httpError(404, 'no such note');
  const content = fs.readFileSync(full, 'utf-8');
  const fm = readFrontmatter(content);
  if (classify(fm) !== 'transcript') throw httpError(400, 'that note is not a PLAUD transcript');
  return { root, full, rel: relNorm, content, fm, plaudId: canonicalPlaudId(fm.plaud_id) };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function backup(root, full, rel, label) {
  const bk = path.join(root, ...I.PLAUD_BACKUP_REL, `${label}-${localDateKey()}`, rel);
  fs.mkdirSync(path.dirname(bk), { recursive: true });
  if (!fs.existsSync(bk)) fs.copyFileSync(full, bk);
  return path.relative(root, bk).replace(/\\/g, '/');
}

function hook(full, source) {
  try { require('./vault-hooks').onVaultWrite(full, source); } catch {}
}

/**
 * Re-fetch one transcript from PLAUD and rewrite it in place. Pulls a summary only if
 * the recording has none (`pullSummary` also allows one whose summary was archived).
 */
async function refresh(rel, { pullSummary = false } = {}) {
  const t = resolveTranscript(rel);
  if (!t.plaudId) throw httpError(400, 'transcript has no plaud_id');
  const running = I.readRunningState();
  if (running.active && !running.stale) throw httpError(409, 'a PLAUD sync is running — try again in a minute');

  const before = speakerStats(t.content);
  const inventoryBefore = buildInventory(walkPlaudNotes(t.root)).transcripts.find((r) => r.path === t.rel);

  I.writeRunningState(true);
  try {
    const { client, transport } = await I.createClient();
    try {
      const files = await I.buildApiIdMap(client);
      const file = files.get(t.plaudId);
      if (!file) throw httpError(404, `recording ${t.plaudId} is no longer in PLAUD`);

      // ⚠ Fetch by PLAUD's own id (`of_…`), never the canonical one — a bare id 404s.
      const segments = await plaudSync._internal.fetchTranscriptSegments(client, file.id);
      I.checkTranscriptCoverage(file.id, segments, file.duration);
      const body = plaudSync.renderTranscript(segments);
      if (!body.trim()) throw httpError(502, 'PLAUD returned no transcript — the note was left as it was');
      const naming = plaudSync.assessSpeakerNaming(segments);

      let next = rewriteTranscriptNote(t.content, body, naming);
      if (next == null) throw httpError(422, 'this note has no transcript section NEURO recognises — left as it was');
      const backupPath = backup(t.root, t.full, t.rel, 'plaud-refresh');

      // A summary only where there is none. Never rewrite an existing one; never
      // recreate an archived one unless asked.
      let summary = { status: inventoryBefore?.summaryStatus === 'present' ? 'kept' : inventoryBefore?.summaryStatus === 'archived' ? 'archived-kept' : 'none', path: inventoryBefore?.summaries?.[0] || null };
      const wantSummary = inventoryBefore && (inventoryBefore.summaryStatus === 'none' || (inventoryBefore.summaryStatus === 'archived' && pullSummary));
      if (wantSummary) {
        summary = await pullSummaryFor(client, file, t, next);
        if (summary.path) next = setSummaryLink(next, summary.path);
      }

      fs.writeFileSync(t.full, next, 'utf-8');
      hook(t.full, 'plaud-transcript-refresh');

      const after = speakerStats(next);
      return {
        ok: true,
        path: t.rel,
        backup: backupPath,
        speakersNamed: naming.known ? naming.complete : null,
        naming: naming.reason,
        before: { segments: before.segments, unnamed: before.unnamed },
        after: { segments: after.segments, unnamed: after.unnamed, speakers: after.speakers },
        summary,
      };
    } finally {
      await transport.close();
    }
  } finally {
    I.writeRunningState(false);
  }
}

async function pullSummaryFor(client, file, t) {
  const details = I.assertUsableDetails(
    await I.withRetry(`get_file ${file.id}`, () => I.callTool(client, 'get_file', { file_id: file.id })),
    file.id
  );
  const noteList = await I.withRetry(`get_note ${file.id}`, () => I.callTool(client, 'get_note', { file_id: file.id }));
  const summaryBody = plaudSync.renderNote(noteList);
  if (!summaryBody.trim()) return { status: 'none-in-plaud', path: null };
  const preferred = I.choosePreferredSummary(Array.isArray(noteList) ? noteList : []);

  const folder = String(I.getSummaryFolder()).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let rel = `${folder}/${I.buildNoteBaseName(details)}.md`;
  for (let n = 2; fs.existsSync(path.join(t.root, rel)); n += 1) rel = `${folder}/${I.buildNoteBaseName(details)} ${n}.md`;
  const written = I.writeFile(rel, I.renderSummaryNote(details, preferred, summaryBody, t.rel));

  let finalRel = rel;
  try {
    const routed = await require('./imports').routePlaudSummary(written.fullPath, { transcriptPath: t.full });
    if (routed.status === 'ok' && routed.relativePath) finalRel = routed.relativePath;
  } catch (e) {
    console.error('[PlaudTranscripts] summary routing failed:', e.message);
  }

  const state = I.readSyncState();
  const led = state.syncedRecordings?.[t.plaudId];
  if (led) {
    led.summaryRelativePath = finalRel;
    led.summaryPreferenceRank = I.getSummaryPreferenceRank(preferred);
    led.summaryPreferenceLabel = I.describeSummaryChoice(preferred);
    I.writeSyncState(state);
  }
  return { status: 'pulled', path: finalRel };
}

function moveToArchive(root, rel) {
  let dest = `${ARCHIVE_ROOT}/${rel}`;
  if (fs.existsSync(path.join(root, dest))) {
    dest = dest.replace(/\.md$/i, ` (archived ${new Date().toISOString().replace(/[:.]/g, '-')}).md`);
  }
  const destFull = path.join(root, dest);
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(path.join(root, rel), destFull);
  try { require('./vault-logger').logMove(rel, dest, 'plaud-transcript-archive'); } catch {}
  return dest;
}

/**
 * "Delete": MOVE the transcript (and optionally its live summaries) under Archive/.
 * Nothing is unlinked. The sync ledger is untouched, so the recording is not re-pulled.
 */
function archive(rel, { withSummaries = false } = {}) {
  const t = resolveTranscript(rel);
  const row = buildInventory(walkPlaudNotes(t.root)).transcripts.find((r) => r.path === t.rel);
  const moved = [{ from: t.rel, to: moveToArchive(t.root, t.rel) }];
  if (withSummaries && row) {
    for (const s of row.summaries) moved.push({ from: s, to: moveToArchive(t.root, s) });
  }
  return { ok: true, moved, summariesLeft: withSummaries ? [] : (row ? row.summaries : []) };
}

module.exports = {
  list,
  refresh,
  archive,
  ARCHIVE_ROOT,
  _internal: { readFrontmatter, classify, speakerStats, buildInventory, setFrontmatterLine, rewriteTranscriptNote, setSummaryLink, walkPlaudNotes },
};
