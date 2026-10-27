import * as SecureStore from 'expo-secure-store';

/** Small key/value storage. On the phone: Android Keystore-backed secure storage. */
export const storage = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  remove: (key: string) => SecureStore.deleteItemAsync(key),
};
