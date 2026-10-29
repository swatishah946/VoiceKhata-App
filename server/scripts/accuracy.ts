/**
 * Real-world AI accuracy, from entries saved in the app.
 *
 * Every entry he saves from the app's review screen stores what the AI
 * understood and what he actually saved (entry_reviews). A field counts as
 * correct when he did not change it. This is measured on his real voice notes,
 * not on a test set.
 *
 * Usage: npm run accuracy            (all time)
 *        npm run accuracy -- 30      (last 30 days)
 */
import '../src/config';
import pool from '../src/db';

async function main() {
  const days = Number(process.argv[2]) || null;
  const r = await pool.query(
    `SELECT ai_values, final_values, changed_fields FROM entry_reviews
      WHERE ($1::int IS NULL OR created_at > NOW() AT TIME ZONE 'UTC' - make_interval(days => $1))`,
    [days]
  );
  const total = r.rows.length;
  if (!total) {
    console.log('No reviewed entries yet.');
    return pool.end();
  }
  const perField = new Map<string, { seen: number; changed: number }>();
  let perfect = 0;
  for (const row of r.rows) {
    if (!row.changed_fields.length) perfect++;
    const fields = new Set([...Object.keys(row.ai_values), ...Object.keys(row.final_values)]);
    for (const f of fields) {
      const s = perField.get(f) ?? { seen: 0, changed: 0 };
      s.seen++;
      if (row.changed_fields.includes(f)) s.changed++;
      perField.set(f, s);
    }
  }
  const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
  console.log(`Entries reviewed: ${total}${days ? ` (last ${days} days)` : ''}`);
  console.log(`Saved without any correction: ${perfect} (${pct(perfect, total)})\n`);
  console.log('Field'.padEnd(20) + 'Entries'.padStart(8) + 'Correct'.padStart(10));
  for (const [f, s] of [...perField].sort((a, b) => b[1].seen - a[1].seen)) {
    console.log(f.padEnd(20) + String(s.seen).padStart(8) + pct(s.seen - s.changed, s.seen).padStart(10));
  }
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
