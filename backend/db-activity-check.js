const db = require('./db/database');
(async () => {
  await db.init();
  const rows = db.getActivityForDate('2026-06-19');
  console.log(JSON.stringify(rows.slice(-10), null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
