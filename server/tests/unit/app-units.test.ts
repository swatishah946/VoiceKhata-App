import { describe, expect, it, vi } from 'vitest';
import { bucketFor } from '../../src/services/reports.service';
import { isExpoPushToken, sendPush } from '../../src/services/push.service';

describe('ageing buckets', () => {
  it('puts days into 0-30 / 31-60 / 61-90 / 90+', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(bucketFor)).toEqual(['0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '90+', '90+']);
  });
});

describe('push notifications', () => {
  it('accepts only Expo push tokens', () => {
    expect(isExpoPushToken('ExponentPushToken[abc_DEF-123]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    for (const bad of ['', 'http://x', 'ExponentPushToken[]', 'ExponentPushToken[a b]', 42, null]) {
      expect(isExpoPushToken(bad)).toBe(false);
    }
  });

  it('sends one request with every valid token, and skips the call when there are none', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await sendPush(['ExponentPushToken[a]', 'junk', 'ExponentPushToken[b]'], { title: 't', body: 'b' }, fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body.map((m: any) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);

    fetchImpl.mockClear();
    await sendPush(['junk'], { title: 't', body: 'b' }, fetchImpl as any);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a failing push service never throws (a missed notification must not fail a job)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sendPush(['ExponentPushToken[a]'], { title: 't', body: 'b' }, (async () => { throw new Error('down'); }) as any)).resolves.toBeUndefined();
    await expect(sendPush(['ExponentPushToken[a]'], { title: 't', body: 'b' }, (async () => new Response('', { status: 500 })) as any)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
