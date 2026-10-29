import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import pool from './db';
import apiRoutes from './routes/api.routes';
import { createAppRouter } from './routes/app.routes';
import type { AppVoiceJob } from './workers/app-handlers';

/**
 * Builds the Express app. Kept separate from index.ts (which starts the server
 * and the queue worker) so tests can create an app with a fake queue and call
 * it with supertest — no network, no Redis.
 */
export function createApp(deps: { enqueueAppVoice: (job: AppVoiceJob) => Promise<void> }) {
  const app = express();

  app.set('trust proxy', 1); // Render puts one proxy in front; needed for correct client IPs in rate limiting
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    })
  );
  if (!config.isTest) app.use(morgan(config.isProduction ? 'tiny' : 'dev'));

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'OK', db: 'up', timestamp: new Date() });
    } catch {
      res.status(503).json({ status: 'DEGRADED', db: 'down', timestamp: new Date() });
    }
  });

  // Mounted before the JSON parser: the voice upload route reads the raw audio body itself
  app.use('/api/app', createAppRouter(deps.enqueueAppVoice));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', apiRoutes);

  app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));

  // Never leak stack traces or SQL errors to the client
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('❌ unhandled error:', err?.message || err);
    if (res.headersSent) return;
    res.status(err?.status && err.status < 500 ? err.status : 500).json({ error: 'Server error' });
  });

  return app;
}
