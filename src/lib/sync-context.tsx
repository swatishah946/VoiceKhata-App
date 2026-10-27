import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { File, Paths, Directory, UploadType } from 'expo-file-system';
import { api, apiUrl, authHeaders } from './api';
import { sqliteRecordingStore as store } from './recordings-db';
import type { Recording } from './recordings';
import { retryRecording, shouldPoll, syncNow, type SyncDeps } from './sync';
import type { UploadView } from './types';
import { useAuth } from './auth';

/**
 * Keeps the phone's recordings in step with the server:
 * sync when the app opens, when the network comes back, right after a
 * recording, and every few seconds while the server is still working on one.
 */

interface SyncState {
  recordings: Recording[];
  online: boolean;
  syncing: boolean;
  addRecording(tempUri: string, durationSec: number, id: string): Promise<void>;
  sync(): Promise<void>;
  retry(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  markDone(id: string, status: 'saved' | 'cancelled'): Promise<void>;
}

const Ctx = createContext<SyncState | null>(null);
const POLL_MS = 4000;

function recordingsDir() {
  const dir = new Directory(Paths.document, 'recordings');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function isOnline(state: { isConnected: boolean | null; isInternetReachable: boolean | null }) {
  return Boolean(state.isConnected) && state.isInternetReachable !== false;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const running = useRef(false);

  const reload = useCallback(async () => setRecordings(await store.list()), []);

  const deps = useMemo<SyncDeps>(
    () => ({
      store,
      async uploadFile(r) {
        const res = await new File(r.fileUri!).upload(apiUrl('/app/voice'), {
          httpMethod: 'POST',
          uploadType: UploadType.BINARY_CONTENT,
          headers: {
            ...authHeaders(),
            'Content-Type': 'audio/m4a',
            'X-Client-Entry-Id': r.id,
            'X-Recorded-At': r.recordedAt,
          },
        });
        return { status: res.status, body: res.body };
      },
      fetchUploads: () => api<UploadView[]>('/app/voice'),
      deleteFile(uri) {
        try {
          const f = new File(uri);
          if (f.exists) f.delete();
        } catch {
          /* already gone */
        }
      },
      isOnline: async () => isOnline(await NetInfo.fetch()),
      onUnauthorized: () => void logout(),
    }),
    [logout]
  );

  const sync = useCallback(async () => {
    if (!session || running.current) return;
    running.current = true;
    setSyncing(true);
    try {
      await syncNow(deps);
    } finally {
      running.current = false;
      setSyncing(false);
      await reload();
    }
  }, [deps, reload, session]);

  // Load local list; sync on login / app open
  useEffect(() => {
    void reload();
    if (session) void sync();
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Network comes back → send what was recorded offline
  useEffect(
    () =>
      NetInfo.addEventListener((state) => {
        const now = isOnline(state);
        setOnline((was) => {
          if (now && !was) void sync();
          return now;
        });
      }),
    [sync]
  );

  // App comes to the foreground → refresh
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void sync());
    return () => sub.remove();
  }, [sync]);

  // While the server is working on an entry, check every few seconds
  useEffect(() => {
    if (!shouldPoll(recordings)) return;
    const timer = setInterval(() => void sync(), POLL_MS);
    return () => clearInterval(timer);
  }, [recordings, sync]);

  const addRecording = useCallback(
    async (tempUri: string, durationSec: number, id: string) => {
      // Move out of the cache folder so Android can't delete it before it is uploaded
      const target = new File(recordingsDir(), `${id}.m4a`);
      new File(tempUri).moveSync(target);
      await store.add({ id, fileUri: target.uri, recordedAt: new Date().toISOString(), durationSec });
      await reload();
      void sync();
    },
    [reload, sync]
  );

  const retry = useCallback(
    async (id: string) => {
      await retryRecording(store, id);
      await reload();
      void sync();
    },
    [reload, sync]
  );

  const dismiss = useCallback(
    async (id: string) => {
      const r = await store.get(id);
      if (r?.fileUri) deps.deleteFile(r.fileUri);
      await store.remove(id);
      await reload();
    },
    [deps, reload]
  );

  const markDone = useCallback(
    async (id: string, status: 'saved' | 'cancelled') => {
      await store.update(id, { status });
      await reload();
    },
    [reload]
  );

  const value = useMemo(
    () => ({ recordings, online, syncing, addRecording, sync, retry, dismiss, markDone }),
    [recordings, online, syncing, addRecording, sync, retry, dismiss, markDone]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSync must be used inside SyncProvider');
  return v;
}
