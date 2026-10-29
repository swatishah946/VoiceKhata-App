import pool from '../db';

/**
 * Push notifications to the Android app through Expo's free push service.
 * The app sends its Expo push token after login; it is stored on the member.
 * Failures are logged and ignored: a missed notification must never fail a job.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && token.length <= 255 && TOKEN_RE.test(token);
}

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendPush(tokens: string[], msg: PushMessage, fetchImpl: typeof fetch = fetch): Promise<void> {
  const valid = tokens.filter(isExpoPushToken);
  if (!valid.length) return;
  try {
    const res = await fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(valid.map((to) => ({ to, sound: 'default', ...msg }))),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`⚠️ push failed [${res.status}]`);
  } catch (err) {
    console.warn(`⚠️ push failed: ${(err as Error).message}`);
  }
}

export async function pushToMember(orgId: string, phone: string, msg: PushMessage, fetchImpl: typeof fetch = fetch) {
  const r = await pool.query(
    `SELECT push_token FROM organization_members WHERE organization_id = $1 AND phone = $2 AND push_token IS NOT NULL`,
    [orgId, phone]
  );
  await sendPush(r.rows.map((x) => x.push_token), msg, fetchImpl);
}

export async function pushToOrgOwners(orgId: string, msg: PushMessage, fetchImpl: typeof fetch = fetch) {
  const r = await pool.query(
    `SELECT push_token FROM organization_members
      WHERE organization_id = $1 AND role = 'owner' AND is_active = TRUE AND push_token IS NOT NULL`,
    [orgId]
  );
  await sendPush(r.rows.map((x) => x.push_token), msg, fetchImpl);
}

export const PushService = { pushToMember, pushToOrgOwners };
