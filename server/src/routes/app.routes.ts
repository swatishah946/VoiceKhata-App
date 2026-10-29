import express, { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import pool from '../db';
import { normalizePhone } from '../lib/phone';
import { authMiddleware, signToken } from '../middleware/auth';
import * as Ledger from '../services/ledger.service';
import { generatePricingPdf } from '../services/pdf.service';
import { isExpoPushToken } from '../services/push.service';
import { ageingReport } from '../services/reports.service';
import type { AppVoiceJob } from '../workers/app-handlers';

/**
 * App routes (/api/app/...): login, voice upload, review and save, reminders.
 * Balances, party history and khata PDFs are in api.routes.ts (/api/...).
 */

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // ~40 min at the app's 32 kbps; a voice entry is seconds
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_RE = /^\d{4,6}$/;
// Compared against when the phone is unknown, so a wrong phone and a wrong PIN take the same time
const DUMMY_HASH = bcrypt.hashSync('not-a-real-pin', 10);

export const appLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

export function createAppRouter(enqueueAppVoice: (job: AppVoiceJob) => Promise<void>) {
  const router = Router();
  const json = express.json({ limit: '20kb' });

  /** Phone + PIN → token. PINs are set with `npm run set-pin`. */
  router.post('/auth/login', json, appLoginLimiter, async (req: Request, res: Response) => {
    const phone = normalizePhone(typeof req.body?.phone === 'string' ? req.body.phone : null);
    const pin = req.body?.pin;
    if (!phone || typeof pin !== 'string' || !PIN_RE.test(pin)) {
      return res.status(400).json({ error: 'Phone number and 4–6 digit PIN required' });
    }
    const r = await pool.query(
      `SELECT m.organization_id, m.phone, m.name, m.role, m.pin_hash, o.name AS business
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.phone = $1 AND m.is_active = TRUE`,
      [phone]
    );
    const member = r.rows[0];
    const ok = await bcrypt.compare(pin, member?.pin_hash || DUMMY_HASH);
    if (!member?.pin_hash || !ok) return res.status(401).json({ error: 'Wrong phone number or PIN' });

    res.json({
      token: signToken({ orgId: member.organization_id, role: member.role, phone: member.phone }),
      member: { phone: member.phone, name: member.name, role: member.role },
      business: { name: member.business },
    });
  });

  router.use(authMiddleware);
  router.use((req: Request, res: Response, next) => {
    if (!req.user?.phone) return res.status(403).json({ error: 'App login required' });
    next();
  });

  router.get('/me', async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT m.phone, m.name, m.role, o.name AS business
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.phone = $1 AND m.organization_id = $2 AND m.is_active = TRUE`,
      [req.user!.phone, req.user!.orgId]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Member no longer active' });
    const m = r.rows[0];
    res.json({ member: { phone: m.phone, name: m.name, role: m.role }, business: { name: m.business } });
  });

  router.post('/push-token', json, async (req: Request, res: Response) => {
    const token = req.body?.token ?? null;
    if (token !== null && !isExpoPushToken(token)) return res.status(400).json({ error: 'Invalid push token' });
    await pool.query(`UPDATE organization_members SET push_token = $1 WHERE phone = $2 AND organization_id = $3`, [
      token, req.user!.phone, req.user!.orgId,
    ]);
    res.json({ ok: true });
  });

  /**
   * Upload one recorded voice note (raw audio body).
   * Header X-Client-Entry-Id: UUID made by the phone when it recorded. Retrying the
   * same upload (network dropped after the server saved it) returns the same
   * upload and never creates a second entry.
   */
  router.post(
    '/voice',
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }),
    async (req: Request, res: Response) => {
      const clientId = String(req.header('x-client-entry-id') || '');
      if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'X-Client-Entry-Id must be a UUID' });
      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) return res.status(400).json({ error: 'Audio body required' });
      const mime = String(req.header('content-type') || 'audio/m4a').split(';')[0].slice(0, 50);
      const recordedAtHeader = req.header('x-recorded-at');
      const recordedAt = recordedAtHeader && !isNaN(Date.parse(recordedAtHeader)) ? new Date(recordedAtHeader) : null;
      const { orgId, phone } = req.user as { orgId: string; phone: string };

      const inserted = await pool.query(
        `INSERT INTO voice_uploads (id, organization_id, member_phone, client_entry_id, audio, audio_mime, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, client_entry_id) DO NOTHING
         RETURNING id, status`,
        [crypto.randomUUID(), orgId, phone, clientId, audio, mime, recordedAt]
      );
      let upload =
        inserted.rows[0] ??
        (await pool.query(`SELECT id, status FROM voice_uploads WHERE organization_id = $1 AND client_entry_id = $2`, [
          orgId, clientId,
        ])).rows[0];

      // "Try again" in the app after the queue gave up: put it back in the queue.
      // (The saved transcript, or the audio if it was never transcribed, is still there.)
      if (upload.status === 'failed') {
        upload = (await pool.query(
          `UPDATE voice_uploads SET status = 'queued', reason = NULL, updated_at = CURRENT_TIMESTAMP,
                  audio = CASE WHEN transcript IS NULL AND audio IS NULL THEN $2 ELSE audio END
            WHERE id = $1 RETURNING id, status`,
          [upload.id, audio]
        )).rows[0];
      }

      // (Re-)queue while still waiting. Safe to repeat: the job id is the upload id.
      if (upload.status === 'queued') {
        try {
          await enqueueAppVoice({ uploadId: upload.id, organizationId: orgId, phone });
        } catch (err) {
          // Saved but not queued (Redis down). The phone retries with the same id and we queue it then.
          console.error(`❌ could not queue app voice ${upload.id}: ${(err as Error).message}`);
          return res.status(503).json({ error: 'Saved, but processing is unavailable. Retry later.', uploadId: upload.id });
        }
      }
      res.status(inserted.rows.length ? 202 : 200).json({ uploadId: upload.id, status: upload.status });
    }
  );

  async function uploadView(orgId: string, row: any) {
    const view: Record<string, unknown> = {
      uploadId: row.id,
      clientEntryId: row.client_entry_id,
      status: row.status,
      reason: row.reason,
      missing: row.missing_fields ?? [],
      transcript: row.transcript,
      createdAt: row.created_at,
    };
    if (row.transaction_id) {
      view.entry = await Ledger.getEntry(orgId, row.transaction_id);
      const ai = (await pool.query(`SELECT ai_extracted_json FROM transactions WHERE id = $1`, [row.transaction_id])).rows[0];
      const fields: Record<string, unknown> = {};
      for (const f of Ledger.EDITABLE_FIELDS) fields[f] = ai?.ai_extracted_json?.[f] ?? null;
      view.fields = fields; // what the AI understood, to pre-fill the review form
    }
    return view;
  }

  /** This member's recent uploads: the app polls this to sync statuses. */
  router.get('/voice', async (req: Request, res: Response) => {
    const r = await pool.query(
      `SELECT id, client_entry_id, status, reason, missing_fields, transcript, transaction_id, created_at
         FROM voice_uploads WHERE organization_id = $1 AND member_phone = $2
        ORDER BY created_at DESC LIMIT 50`,
      [req.user!.orgId, req.user!.phone]
    );
    res.json(await Promise.all(r.rows.map((row) => uploadView(req.user!.orgId, row))));
  });

  router.get('/voice/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const r = await pool.query(
      `SELECT id, client_entry_id, status, reason, missing_fields, transcript, transaction_id, created_at
         FROM voice_uploads WHERE id = $1 AND organization_id = $2 AND member_phone = $3`,
      [id, req.user!.orgId, req.user!.phone]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await uploadView(req.user!.orgId, r.rows[0]));
  });

  /** Review screen → Save, with his corrections (server re-validates and re-computes). */
  router.post('/entries/:id/save', json, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const body = req.body?.edits ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'edits must be an object' });
    const edits: Ledger.EntryEdits = {};
    for (const f of Ledger.EDITABLE_FIELDS) {
      if (!(f in body)) continue;
      const v = body[f];
      if (v !== null && typeof v !== 'number' && !(typeof v === 'string' && v.length <= 120)) {
        return res.status(400).json({ error: `Invalid value for ${f}` });
      }
      edits[f] = v;
    }
    const r = await Ledger.confirmWithEdits(req.user!.orgId, id, edits, `app:${req.user!.phone}`);
    if (r.status === 'not_found') return res.status(409).json({ error: 'Entry is not pending (already saved, cancelled, or not found)' });
    if (r.status === 'invalid') return res.status(422).json({ error: 'Missing or invalid details', missing: r.missing });
    res.json({ status: 'confirmed', entry: r.entry });
  });

  router.post('/entries/:id/cancel', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
    const r = await Ledger.cancelById(req.user!.orgId, id, `app:${req.user!.phone}`);
    if (r.status === 'not_found') return res.status(409).json({ error: 'Entry is not pending' });
    res.json({ status: 'cancelled' });
  });

  /** Who owes money and for how long (0–30 / 31–60 / 61–90 / 90+ days). */
  router.get('/reports/ageing', async (req: Request, res: Response) => {
    res.json(await ageingReport(req.user!.orgId));
  });

  router.get('/price-list.pdf', async (req: Request, res: Response) => {
    const pdf = await generatePricingPdf(req.user!.orgId);
    res.setHeader('Content-Disposition', 'attachment; filename="Price_List.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/pdf').send(pdf);
  });

  return router;
}
