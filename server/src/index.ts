import { config } from './config';
import { createApp } from './app';
import pool from './db';
import { createJobQueue } from './queue';

/**
 * Entry point: HTTP server + queue worker in one process (fits a single small server).
 * config is imported first, so a missing secret stops startup with a clear error.
 */
const jobs = createJobQueue();
const app = createApp({ enqueueAppVoice: jobs.enqueueAppVoice });
const server = app.listen(config.PORT, () => {
  console.log(`🚀 VoiceKhata App server listening on port ${config.PORT}`);
});
const worker = jobs.startWorker();
jobs.scheduleWeeklyReminder().catch((err) => console.warn(`⚠️ could not schedule weekly reminder: ${err.message}`));

// Graceful shutdown: Render sends SIGTERM on every deploy. Finish the current
// job and close connections instead of being killed mid-transaction.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down…`);
  server.close();
  await worker.close().catch(() => undefined);
  await jobs.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
