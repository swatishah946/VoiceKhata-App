import { storage } from './storage';

/** Small per-phone settings. */
const UPI_KEY = 'vk.upi';

export async function getUpiId(): Promise<string | null> {
  return storage.get(UPI_KEY);
}
export async function setUpiId(id: string | null) {
  if (id) await storage.set(UPI_KEY, id.trim());
  else await storage.remove(UPI_KEY);
}
