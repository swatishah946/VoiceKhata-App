import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { cacheGet, cacheSet } from './recordings-db';

/**
 * Server data with an offline copy: every successful response is saved on the
 * phone, and when there is no network the last saved copy is shown (with its
 * time), so he can still see who owes what in a no-signal area.
 */
export interface Cached<T> {
  data: T;
  offlineSince: string | null;
}

export function useCachedQuery<T>(key: string, path: string, enabled = true) {
  return useQuery<Cached<T>, Error>({
    queryKey: [key],
    enabled,
    queryFn: async () => {
      try {
        const data = await api<T>(path);
        await cacheSet(key, data);
        return { data, offlineSince: null };
      } catch (err) {
        if (err instanceof ApiError && (err.isOffline || err.status >= 500)) {
          const cached = await cacheGet<T>(key);
          if (cached) return { data: cached.value, offlineSince: cached.savedAt };
        }
        throw err;
      }
    },
  });
}
