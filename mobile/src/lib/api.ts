import { API_URL } from './config';

/**
 * Small fetch wrapper for the VoiceKhata backend.
 * status 0 means "could not reach the server" (offline, timeout).
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: any
  ) {
    super(message);
  }
  get isOffline() {
    return this.status === 0;
  }
}

let token: string | null = null;
let onUnauthorized: () => void = () => undefined;

export function setAuthToken(t: string | null) {
  token = t;
}
export function getAuthToken() {
  return token;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const apiUrl = (path: string) => `${API_URL}/api${path}`;

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const controller = new AbortController();
  // Render's free plan can take ~1 minute to wake up
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 70_000);
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  return data as T;
}
