import * as SQLite from 'expo-sqlite';
import { newRecording, type Recording, type RecordingPatch, type RecordingStore } from './recordings';

/** SQLite-backed store: survives app restarts and phone reboots. */

let db: SQLite.SQLiteDatabase | null = null;

function open() {
  if (db) return db;
  db = SQLite.openDatabaseSync('voicekhata.db');
  db.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );
  `);
  return db;
}

export const sqliteRecordingStore: RecordingStore = {
  async add(r) {
    const row = newRecording(r);
    await open().runAsync(
      'INSERT OR IGNORE INTO recordings (id, data, recorded_at) VALUES (?, ?, ?)',
      row.id, JSON.stringify(row), row.recordedAt
    );
  },
  async list() {
    const rows = await open().getAllAsync<{ data: string }>('SELECT data FROM recordings ORDER BY recorded_at DESC');
    return rows.map((r) => JSON.parse(r.data) as Recording);
  },
  async get(id) {
    const row = await open().getFirstAsync<{ data: string }>('SELECT data FROM recordings WHERE id = ?', id);
    return row ? (JSON.parse(row.data) as Recording) : null;
  },
  async update(id, patch: RecordingPatch) {
    const current = await this.get(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await open().runAsync('UPDATE recordings SET data = ? WHERE id = ?', JSON.stringify(next), id);
  },
  async remove(id) {
    await open().runAsync('DELETE FROM recordings WHERE id = ?', id);
  },
};

/** Last good copy of a server response, shown when the phone is offline. */
export async function cacheSet(key: string, value: unknown) {
  await open().runAsync(
    'INSERT OR REPLACE INTO cache (key, value, saved_at) VALUES (?, ?, ?)',
    key, JSON.stringify(value), new Date().toISOString()
  );
}

export async function cacheGet<T>(key: string): Promise<{ value: T; savedAt: string } | null> {
  const row = await open().getFirstAsync<{ value: string; saved_at: string }>(
    'SELECT value, saved_at FROM cache WHERE key = ?', key
  );
  return row ? { value: JSON.parse(row.value) as T, savedAt: row.saved_at } : null;
}

export async function cacheClear() {
  await open().runAsync('DELETE FROM cache');
}
