import { MemoryRecordingStore, type Recording } from '../recordings';
import { localStatusFor, refreshStatuses, retryRecording, shouldPoll, syncNow, uploadWaiting, type SyncDeps } from '../sync';
import type { UploadView } from '../types';

/** Fake server + fake files: the offline sync logic without a phone. */
function setup() {
  const store = new MemoryRecordingStore();
  const server = new Map<string, UploadView>(); // clientEntryId → server view
  const deleted: string[] = [];
  let online = true;
  let failNetwork = false;
  let nextStatus: number | null = null;
  const uploads: string[] = [];
  const onUnauthorized = jest.fn();

  const deps: SyncDeps = {
    store,
    async uploadFile(r) {
      if (failNetwork) throw new Error('Network request failed');
      uploads.push(r.id);
      if (nextStatus) return { status: nextStatus, body: '{}' };
      const existing = server.get(r.id);
      const view: UploadView = existing ?? {
        uploadId: `up-${r.id}`, clientEntryId: r.id, status: 'queued', reason: null, missing: [], transcript: null, createdAt: '',
      };
      server.set(r.id, view);
      return { status: existing ? 200 : 202, body: JSON.stringify({ uploadId: view.uploadId, status: view.status }) };
    },
    async fetchUploads() {
      return [...server.values()];
    },
    deleteFile: (uri) => void deleted.push(uri),
    isOnline: async () => online,
    onUnauthorized,
  };

  async function record(id: string, at: string) {
    await store.add({ id, fileUri: `file:///rec/${id}.m4a`, recordedAt: at, durationSec: 7 });
  }
  return {
    store, server, deleted, uploads, deps, record, onUnauthorized,
    setOnline: (v: boolean) => (online = v),
    setNetworkFails: (v: boolean) => (failNetwork = v),
    setNextStatus: (s: number | null) => (nextStatus = s),
  };
}

const ready = (v: UploadView, entryStatus: string = 'pending_confirmation'): UploadView => ({
  ...v, status: 'ready', transcript: 'Ramesh se 5000 aaya', entry: { id: `tx-${v.clientEntryId}`, status: entryStatus } as any,
});

describe('offline sync', () => {
  it('offline: keeps recordings on the phone and does nothing', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    s.setOnline(false);
    expect(await syncNow(s.deps)).toMatchObject({ uploaded: 0, stoppedBy: 'offline' });
    expect((await s.store.get('a'))!.status).toBe('waiting');
    expect(s.uploads).toEqual([]);
  });

  it('back online: uploads oldest first and marks them processing', async () => {
    const s = setup();
    await s.record('new', '2026-10-27T10:05:00Z');
    await s.record('old', '2026-10-27T10:00:00Z');
    const r = await syncNow(s.deps);
    expect(r).toMatchObject({ uploaded: 2, stoppedBy: null, refreshed: true });
    expect(s.uploads).toEqual(['old', 'new']);
    expect(await s.store.get('old')).toMatchObject({ status: 'processing', uploadId: 'up-old', attempts: 1 });
  });

  it('network drops mid-upload: stops, keeps the rest waiting, records the attempt', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    s.setNetworkFails(true);
    expect((await uploadWaiting(s.deps)).stoppedBy).toBe('offline');
    expect(await s.store.get('a')).toMatchObject({ status: 'waiting', attempts: 1, lastError: 'offline' });
  });

  it('upload succeeded but the reply was lost: the retry reuses the same id → still one entry on the server', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    await uploadWaiting(s.deps); // server saved it…
    await s.store.update('a', { status: 'waiting' }); // …but the phone never heard back
    await uploadWaiting(s.deps);
    expect(s.uploads).toEqual(['a', 'a']);
    expect(s.server.size).toBe(1);
  });

  it('server busy (503): keeps the recording and tries next time', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    s.setNextStatus(503);
    expect((await uploadWaiting(s.deps)).stoppedBy).toBe('server');
    expect(await s.store.get('a')).toMatchObject({ status: 'waiting', lastError: 'server 503' });
    expect(s.deleted).toEqual([]);
  });

  it('logged out on the server (401): stops and logs out', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    s.setNextStatus(401);
    expect((await syncNow(s.deps)).stoppedBy).toBe('unauthorized');
    expect(s.onUnauthorized).toHaveBeenCalled();
  });

  it('too long (413): marked rejected and the file is freed (it can never succeed)', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    s.setNextStatus(413);
    await uploadWaiting(s.deps);
    expect(await s.store.get('a')).toMatchObject({ status: 'rejected', reason: 'too_long', fileUri: null });
    expect(s.deleted).toEqual(['file:///rec/a.m4a']);
  });

  it('server finished: draft ready → shown for review, transcript copied, audio freed from the phone', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    await syncNow(s.deps);
    s.server.set('a', ready(s.server.get('a')!));
    await refreshStatuses(s.deps);
    expect(await s.store.get('a')).toMatchObject({
      status: 'ready', transactionId: 'tx-a', transcript: 'Ramesh se 5000 aaya', fileUri: null,
    });
    expect(s.deleted).toEqual(['file:///rec/a.m4a']);
  });

  it('server gave up (failed): audio is kept so "Try again" can resend it', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    await syncNow(s.deps);
    s.server.set('a', { ...s.server.get('a')!, status: 'failed', reason: 'server_error' });
    await refreshStatuses(s.deps);
    expect(await s.store.get('a')).toMatchObject({ status: 'failed', fileUri: 'file:///rec/a.m4a' });

    expect(await retryRecording(s.store, 'a')).toBe(true);
    s.server.set('a', { ...s.server.get('a')!, status: 'queued' });
    await uploadWaiting(s.deps);
    expect((await s.store.get('a'))!.status).toBe('processing');
  });

  it('saved elsewhere (dashboard / WhatsApp) → shown as saved; saved ones are never touched again', async () => {
    const s = setup();
    await s.record('a', '2026-10-27T10:00:00Z');
    await syncNow(s.deps);
    s.server.set('a', ready(s.server.get('a')!, 'confirmed'));
    await refreshStatuses(s.deps);
    expect((await s.store.get('a'))!.status).toBe('saved');
    s.server.set('a', ready(s.server.get('a')!, 'pending_confirmation'));
    await refreshStatuses(s.deps);
    expect((await s.store.get('a'))!.status).toBe('saved');
  });

  it('maps every server status', () => {
    const base = { uploadId: 'u', clientEntryId: 'c', reason: null, missing: [], transcript: null, createdAt: '' };
    expect(localStatusFor({ ...base, status: 'queued' })).toBe('processing');
    expect(localStatusFor({ ...base, status: 'rejected' })).toBe('rejected');
    expect(localStatusFor({ ...base, status: 'failed' })).toBe('failed');
    expect(localStatusFor(ready({ ...base, status: 'queued' }, 'cancelled'))).toBe('cancelled');
  });

  it('polls only while the server is still working', () => {
    const r = (status: Recording['status']) => ({ status }) as Recording;
    expect(shouldPoll([r('ready'), r('processing')])).toBe(true);
    expect(shouldPoll([r('ready'), r('waiting'), r('saved')])).toBe(false);
  });
});
