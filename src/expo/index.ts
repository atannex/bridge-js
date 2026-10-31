/**
 * Expo SecureStore adapter for `bearerToken`.
 *
 * ```ts
 * import * as SecureStore from 'expo-secure-store';
 * import { bearerToken } from '@atannex/bridge';
 * import { expoSecureStore } from '@atannex/bridge/expo';
 *
 * const auth = bearerToken({ storage: expoSecureStore(SecureStore) });
 * ```
 *
 * @packageDocumentation
 */
import type { TokenStorage } from '../authentication/types.js';

/** The parts of `expo-secure-store` this adapter uses. */
export interface SecureStoreModule<Options = unknown> {
  getItemAsync(key: string, options?: Options): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: Options): Promise<void>;
  deleteItemAsync(key: string, options?: Options): Promise<void>;
}

/**
 * Wraps `expo-secure-store` (Keychain on iOS, Keystore-backed storage on
 * Android). `options` are passed to every call, e.g.
 * `{ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }`.
 */
export function expoSecureStore<Options>(module: SecureStoreModule<Options>, options?: Options): TokenStorage {
  return {
    getItem: (key) => module.getItemAsync(key, options),
    setItem: (key, value) => module.setItemAsync(key, value, options),
    removeItem: (key) => module.deleteItemAsync(key, options),
  };
}
