import { config } from '../config';
import pool from '../db';
import { validateExtraction } from '../lib/extraction';
import { formatINR } from '../lib/money';
import { AiError, extractFromText } from '../services/ai.service';
import * as Ledger from '../services/ledger.service';
import { PushService } from '../services/push.service';
import * as Reports from '../services/reports.service';
import { transcribeAudio } from '../services/whisper.service';

/**
 * Queue jobs: a voice note recorded in the app, and the weekly reminder.
 * They run on the BullMQ queue (see queue.ts) with its rate limit, ordering and
 * retry/backoff.
 */

export interface AppVoiceJob {
  uploadId: string;
  organizationId: string;
  phone: string;
}

export const appDefaultDeps = {
  transcribeAudio,
  extractFromText,
  ledger: Ledger,
  push: PushService,
  reports: Reports,
};
export type AppDeps = typeof appDefaultDeps;

export type AppVoiceOutcome = 'ready' | 'rejected' | 'already_done' | 'missing';

async function setUpload(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE voice_uploads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])]
  );
}

async function reject(id: string, reason: string, missing: string[] | null = null) {
  await setUpload(id, { status: 'rejected', reason, missing_fields: missing, audio: null });
  return 'rejected' as const;
}

/** Voice note recorded in the app → transcript → AI → validated → pending entry to review. */
export async function handleAppVoice(job: AppVoiceJob, deps: AppDeps = appDefaultDeps): Promise<AppVoiceOutcome> {
  const r = await pool.query(
    `SELECT status, audio, audio_mime, transcript FROM voice_uploads WHERE id = $1 AND organization_id = $2`,
    [job.uploadId, job.organizationId]
  );
  if (!r.rows.length) return 'missing';
  const upload = r.rows[0];
  if (upload.status !== 'queued') return 'already_done'; // a retried job never processes twice

  // 1. Speech → text. Saved straight away, so a retry after an AI error does not pay for Whisper again.
  let transcript: string | null = upload.transcript;
  if (transcript === null) {
    if (!upload.audio) return reject(job.uploadId, 'no_audio');
    transcript = (await deps.transcribeAudio(upload.audio, upload.audio_mime || 'audio/m4a')).trim();
    await setUpload(job.uploadId, { transcript, audio: null });
  }
  if (!transcript) return reject(job.uploadId, 'not_understood');

  // 2. Text → structured entry
  let raw: unknown;
  try {
    raw = await deps.extractFromText(transcript);
  } catch (err) {
    if (err instanceof AiError && !err.retryable) return reject(job.uploadId, 'not_understood');
    throw err; // rate limit / network → BullMQ backs off and retries
  }

  // 3. Validate. In the app he reviews every field before saving, so a low-confidence
  //    result is still shown (with a warning) instead of being thrown away.
  const v = validateExtraction(raw, config.AI_MIN_CONFIDENCE);
  if (!v.ok && v.reason !== 'low_confidence') {
    return reject(job.uploadId, v.reason, v.missing ?? null);
  }
  const data = v.data!;
  if (data.intent !== 'TRANSACTION') return reject(job.uploadId, 'not_an_entry');

  const entry = await deps.ledger.createPending(job.organizationId, job.phone, `app_${job.uploadId}`, data, transcript);
  await setUpload(job.uploadId, {
    status: 'ready',
    transaction_id: entry.id,
    reason: v.ok ? null : 'low_confidence',
  });

  await deps.push.pushToMember(job.organizationId, job.phone, {
    title: 'Entry ready / एंट्री तैयार',
    body: `${entry.counterparty?.name ?? ''} — check and save`.trim(),
    data: { uploadId: job.uploadId, transactionId: entry.id },
  });
  return 'ready';
}

/** Called when the queue gives up on an app job, so the app can show "try again". */
export async function markAppVoiceFailed(uploadId: string) {
  await pool.query(
    `UPDATE voice_uploads SET status = 'failed', reason = 'server_error', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'queued'`,
    [uploadId]
  );
}

/**
 * Weekly reminder (Monday morning): push each owner a one-line summary of
 * overdue money, so he knows whom to call. Push notifications are free.
 */
export async function handleWeeklyReminder(deps: AppDeps = appDefaultDeps, now = new Date()): Promise<number> {
  const orgs = await pool.query(
    `SELECT DISTINCT organization_id FROM organization_members
      WHERE role = 'owner' AND is_active = TRUE AND push_token IS NOT NULL`
  );
  let sent = 0;
  for (const { organization_id: orgId } of orgs.rows) {
    const report = await deps.reports.ageingReport(orgId, now);
    const overdue = report.rows.filter((r) => (r.oldestUnpaidDays ?? 0) > 60);
    if (!overdue.length) continue;
    const amount = overdue.reduce((s, r) => s + r.outstanding, 0);
    await deps.push.pushToOrgOwners(orgId, {
      title: 'Payment reminders / वसूली',
      body: `${overdue.length} parties owe ${formatINR(amount)} for more than 60 days. Top: ${overdue[0].name}`,
      data: { screen: 'reminders' },
    });
    sent++;
  }
  return sent;
}
