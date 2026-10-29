import dotenv from 'dotenv';
import { z } from 'zod';

const isTest = process.env.NODE_ENV === 'test';

// Never load .env during tests: it may point at the real (production) database.
if (!isTest) dotenv.config({ quiet: true });

/**
 * All environment configuration, validated once at startup. A missing or weak
 * secret stops the server with a clear message instead of running with a
 * default that anyone could read on GitHub.
 */

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().default(6380),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters (use a random string)'),
  JWT_EXPIRES_IN: z.string().default('30d'), // he logs in once per phone

  // Which business the setup scripts use (single-owner setup)
  DEFAULT_ORG_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000000'),

  // AI
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.6-flash'),
  GROQ_API_KEY: z.string().optional(),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  PRICE_VARIANCE_WARN_PCT: z.coerce.number().min(0).default(10),

  // Browser origins allowed to call the API (only the web preview needs this; the phone app sends no Origin)
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
});

const testDefaults: Record<string, string> = {
  DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/voicekhata_test',
  JWT_SECRET: 'test_secret_that_is_long_enough_for_hs256_signing',
  GEMINI_API_KEY: 'test_gemini_key',
  GROQ_API_KEY: 'test_groq_key',
};

/** Validates an environment. Exported so the fail-fast rules can be unit tested. */
export function loadConfig(env: NodeJS.ProcessEnv, testMode = false) {
  // Tests only ever use TEST_DATABASE_URL, so they can never touch real data.
  const raw = testMode
    ? { ...env, ...testDefaults, DATABASE_URL: env.TEST_DATABASE_URL || testDefaults.DATABASE_URL }
    : env;
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`❌ Invalid environment configuration:\n${problems}\nSee server/.env.example`);
  }

  const cfg = parsed.data;
  return {
    ...cfg,
    corsOrigins: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: cfg.NODE_ENV === 'production',
    isTest: testMode,
  };
}

export const config = loadConfig(process.env, isTest);
export type AppConfig = typeof config;
