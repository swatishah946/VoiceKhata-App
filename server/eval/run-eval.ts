/**
 * AI extraction evaluation.
 *
 * Runs every message in the dataset through the real Gemini extraction +
 * validation, compares with the hand-labelled expected answer, and prints:
 *   - intent accuracy
 *   - exact-match rate (every expected field correct)
 *   - per-field accuracy
 *   - how often the validator / confidence check caught a wrong answer
 *   - latency p50 / p95
 *
 * Usage:
 *   npm run eval                          # uses eval/dataset.json, or the sample if absent
 *   npm run eval -- eval/my-dataset.json
 *
 * IMPORTANT: dataset.sample.json is SYNTHETIC (written by hand to show the format).
 * For numbers you put on a résumé, build eval/dataset.json from REAL messages
 * (transcripts of your father's voice notes), label them by hand, and run on that.
 * Results are saved to eval/results-<timestamp>.json so you can compare prompt changes.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { validateExtraction, ExtractionSchema } from '../src/lib/extraction';
import { stoneSizeKey } from '../src/lib/stone';
import { extractFromText } from '../src/services/ai.service';

interface Case {
  id: string;
  input: string;
  expected: Record<string, unknown>;
}

function sameValue(field: string, expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) < 0.005;
  if (field.includes('stone_type')) return stoneSizeKey(String(actual ?? '')) === stoneSizeKey(String(expected));
  if (field.endsWith('_name')) {
    // Names: case-insensitive, and "Ramesh" matches "Ramesh Bhai" / "Ramesh ji"
    const a = String(actual ?? '').toLowerCase().replace(/\b(bhai|ji|sahab|seth)\b/g, '').trim();
    const e = String(expected).toLowerCase().trim();
    return a === e || a.startsWith(e + ' ') || e.startsWith(a + ' ');
  }
  return String(actual ?? '').toLowerCase() === String(expected).toLowerCase();
}

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function main() {
  const arg = process.argv[2];
  const real = path.join(__dirname, 'dataset.json');
  const file = arg ? path.resolve(arg) : fs.existsSync(real) ? real : path.join(__dirname, 'dataset.sample.json');
  const cases: Case[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Evaluating ${cases.length} messages from ${path.basename(file)} with ${config.GEMINI_MODEL}\n`);

  const fieldTotals: Record<string, { ok: number; n: number }> = {};
  const latencies: number[] = [];
  const rows: any[] = [];
  let intentOk = 0, exact = 0, errors = 0, wrongButCaught = 0, wrongAndAccepted = 0;

  for (const c of cases) {
    const t0 = Date.now();
    let raw: unknown;
    try {
      raw = await extractFromText(c.input);
    } catch (err) {
      errors++;
      rows.push({ id: c.id, error: (err as Error).message });
      console.log(`✗ ${c.id} ERROR ${(err as Error).message}`);
      continue;
    } finally {
      latencies.push(Date.now() - t0);
    }

    const parsed = ExtractionSchema.safeParse(raw);
    const actual: Record<string, unknown> = parsed.success ? (parsed.data as any) : ((raw as any) ?? {});
    const verdict = validateExtraction(raw, config.AI_MIN_CONFIDENCE);

    let allOk = true;
    const wrongFields: string[] = [];
    for (const [field, exp] of Object.entries(c.expected)) {
      const ok = sameValue(field, exp, actual[field]);
      fieldTotals[field] ??= { ok: 0, n: 0 };
      fieldTotals[field].n++;
      if (ok) fieldTotals[field].ok++;
      else {
        allOk = false;
        wrongFields.push(`${field}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual[field])}`);
      }
    }
    if (sameValue('intent', c.expected.intent, actual.intent)) intentOk++;
    if (allOk) exact++;
    else if (!verdict.ok) wrongButCaught++;
    else wrongAndAccepted++;

    rows.push({ id: c.id, ok: allOk, accepted: verdict.ok, confidence: actual.confidence_level, wrongFields, actual });
    console.log(`${allOk ? '✓' : '✗'} ${c.id}${allOk ? '' : '  ' + wrongFields.join(' | ')}${!allOk && !verdict.ok ? '  (caught by validator)' : ''}`);
    await new Promise((r) => setTimeout(r, 4500)); // stay under the free-tier rate limit
  }

  const n = cases.length;
  const summary = {
    dataset: path.basename(file),
    model: config.GEMINI_MODEL,
    messages: n,
    intentAccuracy: pct(intentOk, n),
    exactMatch: pct(exact, n),
    wrongAnswers: n - exact - errors,
    wrongButCaughtByValidator: wrongButCaught,
    wrongAndAccepted, // these reach the "yes/no" confirmation step, where a human catches them
    errors,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    fieldAccuracy: Object.fromEntries(Object.entries(fieldTotals).map(([f, t]) => [f, `${pct(t.ok, t.n)} (${t.ok}/${t.n})`])),
  };

  console.log('\n' + JSON.stringify(summary, null, 2));
  const out = path.join(__dirname, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
