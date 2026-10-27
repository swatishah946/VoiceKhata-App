import * as SecureStore from 'expo-secure-store';

/** Small per-phone settings. */
const UPI_KEY = 'vk.upi';

export async function getUpiId(): Promise<string | null> {
  return SecureStore.getItemAsync(UPI_KEY);
}
export async function setUpiId(id: string | null) {
  if (id) await SecureStore.setItemAsync(UPI_KEY, id.trim());
  else await SecureStore.deleteItemAsync(UPI_KEY);
}
