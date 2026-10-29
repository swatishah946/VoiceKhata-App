import crypto from 'crypto';
import IORedis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as baseIt, vi } from 'vitest';
import { createJobQueue } from '../../src/queue';
import { AiError } from '../../src/services/ai.service';
import { appDefaultDeps, AppDeps } from '../../src/workers/app-handlers';
import { ORG, OWNER, pool, resetDb } from '../helpers/db';

/**
 * The real BullMQ queue + worker against a real Redis, with fake Whisper/Gemini/push.
 * Needs Redis: set TEST_REDIS_URL (CI does). Skipped locally if Redis is not running,
 * but in CI a missing Redis FAILS the run instead of silently skipping.
 */
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380';

async function redisReachable() {
  const probe = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
let available = false;
let connection: IORedis | null = null;

beforeAll(async () => {
  available = await redisReachable();
  if (!available && process.env.CI) throw new Error(`Redis not reachable at ${REDIS_URL} (required in CI)`);
  if (!available) console.warn(`⚠️ Redis not reachable at ${REDIS_URL}; queue tests skipped (set TEST_REDIS_URL)`);
  else connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});
beforeEach(resetDb);

/** Like it(), but skips when Redis is not running locally. */
const it = (name: string, fn: () => Promise<void>) =>
  baseIt(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });

const DISPATCH = {
  intent: 'TRANSACTION', transaction_type: 'dispatch', party_name: 'Siddhi Stone',
  sqft_quantity: 100, unit_rate: 30, confidence_level: 0.95,
};

function fakeDeps(extract: () => Promise<unknown>, transcript = 'Siddhi Stone ko 100 sqft bheja rate 30') {
  return {
    ...appDefaultDeps,
    transcribeAudio: vi.fn(async () => transcript),
    extractFromText: vi.fn(extract),
    push: { pushToMember: vi.fn(async () => undefined), pushToOrgOwners: vi.fn(async () => undefined) },
  } as unknown as AppDeps & { transcribeAudio: ReturnType<typeof vi.fn>; extractFromText: ReturnType<typeof vi.fn> };
}

async function newUpload() {
  const uploadId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO voice_uploads (id, organization_id, member_phone, client_entry_id, audio, audio_mime)
     VALUES ($1, $2, $3, $4, $5, 'audio/m4a')`,
    [uploadId, ORG, OWNER, crypto.randomUUID(), Buffer.from('audio')]
  );
  return { uploadId, organizationId: ORG, phone: OWNER };
}

const uploadRow = async (id: string) =>
  (await pool.query(`SELECT status, reason, transaction_id FROM voice_uploads WHERE id = $1`, [id])).rows[0];

let seq = 0;
const open: Array<{ close: () => Promise<void>; worker?: { close: () => Promise<void> } }> = [];

function setup(deps: AppDeps, attempts = 3) {
  const q = createJobQueue({
    connection: connection!,
    name: `test_${Date.now()}_${++seq}`, // isolated queue per test
    deps,
    attempts,
    backoffDelayMs: 10,
    limiter: { max: 1000, duration: 1000 },
    log: () => undefined,
  });
  const worker = q.startWorker();
  open.push({ close: q.close, worker });
  return { ...q, worker };
}

/** Resolves once `n` jobs have finished (completed or permanently failed). */
function waitForJobs(worker: ReturnType<ReturnType<typeof createJobQueue>['startWorker']>, n: number) {
  return new Promise<{ completed: string[]; failed: string[] }>((resolve) => {
    const completed: string[] = [];
    const failed: string[] = [];
    const check = () => completed.length + failed.length >= n && resolve({ completed, failed });
    worker.on('completed', (j) => {
      completed.push(j.id!);
      check();
    });
    worker.on('failed', (j, err) => {
      if (j && (j.attemptsMade >= (j.opts.attempts ?? 1) || err.name === 'UnrecoverableError')) {
        // give the failure handler a moment to mark the upload
        setTimeout(() => {
          failed.push(j.id!);
          check();
        }, 50);
      }
    });
  });
}

afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.worker?.close();
    await o.close();
  }
});
afterAll(async () => {
  await connection?.quit();
});

describe('job queue (real Redis)', () => {
  it('turns a voice note into a pending entry ready to review', async () => {
    const deps = fakeDeps(async () => DISPATCH);
    const { enqueueAppVoice, worker } = setup(deps);
    const done = waitForJobs(worker, 1);
    const job = await newUpload();
    await enqueueAppVoice(job);
    expect((await done).completed).toHaveLength(1);
    const row = await uploadRow(job.uploadId);
    expect(row.status).toBe('ready');
    expect(row.transaction_id).toBeTruthy();
  });

  it('the same upload queued twice (phone retried) runs once', async () => {
    const deps = fakeDeps(async () => DISPATCH);
    const { enqueueAppVoice, worker } = setup(deps);
    const done = waitForJobs(worker, 1);
    const job = await newUpload();
    await enqueueAppVoice(job);
    await enqueueAppVoice(job);
    await enqueueAppVoice(job);
    await done;
    await new Promise((r) => setTimeout(r, 200)); // would a 2nd job run?
    expect(deps.transcribeAudio).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT 1 FROM transactions`)).rowCount).toBe(1);
  });

  it('processes voice notes strictly in the order they arrived', async () => {
    const order: string[] = [];
    const deps = fakeDeps(async () => DISPATCH);
    deps.transcribeAudio.mockImplementation(async () => {
      order.push(`t${order.length}`);
      return 'Siddhi Stone ko 100 sqft bheja rate 30';
    });
    const { enqueueAppVoice, worker } = setup(deps);
    const done = waitForJobs(worker, 3);
    const jobs = [await newUpload(), await newUpload(), await newUpload()];
    for (const j of jobs) await enqueueAppVoice(j);
    await done;
    const created = await pool.query(
      `SELECT v.id FROM voice_uploads v JOIN transactions t ON t.id = v.transaction_id ORDER BY t.created_at`
    );
    expect(created.rows.map((r) => r.id)).toEqual(jobs.map((j) => j.uploadId));
  });

  it('retries after a Gemini rate limit, then succeeds (Whisper is not paid again)', async () => {
    let calls = 0;
    const deps = fakeDeps(async () => {
      if (++calls < 3) throw new AiError('429 quota', true, 429);
      return DISPATCH;
    });
    const { enqueueAppVoice, worker } = setup(deps, 5);
    const done = waitForJobs(worker, 1);
    const job = await newUpload();
    await enqueueAppVoice(job);
    expect((await done).completed).toHaveLength(1);
    expect(calls).toBe(3);
    expect(deps.transcribeAudio).toHaveBeenCalledTimes(1); // transcript kept between attempts
    expect((await uploadRow(job.uploadId)).status).toBe('ready');
  });

  it('after the last failed attempt, the upload is marked failed so the app can offer "Try again"', async () => {
    const deps = fakeDeps(async () => {
      throw new AiError('503 overloaded', true, 503);
    });
    const { enqueueAppVoice, worker } = setup(deps, 3);
    const done = waitForJobs(worker, 1);
    const job = await newUpload();
    await enqueueAppVoice(job);
    expect((await done).failed).toHaveLength(1);
    expect(deps.extractFromText).toHaveBeenCalledTimes(3);
    expect(await uploadRow(job.uploadId)).toMatchObject({ status: 'failed', reason: 'server_error' });
  });

  it('the weekly reminder is registered once, however many times the server restarts', async () => {
    const { scheduleWeeklyReminder, queue } = setup(fakeDeps(async () => DISPATCH));
    await scheduleWeeklyReminder();
    await scheduleWeeklyReminder();
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ pattern: '0 9 * * 1', tz: 'Asia/Kolkata' });
  });
});
