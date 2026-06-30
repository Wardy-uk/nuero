const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const PLAUD_STATE_KEY = 'plaud_sync_state';
const PLAUD_RUNNING_KEY = 'plaud_sync_running';
const PLAUD_LAST_ERROR_KEY = 'plaud_last_error';
const PLAUD_LAST_SYNC_KEY = 'plaud_last_sync';
const PLAUD_LAST_RUN_KEY = 'plaud_last_run';
const DEFAULT_RETRY_ATTEMPTS = Number(process.env.PLAUD_MCP_RETRY_ATTEMPTS || 4);
const DEFAULT_RETRY_BASE_MS = Number(process.env.PLAUD_MCP_RETRY_BASE_MS || 1500);
const DEFAULT_BETWEEN_RECORDINGS_MS = Number(process.env.PLAUD_MCP_BETWEEN_RECORDINGS_MS || 750);
const DEFAULT_STALE_RUN_MS = Number(process.env.PLAUD_MCP_STALE_RUN_MS || 2 * 60 * 60 * 1000);
const DEFAULT_SUMMARY_STABILIZATION_HOURS = Number(process.env.PLAUD_SUMMARY_STABILIZATION_HOURS || 24);

function getVaultPath() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!vaultPath) {
    throw new Error('OBSIDIAN_VAULT_PATH is not configured');
  }
  return vaultPath;
}

function getPlaudCommand() {
  return process.env.PLAUD_MCP_COMMAND || 'npx';
}

function getPlaudArgs() {
  return splitCommandLine(process.env.PLAUD_MCP_ARGS || '-y @plaud-ai/mcp@latest');
}

function getSummaryFolder() {
  return process.env.PLAUD_SUMMARY_FOLDER || 'Plaud/Summaries';
}

function getTranscriptFolder() {
  return process.env.PLAUD_TRANSCRIPT_FOLDER || 'Meetings/transcripts';
}

function splitCommandLine(value) {
  const matches = value.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

function normalizeVaultPath(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function ensureFolder(relativePath) {
  const vaultPath = getVaultPath();
  const target = path.join(vaultPath, relativePath);
  fs.mkdirSync(target, { recursive: true });
}

function readMarkdownFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];

  const results = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(nextPath);
      }
    }
  }

  return results;
}

function extractFrontmatterValue(content, key) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}:\\s*(.+)$`, 'mi');
  const match = frontmatterMatch[1].match(pattern);
  if (!match) return null;

  return match[1].trim().replace(/^"(.*)"$/, '$1');
}

function buildExistingNoteIndex() {
  const vaultPath = getVaultPath();
  const index = {};

  for (const filePath of readMarkdownFiles(vaultPath)) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const plaudId = extractFrontmatterValue(content, 'plaud_id');
    if (!plaudId) continue;

    const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
    if (!index[plaudId]) {
      index[plaudId] = { summaries: [], transcripts: [] };
    }

    const noteType = extractFrontmatterValue(content, 'note_type');
    if (noteType === 'transcript') {
      index[plaudId].transcripts.push(relativePath);
    } else {
      index[plaudId].summaries.push(relativePath);
    }
  }

  for (const value of Object.values(index)) {
    value.summaries.sort();
    value.transcripts.sort();
  }

  return index;
}

function readSyncState() {
  try {
    const raw = db.getState(PLAUD_STATE_KEY);
    return raw
      ? JSON.parse(raw)
      : { syncedRecordings: {}, failedRecordings: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  } catch {
    return { syncedRecordings: {}, failedRecordings: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  }
}

function writeSyncState(state) {
  db.setState(PLAUD_STATE_KEY, JSON.stringify(state));
  db.setState(PLAUD_LAST_SYNC_KEY, state.lastSuccessfulSyncAt || '');
  db.setState(PLAUD_LAST_RUN_KEY, state.lastRunAt || '');
}

function readRunningState() {
  try {
    const raw = db.getState(PLAUD_RUNNING_KEY);
    if (!raw || raw === 'false') {
      return { active: false, stale: false, startedAt: null, pid: null };
    }

    if (raw === 'true') {
      return { active: true, stale: true, startedAt: null, pid: null };
    }

    const parsed = JSON.parse(raw);
    const startedAtMs = parsed.startedAt ? new Date(parsed.startedAt).getTime() : NaN;
    let pidAlive = true;
    if (parsed.pid) {
      try {
        process.kill(parsed.pid, 0);
      } catch {
        pidAlive = false;
      }
    }

    const stale =
      !pidAlive || (Number.isFinite(startedAtMs) && Date.now() - startedAtMs > DEFAULT_STALE_RUN_MS);
    return {
      active: Boolean(parsed.active),
      stale,
      startedAt: parsed.startedAt || null,
      pid: parsed.pid || null
    };
  } catch {
    return { active: false, stale: false, startedAt: null, pid: null };
  }
}

function writeRunningState(active) {
  if (!active) {
    db.setState(PLAUD_RUNNING_KEY, 'false');
    return;
  }

  db.setState(
    PLAUD_RUNNING_KEY,
    JSON.stringify({
      active: true,
      startedAt: new Date().toISOString(),
      pid: process.pid
    })
  );
}

async function createClient() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js')
  ]);

  const transport = new StdioClientTransport({
    command: getPlaudCommand(),
    args: getPlaudArgs(),
    stderr: 'pipe'
  });

  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      console.error(`[Plaud MCP] ${chunk.toString()}`);
    });
  }

  const client = new Client({
    name: 'nuero-plaud-sync',
    version: '1.0.0'
  });

  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content || [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();

  if (result.isError) {
    throw new Error(text || `Plaud MCP tool failed: ${name}`);
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('too many requests');
}

function isRetryableError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    isRateLimitError(error) ||
    message.includes('timeout') ||
    message.includes('temporar') ||
    message.includes('econnreset') ||
    message.includes('socket hang up')
  );
}

async function withRetry(label, operation, options = {}) {
  const attempts = Number(options.attempts || DEFAULT_RETRY_ATTEMPTS);
  const baseDelayMs = Number(options.baseDelayMs || DEFAULT_RETRY_BASE_MS);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[PlaudSync] ${label} failed on attempt ${attempt}/${attempts} (${error.message}). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

async function listRecordings(client, dateFrom) {
  if (dateFrom) {
    const payload = await callTool(client, 'list_files', { date_from: dateFrom });
    return extractRecordingList(payload);
  }

  const all = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const payload = await callTool(client, 'list_files', { page, page_size: pageSize });
    const batch = extractRecordingList(payload);
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
  }

  return all;
}

function extractRecordingList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  throw new Error('Plaud list_files returned an unexpected response shape');
}

function choosePreferredSummary(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return {};

  const custom = notes.filter((note) => {
    const tab = (note.data_tab_name || '').trim().toLowerCase();
    const title = (note.data_title || '').trim().toLowerCase();
    return tab === 'obsidian meeting template' || title === 'obsidian meeting template';
  });
  if (custom.length > 0) return custom[0];

  const defaults = notes.filter((note) => {
    const type = (note.data_type || '').trim().toLowerCase();
    const tab = (note.data_tab_name || '').trim().toLowerCase();
    const title = (note.data_title || '').trim().toLowerCase();
    return type === 'auto_sum_note' || tab === 'summary' || title === 'summary';
  });
  if (defaults.length > 0) return defaults[0];

  return notes[0];
}

function getSummaryPreferenceRank(note) {
  if (!note) return 0;

  const tab = (note.data_tab_name || '').trim().toLowerCase();
  const title = (note.data_title || '').trim().toLowerCase();
  const type = (note.data_type || '').trim().toLowerCase();

  if (tab === 'obsidian meeting template' || title === 'obsidian meeting template') return 3;
  if (type === 'auto_sum_note' || tab === 'summary' || title === 'summary') return 2;
  return 1;
}

function describeSummaryChoice(note) {
  if (!note) return null;
  return note.data_tab_name || note.data_title || note.data_type || null;
}

function getRecordingTimestamp(recording) {
  const raw = recording.start_at || recording.updated_at || recording.modified_at || recording.created_at || null;
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldRecheckForPreferredSummary(recording, existing) {
  if (!existing) return false;
  if ((existing.summaryPreferenceRank || 0) >= 3) return false;

  const ts = getRecordingTimestamp(recording);
  if (!ts) return false;

  const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
  return ageHours <= DEFAULT_SUMMARY_STABILIZATION_HOURS;
}

function shouldProcessRecording(recording, syncState, incremental) {
  if (!incremental) return true;

  const existing = syncState.syncedRecordings?.[recording.id];
  if (!existing) return true;

  const currentFingerprint = recording.updated_at || recording.modified_at || recording.created_at || recording.start_at || null;
  if (existing.sourceFingerprint !== currentFingerprint) return true;
  if (shouldRecheckForPreferredSummary(recording, existing)) return true;
  return false;
}

function htmlUnescape(value) {
  return String(value == null ? '' : value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // &amp; last so we don't double-decode
}

// get_note returns an array of note objects. Keep only items with real markdown
// content (drops consumer_note items that carry just an expiring S3 link),
// unescape HTML entities, and join multiple summaries with a divider.
function renderNote(noteArray) {
  return (Array.isArray(noteArray) ? noteArray : [])
    .filter((n) => n && n.data_content && n.data_content.trim())
    .map((n) => htmlUnescape(n.data_content))
    .join('\n\n---\n\n');
}

// get_transcript returns a `transaction` item whose data_content is a JSON string
// of segments. Pull those out, ignoring any non-transaction items.
function extractTranscriptSegments(payload) {
  if (!Array.isArray(payload)) return [];

  const transaction = payload.find((item) => item && item.data_type === 'transaction');
  if (transaction && typeof transaction.data_content === 'string') {
    try {
      const segments = JSON.parse(transaction.data_content);
      if (Array.isArray(segments)) return segments;
    } catch (error) {
      console.error('[PlaudSync] Failed to parse transcript transaction payload:', error.message);
    }
  }

  return [];
}

// Render segments using the real `speaker` name (NOT original_speaker, the raw
// "Speaker N" label) with an mm:ss timestamp.
function renderTranscript(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s && (s.content || '').trim())
    .map((s) => {
      const t = new Date(s.start_time).toISOString().substr(14, 5); // mm:ss
      return `**${s.speaker || 'Speaker'}** \`${t}\`  ${s.content.trim()}`;
    })
    .join('\n\n');
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function yamlScalar(value) {
  return value ? `"${escapeYaml(value)}"` : 'null';
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function buildNoteBaseName(recording) {
  const stamp = recording.start_at || recording.created_at || new Date().toISOString();
  const datePrefix = new Date(stamp);
  const prefix = Number.isNaN(datePrefix.getTime()) ? 'undated' : datePrefix.toISOString().slice(0, 10);
  const title = slugify(recording.name || recording.id) || recording.id;
  return `${prefix} ${title}`;
}

function renderSummaryNote(recording, note, summaryBody, transcriptRelativePath) {
  const noteTitle = (note.data_title || note.data_tab_name || recording.name || recording.id).trim();
  const lines = [
    '---',
    `plaud_id: "${escapeYaml(recording.id)}"`,
    `title: "${escapeYaml(noteTitle)}"`,
    `created_at: ${yamlScalar(recording.created_at)}`,
    `start_at: ${yamlScalar(recording.start_at)}`,
    `duration_ms: ${recording.duration != null ? recording.duration : 'null'}`,
    `serial_number: ${yamlScalar(recording.serial_number)}`,
    `note_type: "summary"`,
    `plaud_summary_type: ${yamlScalar(note.data_type)}`,
    `plaud_summary_tab: ${yamlScalar(note.data_tab_name || note.data_title || 'Summary')}`,
    'source: plaud-mcp',
    '---',
    '',
    `# ${noteTitle}`,
    '',
    '## Recording',
    '',
    `- Plaud ID: \`${recording.id}\``,
    `- Created: ${recording.created_at || 'Unknown'}`,
    `- Started: ${recording.start_at || 'Unknown'}`,
    `- Duration: ${formatDuration(recording.duration)}`,
    `- Device: ${recording.serial_number || 'Unknown'}`,
    `- Transcript: [[${transcriptRelativePath.replace(/\.md$/i, '')}]]`,
    '',
    '## Summary',
    '',
    summaryBody || 'No summary content returned by Plaud for this recording.'
  ];

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderTranscriptNote(recording, summaryRelativePath, transcriptBody) {
  const meetingDate = new Date(recording.start_at || recording.created_at || Date.now()).toISOString().slice(0, 10);
  const lines = [
    '---',
    `plaud_id: "${escapeYaml(recording.id)}"`,
    `date: ${meetingDate}`,
    `title: "${escapeYaml(recording.name || recording.id)}"`,
    `created_at: ${yamlScalar(recording.created_at)}`,
    `start_at: ${yamlScalar(recording.start_at)}`,
    'type: transcript',
    'note_type: "transcript"',
    'source: PLAUD',
    '---',
    '',
    `# ${recording.name || recording.id}`,
    '',
    `Summary: [[${summaryRelativePath.replace(/\.md$/i, '')}]]`,
    '',
    '## Transcript',
    ''
  ];

  if (transcriptBody && transcriptBody.trim()) {
    lines.push(transcriptBody.trim());
  } else {
    lines.push('No transcript returned by Plaud for this recording.');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function formatDuration(durationMs) {
  if (!durationMs || Number.isNaN(durationMs)) return 'Unknown';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function writeFile(relativePath, content) {
  const fullPath = path.join(getVaultPath(), relativePath);
  const existed = fs.existsSync(fullPath);
  const previous = existed ? fs.readFileSync(fullPath, 'utf-8') : null;
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  try {
    require('./vault-hooks').onVaultWrite(fullPath, 'plaud-sync');
  } catch {}
  return {
    fullPath,
    existed,
    changed: !existed || previous !== content
  };
}

function getExistingNoteTargets(existingNotes, summaryCount, defaultSummaryPath, defaultTranscriptPath) {
  const summaries = existingNotes?.summaries?.length ? existingNotes.summaries.slice(0, summaryCount) : [];
  while (summaries.length < summaryCount) {
    const fallback = summaries.length === 0 ? defaultSummaryPath : defaultSummaryPath.replace(/\.md$/i, ` ${summaries.length + 1}.md`);
    summaries.push(fallback);
  }

  return {
    summaryPaths: summaries,
    transcriptPath: existingNotes?.transcripts?.[0] || defaultTranscriptPath
  };
}

async function syncPlaudRecordings({ incremental = true } = {}) {
  const runningState = readRunningState();
  if (runningState.active && !runningState.stale) {
    return { started: false, skipped: true, reason: 'Sync already running' };
  }
  if (runningState.active && runningState.stale) {
    console.warn('[PlaudSync] Clearing stale running state from previous interrupted sync');
  }

  writeRunningState(true);
  const syncState = readSyncState();
  const startedAt = new Date();
  syncState.lastRunAt = startedAt.toISOString();
  writeSyncState(syncState);

  try {
    ensureFolder(normalizeVaultPath(getSummaryFolder()));
    ensureFolder(normalizeVaultPath(getTranscriptFolder()));
    const existingNotesByPlaudId = buildExistingNoteIndex();

    const { client, transport } = await createClient();
    try {
      const dateFrom =
        incremental && syncState.lastSuccessfulSyncAt
          ? new Date(syncState.lastSuccessfulSyncAt).toISOString().slice(0, 10)
          : undefined;

      const recordings = await listRecordings(client, dateFrom);
      recordings.sort((a, b) => {
        const aTime = new Date(a.start_at || a.created_at || 0).getTime();
        const bTime = new Date(b.start_at || b.created_at || 0).getTime();
        return aTime - bTime;
      });

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      const failures = [];

      for (const recording of recordings) {
        if (!shouldProcessRecording(recording, syncState, incremental)) {
          skipped += 1;
          continue;
        }

        try {
          const details = await withRetry(`get_file ${recording.id}`, () =>
            callTool(client, 'get_file', { file_id: recording.id })
          );
          const noteList = await withRetry(`get_note ${recording.id}`, () =>
            callTool(client, 'get_note', { file_id: recording.id })
          );
          const transcriptPayload = await withRetry(`get_transcript ${recording.id}`, () =>
            callTool(client, 'get_transcript', { file_id: recording.id })
          );

          const preferredSummary = choosePreferredSummary(Array.isArray(noteList) ? noteList : []);
          const summaryBody = renderNote(noteList);
          const transcriptBody = renderTranscript(extractTranscriptSegments(transcriptPayload));

          const baseName = buildNoteBaseName(details);
          const defaultSummaryRelativePath = `${normalizeVaultPath(getSummaryFolder())}/${baseName}.md`;
          const defaultTranscriptRelativePath = `${normalizeVaultPath(getTranscriptFolder())}/${baseName}.md`;
          const targets = getExistingNoteTargets(
            existingNotesByPlaudId[recording.id],
            1,
            defaultSummaryRelativePath,
            defaultTranscriptRelativePath
          );
          const summaryRelativePath = targets.summaryPaths[0];
          const transcriptRelativePath = targets.transcriptPath;

          const hadExistingSync = Boolean(syncState.syncedRecordings[recording.id]);
          const summaryWrite = writeFile(
            summaryRelativePath,
            renderSummaryNote(details, preferredSummary, summaryBody, transcriptRelativePath)
          );
          const transcriptWrite = writeFile(
            transcriptRelativePath,
            renderTranscriptNote(details, summaryRelativePath, transcriptBody)
          );

          let transcriptResult = null;
          try {
            transcriptResult = await require('./transcript-processor').processTranscript(transcriptWrite.fullPath);
          } catch (error) {
            console.error('[PlaudSync] Transcript enrichment failed:', error.message);
          }

          let finalSummaryRelativePath = summaryRelativePath;
          try {
            const routeResult = await require('./imports').routePlaudSummary(summaryWrite.fullPath, {
              transcriptPath: transcriptWrite.fullPath,
              transcriptInsight: transcriptResult
            });
            if (routeResult.status === 'ok' && routeResult.relativePath) {
              finalSummaryRelativePath = routeResult.relativePath;
            } else if (routeResult.error) {
              console.warn(`[PlaudSync] PLAUD route skipped for ${recording.id}: ${routeResult.error}`);
            }
          } catch (error) {
            console.error(`[PlaudSync] PLAUD route failed for ${recording.id}:`, error.message);
          }

          if (hadExistingSync) updated += 1;
          else imported += 1;

          syncState.syncedRecordings[recording.id] = {
            summaryRelativePath: finalSummaryRelativePath,
            transcriptRelativePath,
            syncedAt: new Date().toISOString(),
            sourceCreatedAt: details.created_at || null,
            sourceStartAt: details.start_at || null,
            sourceFingerprint: details.updated_at || details.modified_at || details.created_at || details.start_at || null,
            summaryPreferenceRank: getSummaryPreferenceRank(preferredSummary),
            summaryPreferenceLabel: describeSummaryChoice(preferredSummary)
          };
          existingNotesByPlaudId[recording.id] = {
            summaries: [finalSummaryRelativePath],
            transcripts: [transcriptRelativePath]
          };
          delete syncState.failedRecordings[recording.id];
          writeSyncState(syncState);

          if (DEFAULT_BETWEEN_RECORDINGS_MS > 0) {
            await sleep(DEFAULT_BETWEEN_RECORDINGS_MS);
          }
        } catch (error) {
          failed += 1;
          const message = error.message || String(error);
          console.error(`[PlaudSync] Recording ${recording.id} failed:`, message);
          syncState.failedRecordings[recording.id] = {
            failedAt: new Date().toISOString(),
            message,
            title: recording.name || recording.id
          };
          writeSyncState(syncState);
          failures.push({
            id: recording.id,
            title: recording.name || recording.id,
            error: message
          });
        }
      }

      if (failed === 0) {
        syncState.lastSuccessfulSyncAt = startedAt.toISOString();
      }
      writeSyncState(syncState);
      db.setState(PLAUD_LAST_ERROR_KEY, failed > 0 ? failures[0].error : '');

      return {
        started: true,
        imported,
        updated,
        skipped,
        failed,
        total: recordings.length,
        lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
        failures
      };
    } finally {
      await transport.close();
    }
  } catch (error) {
    db.setState(PLAUD_LAST_ERROR_KEY, error.message);
    throw error;
  } finally {
    writeRunningState(false);
  }
}

function getStatus() {
  let syncState = { syncedRecordings: {}, failedRecordings: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  let running = false;
  let stale = false;
  let lastError = null;

  try {
    syncState = readSyncState();
    const runningState = readRunningState();
    running = runningState.active && !runningState.stale;
    stale = runningState.stale;
    lastError = db.getState(PLAUD_LAST_ERROR_KEY) || null;
  } catch {
    // DB not initialized yet — return static config/status only.
  }

  const syncedCount = Object.keys(syncState.syncedRecordings || {}).length;
  const failedCount = Object.keys(syncState.failedRecordings || {}).length;
  const vaultConfigured = Boolean(process.env.OBSIDIAN_VAULT_PATH);
  return {
    configured: vaultConfigured,
    command: getPlaudCommand(),
    args: getPlaudArgs(),
    summaryFolder: getSummaryFolder(),
    transcriptFolder: getTranscriptFolder(),
    running,
    staleRun: stale,
    lastRunAt: syncState.lastRunAt || null,
    lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt || null,
    lastError,
    syncedCount,
    failedCount
  };
}

module.exports = {
  getStatus,
  syncPlaudRecordings,
  renderNote,
  renderTranscript,
  extractTranscriptSegments,
  htmlUnescape
};
