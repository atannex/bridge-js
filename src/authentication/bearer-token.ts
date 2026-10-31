import { BridgeAuthenticationError, BridgeProtocolError } from '../errors/errors.js';
import type { TransportRequest } from '../transport/types.js';
import type { AuthAdapter, AuthHost, TokenStorage } from './types.js';

export interface BearerTokenOptions {
  /** Where the token is kept. Required: there is deliberately no insecure default. */
  storage: TokenStorage;
  /** Storage key. Default `atannex.bridge.token`. */
  key?: string;
  /** Default `<prefix>/auth/token`. */
  loginPath?: string;
  /** Default `<prefix>/auth/two-factor`. */
  twoFactorPath?: string;
  /** Default `<prefix>/auth/logout`. */
  logoutPath?: string;
  /** Default `<prefix>/auth/refresh`. */
  refreshPath?: string;
  /**
   * Seconds before the token expires at which the next request first swaps it
   * for a new one. Default 3 days. `0` turns automatic refresh off; `refresh()`
   * still works. Needs a server that reports `expires_at` (atannex/bridge 1.0+).
   */
  refreshBefore?: number;
  /** Default `<prefix>/auth/user`. */
  userPath?: string;
  /** Names this device's token on the server, e.g. "Collins's Pixel 8". Default `bridge-client`. */
  deviceName?: string;
  /** Called after a 401 cleared the stored token: the token was revoked or expired. */
  onSessionExpired?: () => void;
}

export interface TokenCredentials {
  email: string;
  password: string;
  device_name?: string;
}

export type TokenLoginResult<User> =
  | { status: 'authenticated'; user: User | null }
  | { status: 'two_factor_required'; challenge: string; expiresAt: string | undefined };

export type TwoFactorInput = { challenge: string; code: string } | { challenge: string; recovery_code: string };

export interface BearerTokenAuth<User = Record<string, unknown>> extends AuthAdapter {
  /** Exchanges credentials for a token. With two-factor auth on, resolves a challenge instead and stores nothing. */
  login(credentials: TokenCredentials): Promise<TokenLoginResult<User>>;
  /** Exchanges a challenge plus a TOTP or recovery code for a token. */
  completeTwoFactor(input: TwoFactorInput): Promise<User | null>;
  /**
   * Swaps the stored token for a new one with a fresh expiry; the old one is
   * revoked. Concurrent callers share one request. Rejects with
   * `BridgeAuthenticationError` (and forgets the token) when it had already
   * expired or been revoked: sign in again then.
   */
  refresh(): Promise<User | null>;
  /** When the stored token expires, if the server said; null for never or unknown. */
  expiresAt(): Promise<Date | null>;
  /** Revokes the token on the server, then always forgets it locally. */
  logout(): Promise<void>;
  /** The signed-in user, or null without a valid token. */
  user(): Promise<User | null>;
  isAuthenticated(): Promise<boolean>;
}

interface AuthenticatedPayload<User> {
  status: 'authenticated';
  token: string;
  expires_at?: string | null;
  user?: User;
}

/**
 * Bearer-token authentication for React Native, Expo and other non-browser clients.
 *
 * Tokens come from Bridge's token endpoint (Sanctum personal access tokens,
 * issued only after the password and any second factor check out) and live in
 * the storage you pass — use `expoSecureStore` on Expo.
 */
export function bearerToken<User = Record<string, unknown>>(options: BearerTokenOptions): BearerTokenAuth<User> {
  // Checked at runtime too: JavaScript callers get no compile-time error.
  if ((options as Partial<BearerTokenOptions>).storage == null) {
    throw new TypeError(
      'bearerToken needs a storage adapter. Use expoSecureStore() on Expo or memoryStorage() in tests.',
    );
  }
  const storage = options.storage;
  const key = options.key ?? 'atannex.bridge.token';
  const expiryKey = `${key}.expires_at`;
  const refreshBefore = (options.refreshBefore ?? 3 * 24 * 60 * 60) * 1000;
  let host: AuthHost | undefined;
  // undefined = not read from storage yet; null = known to be absent.
  let cached: string | null | undefined;
  let cachedExpiry: number | null | undefined;
  let refreshing: Promise<User | null> | undefined;
  const sentWith = new WeakMap<TransportRequest, string>();

  const requireHost = (): AuthHost => {
    if (host === undefined) {
      throw new Error('This auth adapter is not attached to a Bridge client yet. Pass it as `auth` to createBridge.');
    }
    return host;
  };

  const token = async (): Promise<string | null> => {
    if (cached === undefined) cached = (await storage.getItem(key)) ?? null;
    return cached;
  };

  const expiry = async (): Promise<number | null> => {
    if (cachedExpiry === undefined) {
      const stored = Date.parse((await storage.getItem(expiryKey)) ?? '');
      cachedExpiry = Number.isNaN(stored) ? null : stored;
    }
    return cachedExpiry;
  };

  const save = async (value: string, expiresAt: string | null | undefined): Promise<void> => {
    const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    await storage.setItem(key, value);
    if (Number.isNaN(at)) await storage.removeItem(expiryKey);
    else await storage.setItem(expiryKey, new Date(at).toISOString());
    cached = value;
    cachedExpiry = Number.isNaN(at) ? null : at;
  };

  const forget = async (): Promise<void> => {
    cached = null;
    cachedExpiry = null;
    await storage.removeItem(key);
    await storage.removeItem(expiryKey);
  };

  const accept = async (data: unknown): Promise<User | null> => {
    const payload = data as Partial<AuthenticatedPayload<User>> | undefined;
    if (payload?.status !== 'authenticated' || typeof payload.token !== 'string' || payload.token === '') {
      throw new BridgeProtocolError({ code: 'PROTOCOL_ERROR', message: 'The login response did not contain a token.' });
    }
    await save(payload.token, payload.expires_at);
    return payload.user ?? null;
  };

  const runRefresh = async (current: string): Promise<User | null> => {
    const connection = requireHost();
    try {
      const response = await connection.send({
        method: 'POST',
        path: options.refreshPath ?? connection.prefixed('auth/refresh'),
        headers: { authorization: `Bearer ${current}` },
        auth: false,
      });
      return await accept((response.body as { data?: unknown } | undefined)?.data);
    } catch (error) {
      // Only a token nobody replaced meanwhile is forgotten.
      if (error instanceof BridgeAuthenticationError && error.status === 401 && cached === current) {
        await forget();
        options.onSessionExpired?.();
      }
      throw error;
    }
  };

  const refresh = (): Promise<User | null> => {
    refreshing ??= (async () => {
      const current = await token();
      if (current === null) {
        throw new BridgeAuthenticationError({
          code: 'UNAUTHENTICATED',
          message: 'There is no token to refresh.',
          status: 401,
        });
      }
      return runRefresh(current);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  const dueForRefresh = async (): Promise<boolean> => {
    if (refreshBefore <= 0 || host === undefined) return false;
    const at = await expiry();
    // An expired token is not refreshed: the server would refuse it.
    return at !== null && at - Date.now() <= refreshBefore && at > Date.now();
  };

  const adapter: BearerTokenAuth<User> = {
    attach(attached) {
      host = attached;
    },

    async prepare(request) {
      if (refreshing !== undefined || (await dueForRefresh())) {
        // Every request waits for the one refresh, then goes out with the new
        // token. A failed refresh leaves the old token (or none, after a 401).
        await refresh().catch(() => undefined);
      }
      const current = await token();
      if (current !== null) {
        request.headers['authorization'] = `Bearer ${current}`;
        sentWith.set(request, current);
      }
    },

    async onUnauthenticated(_error, request) {
      // Several calls can fail with the same dead token at once; only the
      // first clears it, and a token stored after the request went out stays.
      // The compare-and-clear must not await in between, or every failing
      // call would see the token still there.
      const used = sentWith.get(request);
      if (used === undefined || used !== cached) return;
      cached = null;
      cachedExpiry = null;
      await storage.removeItem(key);
      await storage.removeItem(expiryKey);
      options.onSessionExpired?.();
    },

    async login(credentials) {
      const current = requireHost();
      const response = await current.send({
        method: 'POST',
        path: options.loginPath ?? current.prefixed('auth/token'),
        body: { ...credentials, device_name: credentials.device_name ?? options.deviceName ?? 'bridge-client' },
        auth: false,
      });
      const data = (response.body as { data?: unknown } | undefined)?.data as
        { status?: string; challenge?: unknown; expires_at?: unknown } | undefined;
      if (data?.status === 'two_factor_required' && typeof data.challenge === 'string') {
        return {
          status: 'two_factor_required',
          challenge: data.challenge,
          expiresAt: typeof data.expires_at === 'string' ? data.expires_at : undefined,
        };
      }
      return { status: 'authenticated', user: await accept(data) };
    },

    async completeTwoFactor(input) {
      const current = requireHost();
      const response = await current.send({
        method: 'POST',
        path: options.twoFactorPath ?? current.prefixed('auth/two-factor'),
        body: input,
        auth: false,
      });
      return accept((response.body as { data?: unknown } | undefined)?.data);
    },

    refresh,

    async expiresAt() {
      if ((await token()) === null) return null;
      const at = await expiry();
      return at === null ? null : new Date(at);
    },

    async logout() {
      const current = requireHost();
      if ((await token()) === null) return;
      try {
        await current.send({ method: 'POST', path: options.logoutPath ?? current.prefixed('auth/logout') });
      } catch (error) {
        await forget();
        // A 401 means the token was already dead, which is what logout wants.
        if (error instanceof BridgeAuthenticationError) return;
        throw error;
      }
      await forget();
    },

    async user() {
      const current = requireHost();
      if ((await token()) === null) return null;
      try {
        const response = await current.send({ method: 'GET', path: options.userPath ?? current.prefixed('auth/user') });
        return (response.body as { data?: User } | undefined)?.data ?? null;
      } catch (error) {
        if (error instanceof BridgeAuthenticationError && error.status === 401) {
          await forget();
          return null;
        }
        throw error;
      }
    },

    async isAuthenticated() {
      return (await token()) !== null;
    },
  };
  return adapter;
}
