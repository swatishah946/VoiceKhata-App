/**
 * Voice entries recorded on this phone, kept in a local database so nothing is
 * lost without network. Each one has an id made on the phone (a UUID), which
 * is sent as X-Client-Entry-Id: if an upload is retried, the server recognises
 * it and never creates a second entry.
 */

export type LocalStatus =
  | 'waiting' // recorded, not uploaded yet (e.g. no network)
  | 'processing' // uploaded; server is transcribing / understanding it
  | 'ready' // draft ready to review
  | 'rejected' // server could not make an entry from it
  | 'failed' // server gave up after retries; can be tried again
  | 'saved' // confirmed into the khata
  | 'cancelled';

export interface Recording {
  id: string;
  fileUri: string | null;
  recordedAt: string;
  durationSec: number;
  status: LocalStatus;
  uploadId: string | null;
  transactionId: string | null;
  reason: string | null;
  missing: string[];
  transcript: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export type RecordingPatch = Partial<Omit<Recording, 'id' | 'recordedAt'>>;

export interface RecordingStore {
  add(r: Pick<Recording, 'id' | 'fileUri' | 'recordedAt' | 'durationSec'>): Promise<void>;
  /** Newest first */
  list(): Promise<Recording[]>;
  get(id: string): Promise<Recording | null>;
  update(id: string, patch: RecordingPatch): Promise<void>;
  remove(id: string): Promise<void>;
}

export const NEEDS_ACTION: LocalStatus[] = ['ready', 'rejected', 'failed'];
export const IN_PROGRESS: LocalStatus[] = ['waiting', 'processing'];

export function newRecording(
  r: Pick<Recording, 'id' | 'fileUri' | 'recordedAt' | 'durationSec'>,
  now = new Date()
): Recording {
  return {
    ...r,
    status: 'waiting',
    uploadId: null,
    transactionId: null,
    reason: null,
    missing: [],
    transcript: null,
    attempts: 0,
    lastError: null,
    updatedAt: now.toISOString(),
  };
}

/** In-memory store (used by tests; the app uses the SQLite one). */
export class MemoryRecordingStore implements RecordingStore {
  private rows = new Map<string, Recording>();
  async add(r: Pick<Recording, 'id' | 'fileUri' | 'recordedAt' | 'durationSec'>) {
    if (!this.rows.has(r.id)) this.rows.set(r.id, newRecording(r));
  }
  async list() {
    return [...this.rows.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async update(id: string, patch: RecordingPatch) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, ...patch, updatedAt: new Date().toISOString() });
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
}
