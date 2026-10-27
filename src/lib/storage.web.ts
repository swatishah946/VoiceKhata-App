/** Web preview build: the browser's localStorage (secure storage is phone-only). */
export const storage = {
  get: async (key: string) => globalThis.localStorage?.getItem(key) ?? null,
  set: async (key: string, value: string) => void globalThis.localStorage?.setItem(key, value),
  remove: async (key: string) => void globalThis.localStorage?.removeItem(key),
};
