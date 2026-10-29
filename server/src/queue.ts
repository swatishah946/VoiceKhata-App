import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import {
  appDefaultDeps,
  AppDeps,
  AppVoiceJob,
  handleAppVoice,
  handleWeeklyReminder,
  markAppVoiceFailed,
} from './workers/app-handlers';

/**
 * BullMQ queue + worker for the slow work (Whisper + Gemini) and the weekly reminder.
 *
 *  - job id = upload id, so a re-uploaded voice note is never queued twice;
 *  - 5 attempts with exponential backoff (5 s, 10 s, 20 s, 40 s) for rate limits
 *    and network errors; errors that can never succeed are not retried;
 *  - a limiter of 12 jobs/min keeps us inside the Gemini free tier;
 *  - concurrency 1 processes voice notes in the order they arrived;
 *  - when a job fails for the last time, the upload is marked 'failed' so the
 *    app can offer "Try again";
 *  - everything is injectable so tests run the real queue against a real Redis.
 */

export const QUEUE_NAME = 'voicekhata_jobs';
export const JOB_ATTEMPTS = 5;

export function createRedisConnection(url = config.REDIS_URL): IORedis {
  return url
    ? new IORedis(url, { maxRetriesPerRequest: null })
    : new IORedis({ host: config.REDIS_HOST, port: config.REDIS_PORT, maxRetriesPerRequest: null });
}

export interface JobQueueOptions {
  connection?: IORedis;
  name?: string;
  deps?: AppDeps;
  attempts?: number;
  backoffDelayMs?: number;
  limiter?: { max: number; duration: number };
  log?: (msg: string) => void;
}

export function createJobQueue(opts: JobQueueOptions = {}) {
  const connection = opts.connection ?? createRedisConnection();
  const name = opts.name ?? QUEUE_NAME;
  const deps = opts.deps ?? appDefaultDeps;
  const log = opts.log ?? console.log;

  const queue = new Queue(name, {
    connection: connection as any,
    defaultJobOptions: {
      attempts: opts.attempts ?? JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: opts.backoffDelayMs ?? 5000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  /** Voice note from the app. Job id = upload id, so a re-upload is never queued twice. */
  async function enqueueAppVoice(job: AppVoiceJob): Promise<void> {
    await queue.add('app_voice', job, { jobId: `app_${job.uploadId}` });
  }

  /** Monday 9:00 IST: weekly overdue-payments push to owners (idempotent: same scheduler id). */
  async function scheduleWeeklyReminder(): Promise<void> {
    await queue.upsertJobScheduler(
      'weekly_reminder',
      { pattern: '0 9 * * 1', tz: 'Asia/Kolkata' },
      { name: 'weekly_reminder', data: {}, opts: { attempts: 1 } }
    );
  }

  async function process(job: Job): Promise<string | number> {
    if (job.name === 'weekly_reminder') return handleWeeklyReminder(deps);
    return handleAppVoice(job.data as AppVoiceJob, deps);
  }

  function startWorker() {
    const worker = new Worker(name, process, {
      connection: connection as any,
      concurrency: 1,
      limiter: opts.limiter ?? { max: 12, duration: 60_000 },
    });

    worker.on('completed', (job, outcome) => log(`🏁 job ${job.id} → ${outcome}`));

    worker.on('failed', async (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1) || err.name === 'UnrecoverableError';
      log(`🚨 job ${job.id} attempt ${job.attemptsMade} failed: ${err.message}${final ? ' (giving up)' : ''}`);
      if (final && job.name === 'app_voice') {
        await markAppVoiceFailed(job.data.uploadId).catch((e) => log(`could not mark upload failed: ${e.message}`));
      }
    });

    return worker;
  }

  async function close() {
    await queue.close();
    if (!opts.connection) await connection.quit();
  }

  return { queue, enqueueAppVoice, scheduleWeeklyReminder, startWorker, close };
}
