interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

/**
 * A random id that matches the protocol's id pattern.
 *
 * Uses `crypto.randomUUID` where it exists. React Native without a crypto
 * polyfill has neither it nor `getRandomValues`, so there is a non-secure
 * fallback; ids are for correlation and idempotency, never for secrecy.
 */
export function randomId(): string {
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
