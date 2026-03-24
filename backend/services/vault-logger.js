'use strict';

const fs = require('fs');
const path = require('path');

function getLogPath() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  const logDir = path.join(vaultPath, 'Decision Log');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, 'vault-moves.md');
}

function ensureLogFile() {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '# Vault Move Log\n\nEvery note move is recorded here.\n\n---\n\n', 'utf-8');
  }
  return logPath;
}

// Log a note move/route operation
function logMove(sourcePath, destPath, context) {
  const logPath = ensureLogFile();
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `- **${timestamp}** — \`${sourcePath}\` → \`${destPath}\`${context ? ` — *${context}*` : ''}\n`;
  fs.appendFileSync(logPath, line, 'utf-8');
  console.log(`[VaultLog] MOVE: ${sourcePath} → ${destPath}${context ? ` [${context}]` : ''}`);
}

// Log a note create operation
function logCreate(filePath, context) {
  const logPath = ensureLogFile();
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `- **${timestamp}** — CREATED \`${filePath}\`${context ? ` — *${context}*` : ''}\n`;
  fs.appendFileSync(logPath, line, 'utf-8');
  console.log(`[VaultLog] CREATE: ${filePath}${context ? ` [${context}]` : ''}`);
}

module.exports = { logMove, logCreate };
