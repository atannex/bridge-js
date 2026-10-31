import type { BridgeError } from '../errors/errors.js';
import type { TransportRequest, TransportResponse } from '../transport/types.js';

/** A request sent by an auth adapter outside the operation protocol (CSRF cookie, login, logout). */
export interface HostRequest {
  method: 'GET' | 'POST';
  /** A path relative to the Bridge `baseURL`, or an absolute URL on the same origin. */
  path: string;
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Run the adapter's `prepare` on this request. Default true. */
  auth?: boolean;
  signal?: AbortSignal;
}

export interface HostResponse {
  status: number;
  headers: Headers;
  /** The parsed JSON body, or undefined when empty / not JSON. */
  body: unknown;
}

/** What a Bridge client gives the auth adapter attached to it. */
export interface AuthHost {
  /**
   * Sends a request with the client's base URL, headers, transport and timeout.
   * Rejects with a `BridgeError` for statuses >= 400 and for network failures.
   */
  send(request: HostRequest): Promise<HostResponse>;
  /** `path` under the client's route prefix, for example `prefixed('auth/user')` → `/bridge/v1/auth/user`. */
  prefixed(path: string): string;
}

/**
 * Adds credentials to requests and reacts to authentication failures.
 *
 * An adapter instance belongs to one client: pass it as `auth` to
 * `createBridge`, which calls `attach` once.
 */
export interface AuthAdapter {
  attach?(host: AuthHost): void;
  /** Adds headers or credentials to an outgoing request. Runs after request interceptors. */
  prepare(request: TransportRequest): void | Promise<void>;
  /** Sees every response, for example to store cookies. */
  handleResponse?(response: TransportResponse, request: TransportRequest): void | Promise<void>;
  /** Called when an operation call came back 401. */
  onUnauthenticated?(error: BridgeError, request: TransportRequest): void | Promise<void>;
  /** Called on 419. Resolve true to have the client replay the request once. */
  recover?(error: BridgeError, request: TransportRequest): Promise<boolean>;
}

/**
 * Async key-value storage for secrets. Use a secure store on mobile
 * (`expoSecureStore` from `@atannex/bridge/expo`), never plain AsyncStorage.
 */
export interface TokenStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** In-memory storage. Tokens are gone when the process ends; fine for tests, servers and short-lived scripts. */
export function memoryStorage(initial: Record<string, string> = {}): TokenStorage {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}
