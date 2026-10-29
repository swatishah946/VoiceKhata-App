import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { signToken } from '../../src/middleware/auth';
import { appLoginLimiter } from '../../src/routes/app.routes';
import { AiError } from '../../src/services/ai.service';
import * as Ledger from '../../src/services/ledger.service';
import { appDefaultDeps, AppDeps, AppVoiceJob, handleAppVoice, handleWeeklyReminder, markAppVoiceFailed } from '../../src/workers/app-handlers';
import { ORG, OWNER, partyBalance, pool, resetDb, seedPrice } from '../helpers/db';

/**
 * The Android app's API, end to end against the real database:
 * PIN login → voice upload → worker → review → save with corrections.
 * Whisper, Gemini and push are faked (no network).
 */

const STAFF = '+919811122233';
const PIN = '4821';
let pinHash = '';

const queued: AppVoiceJob[] = [];
let enqueueFails = false;
const app = createApp({
  enqueueAppVoice: async (job) => {
    if (enqueueFails) throw new Error('redis down');
    queued.push(job);
  },
});

const DISPATCH = {
  intent: 'TRANSACTION', transaction_type: 'dispatch', party_name: 'Siddhi Stone', stone_type: '2x1½',
  sqft_quantity: 5000, unit_rate: 31.5, loading_charge: 1500, confidence_level: 0.95,
};

function fakeDeps(ai: unknown | (() => unknown), transcript = 'Siddhi Stone ko 5000 sqft bheja rate 31.5') {
  const pushes: Array<{ phone: string; title: string; body: string }> = [];
  const deps: AppDeps = {
    ...appDefaultDeps,
    transcribeAudio: vi.fn(async () => transcript),
    extractFromText: vi.fn(async () => (typeof ai === 'function' ? (ai as () => unknown)() : ai)),
    push: {
      pushToMember: vi.fn(async (_org: string, phone: string, m: any) => void pushes.push({ phone, ...m })),
      pushToOrgOwners: vi.fn(async (_org: string, m: any) => void pushes.push({ phone: 'owners', ...m })),
    },
  };
  return { deps, pushes };
}

async function login(phone = OWNER, pin = PIN) {
  return request(app).post('/api/app/auth/login').send({ phone, pin });
}
let token = '';
const auth = (r: request.Test, t = token) => r.set('Authorization', `Bearer ${t}`);

async function upload(clientId = crypto.randomUUID(), t = token) {
  return auth(request(app).post('/api/app/voice'), t)
    .set('Content-Type', 'audio/m4a')
    .set('X-Client-Entry-Id', clientId)
    .send(Buffer.from('fake-m4a-audio'));
}

/** Upload + run the worker job → the upload id and the pending entry id */
async function recordEntry(ai: unknown = DISPATCH) {
  const r = await upload();
  const { deps } = fakeDeps(ai);
  expect(await handleAppVoice(queued.at(-1)!, deps)).toBe('ready');
  const view = await auth(request(app).get(`/api/app/voice/${r.body.uploadId}`));
  return { uploadId: r.body.uploadId as string, entryId: view.body.entry.id as string, view: view.body };
}

beforeAll(async () => {
  pinHash = await bcrypt.hash(PIN, 4);
});

async function resetLoginLimit() {
  for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) await appLoginLimiter.resetKey(ip);
}

beforeEach(async () => {
  await resetDb();
  await resetLoginLimit();
  queued.length = 0;
  enqueueFails = false;
  await pool.query(`UPDATE organization_members SET pin_hash = $1 WHERE phone = $2`, [pinHash, OWNER]);
  token = (await login()).body.token;
});

describe('PIN login', () => {
  it('returns a token, the member and the business', async () => {
    const r = await login('98765 43210'); // a bare Indian number is normalised to +91
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ phone: OWNER, role: 'owner', name: 'Papa' });
    expect(r.body.business.name).toBe('VoiceKhata Admin');
    const me = await auth(request(app).get('/api/app/me'), r.body.token);
    expect(me.body.member.phone).toBe(OWNER);
  });

  it('wrong PIN, unknown phone and a member without a PIN are all refused the same way', async () => {
    await pool.query(`INSERT INTO organization_members (phone, organization_id, name, role) VALUES ($1, $2, 'Munshi', 'staff')`, [STAFF, ORG]);
    for (const [phone, pin] of [[OWNER, '0000'], ['+919000000001', PIN], [STAFF, PIN]]) {
      const r = await login(phone, pin);
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Wrong phone number or PIN');
    }
  });

  it('locks out after 5 failed attempts (brute-forcing a 4-digit PIN is not possible)', async () => {
    for (let i = 0; i < 5; i++) expect((await login(OWNER, '0000')).status).toBe(401);
    expect((await login(OWNER, '0000')).status).toBe(429);
    expect((await login()).status).toBe(429); // even the right PIN, until the window passes
    await resetLoginLimit();
  });

  it('rejects malformed input', async () => {
    expect((await login(OWNER, '12')).status).toBe(400);
    expect((await login(OWNER, 'abcd')).status).toBe(400);
    expect((await login('not a phone', PIN)).status).toBe(400);
  });

  it('a deactivated member cannot log in, and their old token stops working for /me', async () => {
    await pool.query(`UPDATE organization_members SET is_active = FALSE WHERE phone = $1`, [OWNER]);
    expect((await login()).status).toBe(401);
    expect((await auth(request(app).get('/api/app/me'))).status).toBe(401);
  });

  it('needs a valid token: none → 401, forged → 401, token without a member → 403', async () => {
    expect((await request(app).get('/api/app/me')).status).toBe(401);
    expect((await request(app).get('/api/parties')).status).toBe(401);
    const forged = jwt.sign({ orgId: ORG, role: 'owner', phone: OWNER }, 'not-the-server-secret-but-32-chars-long');
    expect((await auth(request(app).get('/api/app/me'), forged)).status).toBe(401);
    expect((await auth(request(app).get('/api/app/me'), signToken({ orgId: ORG, role: 'owner' }))).status).toBe(403);
  });

  it('the same token works for balances and reports (parties, summary)', async () => {
    expect((await auth(request(app).get('/api/parties'))).status).toBe(200);
    expect((await auth(request(app).get('/api/summary/today'))).status).toBe(200);
  });
});

describe('voice upload', () => {
  it('stores the audio and queues one job', async () => {
    const r = await upload();
    expect(r.status).toBe(202);
    expect(queued).toEqual([{ uploadId: r.body.uploadId, organizationId: ORG, phone: OWNER }]);
    const row = await pool.query(`SELECT status, audio_mime, length(audio) AS n FROM voice_uploads`);
    expect(row.rows[0]).toMatchObject({ status: 'queued', audio_mime: 'audio/m4a', n: 14 });
  });

  it('a retried upload (same X-Client-Entry-Id) returns the same upload and stores nothing new', async () => {
    const id = crypto.randomUUID();
    const a = await upload(id);
    const b = await upload(id);
    expect(b.status).toBe(200);
    expect(b.body.uploadId).toBe(a.body.uploadId);
    expect((await pool.query(`SELECT 1 FROM voice_uploads`)).rowCount).toBe(1);
  });

  it('if the queue is down: 503, and the retry queues the saved upload', async () => {
    const id = crypto.randomUUID();
    enqueueFails = true;
    const a = await upload(id);
    expect(a.status).toBe(503);
    enqueueFails = false;
    const b = await upload(id);
    expect(b.body.uploadId).toBe(a.body.uploadId);
    expect(queued).toHaveLength(1);
  });

  it('validates the client id and body', async () => {
    const noId = await auth(request(app).post('/api/app/voice')).set('Content-Type', 'audio/m4a').send(Buffer.from('x'));
    expect(noId.status).toBe(400);
    const empty = await auth(request(app).post('/api/app/voice'))
      .set('Content-Type', 'audio/m4a').set('X-Client-Entry-Id', crypto.randomUUID()).send(Buffer.alloc(0));
    expect(empty.status).toBe(400);
  });

  it('refuses audio over 10 MB', async () => {
    const r = await auth(request(app).post('/api/app/voice'))
      .set('Content-Type', 'audio/m4a')
      .set('X-Client-Entry-Id', crypto.randomUUID())
      .send(Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
  });
});

describe('worker: voice note → draft', () => {
  it('creates a pending draft, frees the audio and notifies the phone', async () => {
    const r = await upload();
    const { deps, pushes } = fakeDeps(DISPATCH);
    expect(await handleAppVoice(queued[0], deps)).toBe('ready');

    const view = await auth(request(app).get(`/api/app/voice/${r.body.uploadId}`));
    expect(view.body.status).toBe('ready');
    expect(view.body.transcript).toContain('Siddhi');
    expect(view.body.entry).toMatchObject({ status: 'pending_confirmation', total: 15_900_000 }); // ₹1,59,000 in paise
    expect(view.body.fields).toMatchObject({ party_name: 'Siddhi Stone', unit_rate: 31.5, sqft_quantity: 5000 });
    expect(pushes[0]).toMatchObject({ phone: OWNER });

    const row = await pool.query(`SELECT audio FROM voice_uploads`);
    expect(row.rows[0].audio).toBeNull(); // audio is not kept after transcription
  });

  it('running the same job twice does not create a second entry', async () => {
    await upload();
    const { deps } = fakeDeps(DISPATCH);
    await handleAppVoice(queued[0], deps);
    expect(await handleAppVoice(queued[0], deps)).toBe('already_done');
    expect((await pool.query(`SELECT 1 FROM transactions`)).rowCount).toBe(1);
  });

  it('after a Gemini rate limit, the retry reuses the saved transcript (Whisper is not paid twice)', async () => {
    await upload();
    let calls = 0;
    const { deps } = fakeDeps(() => {
      if (++calls === 1) throw new AiError('429', true, 429);
      return DISPATCH;
    });
    await expect(handleAppVoice(queued[0], deps)).rejects.toThrow('429');
    expect(await handleAppVoice(queued[0], deps)).toBe('ready');
    expect(deps.transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('missing details → rejected, with the missing fields for the app to show', async () => {
    const r = await upload();
    const { deps } = fakeDeps({ ...DISPATCH, unit_rate: null });
    expect(await handleAppVoice(queued[0], deps)).toBe('rejected');
    const view = await auth(request(app).get(`/api/app/voice/${r.body.uploadId}`));
    expect(view.body).toMatchObject({ status: 'rejected', reason: 'missing_fields', missing: ['rate'] });
    expect((await pool.query(`SELECT 1 FROM transactions`)).rowCount).toBe(0);
  });

  it('low confidence is still shown for review, flagged', async () => {
    const r = await upload();
    const { deps } = fakeDeps({ ...DISPATCH, confidence_level: 0.3 });
    expect(await handleAppVoice(queued[0], deps)).toBe('ready');
    const view = await auth(request(app).get(`/api/app/voice/${r.body.uploadId}`));
    expect(view.body).toMatchObject({ status: 'ready', reason: 'low_confidence' });
  });

  it('a question instead of an entry, empty speech, or AI nonsense → rejected', async () => {
    for (const [ai, transcript, reason] of [
      [{ intent: 'GET_KHATA', person_name: 'Ramesh' }, 'Ramesh ka khata', 'not_an_entry'],
      [DISPATCH, '', 'not_understood'],
      [() => { throw new AiError('bad json', false); }, 'x', 'not_understood'],
    ] as const) {
      await upload();
      const { deps } = fakeDeps(ai, transcript);
      expect(await handleAppVoice(queued.at(-1)!, deps)).toBe('rejected');
      const row = await pool.query(`SELECT reason FROM voice_uploads WHERE id = $1`, [queued.at(-1)!.uploadId]);
      expect(row.rows[0].reason).toBe(reason);
    }
  });

  it('when the queue gives up, the upload is marked failed so the app can offer a retry', async () => {
    const r = await upload();
    await markAppVoiceFailed(r.body.uploadId);
    const view = await auth(request(app).get(`/api/app/voice/${r.body.uploadId}`));
    expect(view.body).toMatchObject({ status: 'failed', reason: 'server_error' });
  });

  it('after the queue gave up, re-uploading the same entry puts it back in the queue', async () => {
    const id = crypto.randomUUID();
    const r = await upload(id);
    await markAppVoiceFailed(r.body.uploadId);
    queued.length = 0;
    const again = await upload(id);
    expect(again.body).toEqual({ uploadId: r.body.uploadId, status: 'queued' });
    expect(queued).toHaveLength(1);
    const { deps } = fakeDeps(DISPATCH);
    expect(await handleAppVoice(queued[0], deps)).toBe('ready');
  });

  it("another member cannot see this member's uploads", async () => {
    const r = await upload();
    await pool.query(`INSERT INTO organization_members (phone, organization_id, name, role, pin_hash) VALUES ($1, $2, 'Munshi', 'staff', $3)`, [STAFF, ORG, pinHash]);
    const staffToken = (await login(STAFF)).body.token;
    expect((await auth(request(app).get(`/api/app/voice/${r.body.uploadId}`), staffToken)).status).toBe(404);
    expect((await auth(request(app).get('/api/app/voice'), staffToken)).body).toEqual([]);
  });

  it('GET /voice lists recent uploads for syncing', async () => {
    await recordEntry();
    await upload();
    const list = await auth(request(app).get('/api/app/voice'));
    expect(list.body.map((u: any) => u.status).sort()).toEqual(['queued', 'ready']);
  });
});

describe('review screen → save', () => {
  it('saving without changes confirms the entry and records "AI was right"', async () => {
    const { entryId } = await recordEntry();
    const r = await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({ edits: {} });
    expect(r.status).toBe(200);
    expect(await partyBalance('Siddhi Stone')).toMatchObject({ outstanding: 159000 });
    const review = await pool.query(`SELECT changed_fields FROM entry_reviews`);
    expect(review.rows[0].changed_fields).toEqual([]);
    const a = await pool.query(`SELECT user_agent FROM audit_logs WHERE action = 'transaction.confirm'`);
    expect(a.rows[0].user_agent).toBe(`app:${OWNER}`);
  });

  it('a corrected rate is re-validated and the bill re-computed on the server', async () => {
    const { entryId } = await recordEntry();
    const r = await auth(request(app).post(`/api/app/entries/${entryId}/save`))
      .send({ edits: { unit_rate: 32, total_amount: 1 } }); // a total sent by the phone is ignored
    expect(r.status).toBe(200);
    expect(r.body.entry.total).toBe(16_150_000); // 5000 × 32 + 1500 = ₹1,61,500
    expect(await partyBalance('Siddhi Stone')).toMatchObject({ outstanding: 161500 });

    const review = await pool.query(`SELECT ai_values, final_values, changed_fields FROM entry_reviews`);
    expect(review.rows[0]).toMatchObject({
      changed_fields: ['unit_rate'],
      ai_values: expect.objectContaining({ unit_rate: 31.5 }),
      final_values: expect.objectContaining({ unit_rate: 32 }),
    });
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'transaction.edit'`)).rowCount).toBe(1);
  });

  it('a corrected party name is matched to the existing party', async () => {
    await pool.query(`INSERT INTO parties (organization_id, name, type) VALUES ($1, 'Ramesh Traders', 'customer')`, [ORG]);
    const { entryId } = await recordEntry({ ...DISPATCH, party_name: 'Rames' });
    await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({ edits: { party_name: 'ramesh traders' } });
    expect(await partyBalance('Ramesh Traders')).toMatchObject({ outstanding: 159000 });
    expect((await pool.query(`SELECT 1 FROM parties`)).rowCount).toBe(1); // no new "Rames" party
  });

  it('a price-list warning is recomputed for the corrected rate', async () => {
    await seedPrice('2x1½', 31.5);
    const { entryId, view } = await recordEntry({ ...DISPATCH, unit_rate: 13.5 }); // mis-heard 31.5
    expect(view.entry.priceWarning).toMatchObject({ masterRate: 31.5, spokenRate: 13.5 });
    const r = await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({ edits: { unit_rate: 31.5 } });
    expect(r.body.entry.priceWarning).toBeNull();
  });

  it('invalid corrections are refused (422) and the entry stays pending', async () => {
    const { entryId } = await recordEntry();
    for (const edits of [{ unit_rate: -5 }, { party_name: null }, { sqft_quantity: 'lots' }]) {
      const r = await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({ edits });
      expect(r.status).toBe(422);
    }
    const bad = await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({ edits: { unit_rate: { x: 1 } } });
    expect(bad.status).toBe(400);
    expect((await pool.query(`SELECT status FROM transactions`)).rows[0].status).toBe('pending_confirmation');
    expect(await partyBalance('Siddhi Stone')).toBeNull();
  });

  it('saving twice is refused and applied once', async () => {
    const { entryId } = await recordEntry({ ...DISPATCH, transaction_type: 'payment', amount: 5000 });
    expect((await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({})).status).toBe(200);
    expect((await auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({})).status).toBe(409);
    expect((await partyBalance('Siddhi Stone'))!.paid).toBe(5000);
  });

  it('a Save and another confirm at the same moment apply the entry once', async () => {
    const { entryId } = await recordEntry({ ...DISPATCH, transaction_type: 'payment', amount: 700 });
    const [a, b] = await Promise.all([
      auth(request(app).post(`/api/app/entries/${entryId}/save`)).send({ edits: { amount: 700 } }),
      Ledger.confirmPending(ORG, OWNER),
    ]);
    expect((a.status === 200 ? 1 : 0) + (b.status === 'done' ? 1 : 0)).toBe(1);
    expect((await partyBalance('Siddhi Stone'))!.paid).toBe(700);
  });

  it('cancel discards the draft', async () => {
    const { entryId } = await recordEntry();
    expect((await auth(request(app).post(`/api/app/entries/${entryId}/cancel`))).status).toBe(200);
    expect((await auth(request(app).post(`/api/app/entries/${entryId}/cancel`))).status).toBe(409);
    expect(await partyBalance('Siddhi Stone')).toBeNull();
  });
});

describe('reminders', () => {
  /** A confirmed dispatch (or payment) for a party, back-dated by `daysAgo`. */
  async function confirmed(party: string, type: 'dispatch' | 'payment', rupees: number, daysAgo: number) {
    const data: any =
      type === 'dispatch'
        ? { intent: 'TRANSACTION', transaction_type: 'dispatch', party_name: party, sqft_quantity: rupees, unit_rate: 1, confidence_level: 1 }
        : { intent: 'TRANSACTION', transaction_type: 'payment', party_name: party, amount: rupees, confidence_level: 1 };
    const e = await Ledger.createPending(ORG, OWNER, `SMage${crypto.randomUUID().replace(/-/g, '')}`, data);
    await Ledger.confirmById(ORG, e.id);
    await pool.query(`UPDATE transactions SET confirmed_at = confirmed_at - make_interval(days => $2) WHERE id = $1`, [e.id, daysAgo]);
  }

  it('ageing: payments settle the oldest bills first', async () => {
    await confirmed('Ramesh', 'dispatch', 10_000, 100); // oldest
    await confirmed('Ramesh', 'dispatch', 20_000, 45);
    await confirmed('Ramesh', 'dispatch', 5_000, 10);
    await confirmed('Ramesh', 'payment', 12_000, 5); // pays off the ₹10,000 bill and ₹2,000 of the next
    await confirmed('Mohan', 'dispatch', 3_000, 2);

    const r = await auth(request(app).get('/api/app/reports/ageing'));
    expect(r.status).toBe(200);
    const ramesh = r.body.rows.find((x: any) => x.name === 'Ramesh');
    expect(ramesh.outstanding).toBe(2_300_000); // ₹23,000
    expect(ramesh.buckets).toEqual({ '0-30': 500_000, '31-60': 1_800_000, '61-90': 0, '90+': 0 });
    expect(ramesh.oldestUnpaidDays).toBe(45);
    expect(r.body.rows[0].name).toBe('Ramesh'); // most overdue first
    expect(r.body.totalOutstanding).toBe(2_600_000);
    expect(r.body.totals['0-30']).toBe(800_000);
  });

  it('weekly push: only owners with overdue (>60 days) customers are notified', async () => {
    await pool.query(`UPDATE organization_members SET push_token = 'ExponentPushToken[abc]' WHERE phone = $1`, [OWNER]);
    await confirmed('Old Party', 'dispatch', 50_000, 75);
    await confirmed('New Party', 'dispatch', 10_000, 3);
    const { deps, pushes } = fakeDeps(DISPATCH);
    expect(await handleWeeklyReminder(deps)).toBe(1);
    expect(pushes[0].body).toContain('1 parties owe ₹50,000.00');
    expect(pushes[0].body).toContain('Old Party');

    await pool.query(`TRUNCATE party_balances CASCADE`);
    expect(await handleWeeklyReminder(deps)).toBe(0);
  });

  it('push token: valid Expo tokens are saved, anything else refused', async () => {
    expect((await auth(request(app).post('/api/app/push-token')).send({ token: 'ExponentPushToken[xyz-1]' })).status).toBe(200);
    expect((await pool.query(`SELECT push_token FROM organization_members WHERE phone = $1`, [OWNER])).rows[0].push_token)
      .toBe('ExponentPushToken[xyz-1]');
    expect((await auth(request(app).post('/api/app/push-token')).send({ token: 'http://evil' })).status).toBe(400);
    expect((await auth(request(app).post('/api/app/push-token')).send({ token: null })).status).toBe(200);
  });

  it('price list PDF downloads with the app token', async () => {
    await seedPrice('2x1½', 31.5);
    const r = await auth(request(app).get('/api/app/price-list.pdf'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
  });
});
