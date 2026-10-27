import { api, ApiError, setAuthToken, setUnauthorizedHandler } from '../api';

const mockFetch = (impl: () => Promise<Partial<Response>>) => {
  (globalThis as any).fetch = jest.fn(impl);
  return (globalThis as any).fetch as jest.Mock;
};
const json = (status: number, body: unknown) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

afterEach(() => setAuthToken(null));

describe('api client', () => {
  it('sends the token and JSON body, returns parsed JSON', async () => {
    const f = mockFetch(json(200, { ok: true }));
    setAuthToken('abc');
    await expect(api('/app/entries/x/save', { method: 'POST', body: { edits: {} } })).resolves.toEqual({ ok: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/\/api\/app\/entries\/x\/save$/);
    expect(init.headers.Authorization).toBe('Bearer abc');
    expect(init.body).toBe('{"edits":{}}');
  });

  it('no network → ApiError with status 0 (shown as "No internet")', async () => {
    mockFetch(async () => {
      throw new TypeError('Network request failed');
    });
    const err: any = await api('/parties').catch((e: any) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isOffline).toBe(true);
  });

  it('server errors carry the message and body (e.g. which fields are missing)', async () => {
    mockFetch(json(422, { error: 'Missing or invalid details', missing: ['rate'] }));
    const err: any = await api('/x').catch((e: any) => e);
    expect(err).toMatchObject({ status: 422, message: 'Missing or invalid details', body: { missing: ['rate'] } });
  });

  it('a 401 while logged in triggers logout', async () => {
    const onUnauthorized = jest.fn();
    setUnauthorizedHandler(onUnauthorized);
    setAuthToken('expired');
    mockFetch(json(401, { error: 'Unauthorized' }));
    await expect(api('/app/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalled();
  });
});
