import type { LocalStatus, Recording, RecordingStore } from './recordings';
import type { UploadView } from './types';

/**
 * Offline sync engine. Pure logic with every side effect injected, so it is
 * unit-tested without a phone:
 *   1. upload recordings that are still on the phone ("waiting");
 *   2. ask the server how each uploaded one is doing and update the local copy.
 */

export interface SyncDeps {
  store: RecordingStore;
  /** POST the audio file; resolves with the HTTP status and body, throws if the network fails */
  uploadFile(r: Recording): Promise<{ status: number; body: string }>;
  /** GET /api/app/voice */
  fetchUploads(): Promise<UploadView[]>;
  deleteFile(uri: string): void;
  isOnline(): Promise<boolean>;
  onUnauthorized(): void;
}

export interface SyncResult {
  uploaded: number;
  stoppedBy: null | 'offline' | 'server' | 'unauthorized';
  refreshed: boolean;
}

/** Server state → what the phone shows. A saved/cancelled entry is final. */
export function localStatusFor(v: UploadView): LocalStatus {
  switch (v.status) {
    case 'queued':
      return 'processing';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
    case 'ready':
      if (v.entry?.status === 'confirmed') return 'saved';
      if (v.entry?.status === 'cancelled') return 'cancelled';
      return 'ready';
  }
}

const FINAL: LocalStatus[] = ['ready', 'rejected', 'saved', 'cancelled'];

export async function uploadWaiting(deps: SyncDeps): Promise<Pick<SyncResult, 'uploaded' | 'stoppedBy'>> {
  let uploaded = 0;
  const waiting = (await deps.store.list()).filter((r) => r.status === 'waiting').reverse(); // oldest first
  for (const r of waiting) {
    if (!r.fileUri) {
      await deps.store.update(r.id, { status: 'rejected', reason: 'no_audio' });
      continue;
    }
    let res: { status: number; body: string };
    try {
      res = await deps.uploadFile(r);
    } catch {
      await deps.store.update(r.id, { attempts: r.attempts + 1, lastError: 'offline' });
      return { uploaded, stoppedBy: 'offline' };
    }

    if (res.status === 200 || res.status === 202) {
      let uploadId: string | null = null;
      try {
        uploadId = JSON.parse(res.body).uploadId ?? null;
      } catch {
        /* status is fetched again by refresh */
      }
      await deps.store.update(r.id, { status: 'processing', uploadId, attempts: r.attempts + 1, lastError: null });
      uploaded++;
    } else if (res.status === 401) {
      deps.onUnauthorized();
      return { uploaded, stoppedBy: 'unauthorized' };
    } else if (res.status === 413 || res.status === 400) {
      // Will never succeed: too long / broken recording
      await deps.store.update(r.id, { status: 'rejected', reason: res.status === 413 ? 'too_long' : 'bad_audio' });
      deps.deleteFile(r.fileUri);
      await deps.store.update(r.id, { fileUri: null });
    } else {
      // 5xx / 503 (server busy or waking up): keep it and try on the next sync
      await deps.store.update(r.id, { attempts: r.attempts + 1, lastError: `server ${res.status}` });
      return { uploaded, stoppedBy: 'server' };
    }
  }
  return { uploaded, stoppedBy: null };
}

export async function refreshStatuses(deps: SyncDeps): Promise<number> {
  const local = await deps.store.list();
  const open = local.filter((r) => r.status !== 'saved' && r.status !== 'cancelled');
  if (!open.length) return 0;
  const views = await deps.fetchUploads();
  const byClientId = new Map(views.map((v) => [v.clientEntryId, v]));
  let changed = 0;
  for (const r of open) {
    const v = byClientId.get(r.id);
    if (!v) continue;
    const status = localStatusFor(v);
    const patch = {
      status,
      uploadId: v.uploadId,
      transactionId: v.entry?.id ?? null,
      reason: v.reason,
      missing: v.missing ?? [],
      transcript: v.transcript,
    };
    if (status !== r.status || patch.transactionId !== r.transactionId || patch.transcript !== r.transcript) changed++;
    // The server has the audio (or its transcript) now; free the phone's storage
    if (FINAL.includes(status) && r.fileUri) {
      deps.deleteFile(r.fileUri);
      await deps.store.update(r.id, { ...patch, fileUri: null });
    } else {
      await deps.store.update(r.id, patch);
    }
  }
  return changed;
}

export async function syncNow(deps: SyncDeps): Promise<SyncResult> {
  if (!(await deps.isOnline())) return { uploaded: 0, stoppedBy: 'offline', refreshed: false };
  const up = await uploadWaiting(deps);
  if (up.stoppedBy === 'unauthorized' || up.stoppedBy === 'offline') return { ...up, refreshed: false };
  try {
    await refreshStatuses(deps);
    return { ...up, refreshed: true };
  } catch {
    return { ...up, refreshed: false };
  }
}

/** Keep checking while the server is still working on something. */
export function shouldPoll(list: Recording[]): boolean {
  return list.some((r) => r.status === 'processing');
}

/** "Try again" on a failed one: back to waiting so the next sync re-sends it. */
export async function retryRecording(store: RecordingStore, id: string): Promise<boolean> {
  const r = await store.get(id);
  if (!r || r.status !== 'failed' || !r.fileUri) return false;
  await store.update(id, { status: 'waiting', reason: null, lastError: null });
  return true;
}
