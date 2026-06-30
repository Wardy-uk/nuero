const db = require('./db/database');
const km = require('./services/knowledge-memory');
process.env.OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '/home/nickw/nuero-vault';
(async () => {
  await db.init();
  const result = km.writeDailyImportReport('2026-06-19');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
