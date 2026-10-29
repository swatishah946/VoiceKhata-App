import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

/** The server must refuse to start with missing or weak secrets (no public fallbacks). */
const good = {
  DATABASE_URL: 'postgres://u:p@db/x',
  JWT_SECRET: 'x'.repeat(48),
};

describe('startup configuration', () => {
  it('accepts a complete production environment with safe defaults', () => {
    const c = loadConfig({ ...good, NODE_ENV: 'production' });
    expect(c.isProduction).toBe(true);
    expect(c.PORT).toBe(3000);
    expect(c.AI_MIN_CONFIDENCE).toBe(0.6);
    expect(c.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
  });

  it.each([
    ['DATABASE_URL missing', { DATABASE_URL: undefined }, /DATABASE_URL/],
    ['JWT_SECRET missing', { JWT_SECRET: undefined }, /JWT_SECRET/],
    ['JWT_SECRET too short', { JWT_SECRET: 'super_secret_voicekhata_key' }, /at least 32/],
    ['confidence outside 0..1', { AI_MIN_CONFIDENCE: '1.5' }, /AI_MIN_CONFIDENCE/],
    ['DEFAULT_ORG_ID not a UUID', { DEFAULT_ORG_ID: 'abc' }, /DEFAULT_ORG_ID/],
  ])('refuses to start: %s', (_name, override, message) => {
    expect(() => loadConfig({ ...good, ...override })).toThrow(message);
  });

  it('parses the CORS allow-list', () => {
    const c = loadConfig({ ...good, CORS_ORIGINS: 'https://a.app, https://b.app ,' });
    expect(c.corsOrigins).toEqual(['https://a.app', 'https://b.app']);
  });

  it('test mode never uses DATABASE_URL (so tests cannot touch production data)', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://PRODUCTION/db', TEST_DATABASE_URL: 'postgres://h/voicekhata_test' }, true);
    expect(c.DATABASE_URL).toBe('postgres://h/voicekhata_test');
  });
});
