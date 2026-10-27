import { newRecording, type Recording, type RecordingPatch, type RecordingStore } from './recordings';

/**
 * Web preview build: recordings and the offline cache in localStorage
 * (the phone build uses SQLite, see recordings-db.ts).
 */
const REC_KEY = 'vk.recordings';
const ls = () => globalThis.localStorage;

function readAll(): Recording[] {
  try {
    return JSON.parse(ls()?.getItem(REC_KEY) || '[]');
  } catch {
    return [];
  }
}
function writeAll(rows: Recording[]) {
  ls()?.setItem(REC_KEY, JSON.stringify(rows));
}

export const sqliteRecordingStore: RecordingStore = {
  async add(r) {
    const rows = readAll();
    if (!rows.some((x) => x.id === r.id)) writeAll([...rows, newRecording(r)]);
  },
  async list() {
    return readAll().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  },
  async get(id) {
    return readAll().find((r) => r.id === id) ?? null;
  },
  async update(id, patch: RecordingPatch) {
    writeAll(readAll().map((r) => (r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r)));
  },
  async remove(id) {
    writeAll(readAll().filter((r) => r.id !== id));
  },
};

export async function cacheSet(key: string, value: unknown) {
  ls()?.setItem(`vk.cache.${key}`, JSON.stringify({ value, savedAt: new Date().toISOString() }));
}
export async function cacheGet<T>(key: string): Promise<{ value: T; savedAt: string } | null> {
  const raw = ls()?.getItem(`vk.cache.${key}`);
  return raw ? JSON.parse(raw) : null;
}
export async function cacheClear() {
  for (const k of Object.keys(ls() ?? {})) if (k.startsWith('vk.cache.')) ls()?.removeItem(k);
}
