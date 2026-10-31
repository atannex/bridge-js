import type { BridgeError } from '../errors/errors.js';
import { BridgeAuthenticationError } from '../errors/errors.js';
import type { TransportRequest, TransportResponse } from '../transport/types.js';
import type { CookieJar } from './cookie-jar.js';
import type { AuthAdapter, AuthHost } from './types.js';

export interface SanctumSessionOptions {
  /** Default `/sanctum/csrf-cookie`. */
  csrfPath?: string;
  /** Fortify's login route. Default `/login`. */
  loginPath?: string;
  /** Default `/logout`. */
  logoutPath?: string;
  /** Fortify's two-factor challenge route. Default `/two-factor-challenge`. */
  twoFactorPath?: string;
  /** Default `<prefix>/auth/user`. */
  userPath?: string;
  /** Cookie name Laravel puts the CSRF token in. Default `XSRF-TOKEN`. */
  csrfCookie?: string;
  /** Keeps cookies where the runtime does not (Node). Browsers and React Native don't need one. */
  cookieJar?: CookieJar;
  /** Called when an operation call comes back 401: the session has ended. */
  onSessionExpired?: () => void;
}

export interface SessionCredentials {
  email: string;
  password: string;
  remember?: boolean;
  [field: string]: unknown;
}

export type SessionLoginResult<User> =
  { status: 'authenticated'; user: User | null } | { status: 'two_factor_required' };

export interface SanctumSessionAuth<User = Record<string, unknown>> extends AuthAdapter {
  /** Fetches a fresh CSRF cookie. */
  csrf(): Promise<void>;
  /** Signs in through Fortify. Resolves `two_factor_required` when the account has two-factor auth on. */
  login(credentials: SessionCredentials): Promise<SessionLoginResult<User>>;
  /** Finishes a two-factor login with a TOTP code or a recovery code. */
  twoFactorChallenge(input: { code: string } | { recovery_code: string }): Promise<User | null>;
  logout(): Promise<void>;
  /** The signed-in user, or null when signed out. */
  user(): Promise<User | null>;
}

function readDocumentCookie(name: string): string | undefined {
  const doc = (globalThis as { document?: { cookie?: unknown } }).document;
  if (typeof doc?.cookie !== 'string') return undefined;
  for (const part of doc.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Cookie-session authentication for Laravel Sanctum's SPA mode with Fortify.
 *
 * For web apps served from a domain Sanctum treats as stateful. Requests carry
 * the session cookie (`credentials: 'include'`) and the CSRF token from the
 * `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`. A 419 refreshes the CSRF cookie and
 * replays the request once. React Native apps should use `bearerToken`.
 */
export function sanctumSession<User = Record<string, unknown>>(
  options: SanctumSessionOptions = {},
): SanctumSessionAuth<User> {
  const csrfPath = options.csrfPath ?? '/sanctum/csrf-cookie';
  const loginPath = options.loginPath ?? '/login';
  const logoutPath = options.logoutPath ?? '/logout';
  const twoFactorPath = options.twoFactorPath ?? '/two-factor-challenge';
  const csrfCookie = options.csrfCookie ?? 'XSRF-TOKEN';
  const jar = options.cookieJar;
  let host: AuthHost | undefined;

  const requireHost = (): AuthHost => {
    if (host === undefined) {
      throw new Error('This auth adapter is not attached to a Bridge client yet. Pass it as `auth` to createBridge.');
    }
    return host;
  };

  const csrfToken = (): string | undefined => {
    const raw = jar !== undefined ? jar.get(csrfCookie) : readDocumentCookie(csrfCookie);
    return raw === undefined ? undefined : safeDecode(raw);
  };

  const adapter: SanctumSessionAuth<User> = {
    attach(attached) {
      host = attached;
    },

    prepare(request: TransportRequest) {
      request.credentials = 'include';
      const token = csrfToken();
      if (token !== undefined) request.headers['x-xsrf-token'] = token;
      const cookies = jar?.header();
      if (cookies !== undefined) request.headers['cookie'] = cookies;
    },

    handleResponse(response: TransportResponse) {
      jar?.store(response.headers);
    },

    onUnauthenticated() {
      options.onSessionExpired?.();
    },

    async recover(error: BridgeError) {
      if (!(error instanceof BridgeAuthenticationError) || error.status !== 419) return false;
      await adapter.csrf();
      return true;
    },

    async csrf() {
      await requireHost().send({ method: 'GET', path: csrfPath });
    },

    async login(credentials) {
      await adapter.csrf();
      const response = await requireHost().send({
        method: 'POST',
        path: loginPath,
        body: credentials,
      });
      const body = response.body as { two_factor?: unknown } | undefined;
      if (body?.two_factor === true) {
        return { status: 'two_factor_required' };
      }
      return { status: 'authenticated', user: await adapter.user() };
    },

    async twoFactorChallenge(input) {
      await requireHost().send({
        method: 'POST',
        path: twoFactorPath,
        body: input,
      });
      return adapter.user();
    },

    async logout() {
      try {
        await requireHost().send({ method: 'POST', path: logoutPath });
      } catch (error) {
        // An already-ended session is the outcome logout wants.
        if (!(error instanceof BridgeAuthenticationError)) throw error;
      }
    },

    async user() {
      const current = requireHost();
      try {
        const response = await current.send({
          method: 'GET',
          path: options.userPath ?? current.prefixed('auth/user'),
        });
        const body = response.body as { data?: User } | undefined;
        return body?.data ?? null;
      } catch (error) {
        if (error instanceof BridgeAuthenticationError && error.status === 401) return null;
        throw error;
      }
    },
  };
  return adapter;
}
