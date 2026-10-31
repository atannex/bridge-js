import { webcrypto } from 'node:crypto';
import { describe } from 'vitest';
import {
  bearerToken,
  createBridge,
  memoryStorage,
  type BearerTokenAuth,
  type Bridge,
  type TokenStorage,
} from '@atannex/bridge';
import { operations, type AppBridge } from './contract.generated.js';

/** Base URL of the running example Laravel app, e.g. http://127.0.0.1:8123. Tests skip without it. */
export const baseURL = process.env['BRIDGE_TEST_URL'];

export const describeLive = baseURL === undefined || baseURL === '' ? describe.skip : describe;

export const PASSWORD = 'password';

export interface TokenClient {
  bridge: Bridge<AppBridge>;
  auth: BearerTokenAuth;
  storage: TokenStorage;
}

export function tokenClient(): TokenClient {
  const storage = memoryStorage();
  const auth = bearerToken({ storage, deviceName: 'vitest' });
  const bridge = createBridge<AppBridge>({ baseURL: baseURL ?? '', operations, auth, client: 'bridge-js-tests/0.1.0' });
  return { bridge, auth, storage };
}

export async function signedIn(email: string): Promise<TokenClient> {
  const client = tokenClient();
  const result = await client.auth.login({ email, password: PASSWORD });
  if (result.status !== 'authenticated') throw new Error(`${email} needs a second factor`);
  return client;
}

/** Empties the user's cart so tests start from a known state. */
export async function emptyCart(bridge: Bridge<AppBridge>): Promise<void> {
  const cart = await bridge.call('cart.show');
  for (const item of cart.items) await bridge.call('cart.remove', { product_id: item.product_id });
}

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('bad base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), on Web Crypto. `step` shifts the time window. */
export async function totp(secret: string, step = 0, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / 1000 / 30) + step;
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await webcrypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const hmac = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, message));
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

/** A 1x1 transparent PNG. */
export const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
