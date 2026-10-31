import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeAuthenticationError,
  BridgeNetworkError,
  BridgeValidationError,
  bearerToken,
  createBridge,
  memoryCookieJar,
  memoryStorage,
  sanctumSession,
} from '@atannex/bridge';
import { expoSecureStore } from '@atannex/bridge/expo';
import { splitSetCookie } from '../../src/authentication/cookie-jar.js';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fail, fakeFetch, json, networkDown, ok, type Responder } from '../fixtures/fake-fetch.js';

const user = { id: 1, name: 'Alice', email: 'alice@example.com' };
const tokenResponse: Responder = () =>
  json(200, {
    data: { status: 'authenticated', token: '1|plain-token', token_type: 'Bearer', user },
    meta: { request_id: 'r-12345678', version: '1' },
  });

describe('bearerToken', () => {
  it('needs a storage adapter', () => {
    expect(() => bearerToken({} as never)).toThrow(TypeError);
  });

  it('fails clearly when used before it is attached', async () => {
    const auth = bearerToken({ storage: memoryStorage() });
    await expect(auth.login({ email: 'a', password: 'b' })).rejects.toThrow(/not attached/);
  });

  it('logs in, stores the token and sends it on calls', async () => {
    const storage = memoryStorage();
    const auth = bearerToken({ storage, deviceName: 'Pixel 8' });
    const { fetch, requests } = fakeFetch(tokenResponse, ok({ items: [], total: '0.00' }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });

    const result = await auth.login({ email: 'alice@example.com', password: 'password' });
    expect(result).toEqual({ status: 'authenticated', user });
    expect(await storage.getItem('atannex.bridge.token')).toBe('1|plain-token');
    expect(await auth.isAuthenticated()).toBe(true);

    expect(requests[0]?.url).toBe('https://api.test/bridge/v1/auth/token');
    expect(JSON.parse(requests[0]?.body as string)).toEqual({
      email: 'alice@example.com',
      password: 'password',
      device_name: 'Pixel 8',
    });
    expect(requests[0]?.headers['authorization']).toBeUndefined();

    await bridge.call('cart.show');
    expect(requests[1]?.headers['authorization']).toBe('Bearer 1|plain-token');
  });

  it('does not send a stored token to the login endpoint', async () => {
    const auth = bearerToken({ storage: memoryStorage({ 'atannex.bridge.token': 'old' }) });
    const { fetch, requests } = fakeFetch(tokenResponse);
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    await auth.login({ email: 'a@b.c', password: 'x' });
    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('handles the two-factor challenge without storing anything until it is passed', async () => {
    const storage = memoryStorage();
    const auth = bearerToken({ storage });
    const { fetch, requests } = fakeFetch(
      ok({ status: 'two_factor_required', challenge: 'chal-123', expires_at: '2026-10-30T12:05:00+00:00' }),
      tokenResponse,
    );
    createBridge({ baseURL: 'https://api.test', fetch, auth, prefix: 'api/bridge' });

    const first = await auth.login({ email: 'carol@example.com', password: 'password' });
    expect(first).toEqual({
      status: 'two_factor_required',
      challenge: 'chal-123',
      expiresAt: '2026-10-30T12:05:00+00:00',
    });
    expect(await auth.isAuthenticated()).toBe(false);

    expect(await auth.completeTwoFactor({ challenge: 'chal-123', code: '123456' })).toEqual(user);
    expect(requests[1]?.url).toBe('https://api.test/api/bridge/auth/two-factor');
    expect(JSON.parse(requests[1]?.body as string)).toEqual({ challenge: 'chal-123', code: '123456' });
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it('surfaces wrong credentials as a validation error', async () => {
    const auth = bearerToken({ storage: memoryStorage() });
    const { fetch } = fakeFetch(
      fail(422, 'VALIDATION_FAILED', { email: ['These credentials do not match our records.'] }),
    );
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    const error = await auth.login({ email: 'a@b.c', password: 'nope' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeValidationError);
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it('rejects a login response without a token', async () => {
    const auth = bearerToken({ storage: memoryStorage() });
    const { fetch } = fakeFetch(ok({ status: 'authenticated' }));
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    await expect(auth.login({ email: 'a@b.c', password: 'x' })).rejects.toThrow(/token/);
  });

  it('revokes on the server, then forgets the token', async () => {
    const storage = memoryStorage({ 'atannex.bridge.token': 'tok' });
    const auth = bearerToken({ storage });
    const { fetch, requests } = fakeFetch(ok(null));
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    await auth.logout();
    expect(requests[0]?.url).toBe('https://api.test/bridge/v1/auth/logout');
    expect(requests[0]?.headers['authorization']).toBe('Bearer tok');
    expect(await storage.getItem('atannex.bridge.token')).toBeNull();
  });

  it('forgets the token even when logout fails, and reports non-auth failures', async () => {
    const storage = memoryStorage({ 'atannex.bridge.token': 'tok' });
    const auth = bearerToken({ storage });
    const { fetch } = fakeFetch(networkDown);
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    await expect(auth.logout()).rejects.toBeInstanceOf(BridgeNetworkError);
    expect(await auth.isAuthenticated()).toBe(false);

    const storage2 = memoryStorage({ 'atannex.bridge.token': 'dead' });
    const auth2 = bearerToken({ storage: storage2 });
    createBridge({ baseURL: 'https://api.test', fetch: fakeFetch(fail(401, 'UNAUTHENTICATED')).fetch, auth: auth2 });
    await auth2.logout();
    expect(await auth2.isAuthenticated()).toBe(false);
  });

  it('clears the token once when concurrent calls get 401', async () => {
    const storage = memoryStorage({ 'atannex.bridge.token': 'expired' });
    const onSessionExpired = vi.fn();
    const auth = bearerToken({ storage, onSessionExpired });
    const { fetch } = fakeFetch(fail(401, 'UNAUTHENTICATED'));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth, operations });
    const results = await Promise.allSettled([
      bridge.call('cart.show'),
      bridge.call('cart.show'),
      bridge.call('cart.show'),
    ]);
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof BridgeAuthenticationError)).toBe(true);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it('keeps a token stored after the failing request went out', async () => {
    const storage = memoryStorage({ 'atannex.bridge.token': 'old' });
    const auth = bearerToken({ storage });
    let release: () => void = () => undefined;
    const { fetch } = fakeFetch(
      () =>
        new Promise<Response>(
          (resolve) =>
            (release = () => {
              resolve(fail(401, 'UNAUTHENTICATED')({} as never, 0));
            }),
        ),
      tokenResponse,
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });
    const pending = bridge.call('cart.show').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    await auth.login({ email: 'a@b.c', password: 'x' });
    release();
    await pending;
    expect(await storage.getItem('atannex.bridge.token')).toBe('1|plain-token');
  });

  it('returns the user, or null without a token or on 401', async () => {
    const auth = bearerToken({ storage: memoryStorage({ 'atannex.bridge.token': 'tok' }) });
    const { fetch } = fakeFetch(ok(user), fail(401, 'UNAUTHENTICATED'));
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    expect(await auth.user()).toEqual(user);
    expect(await auth.user()).toBeNull();
    expect(await auth.isAuthenticated()).toBe(false);
    expect(await auth.user()).toBeNull();
  });
});

describe('bearerToken refresh', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const issued =
    (token: string, expiresAt: string | null): Responder =>
    () =>
      json(200, {
        data: { status: 'authenticated', token, token_type: 'Bearer', expires_at: expiresAt, user },
        meta: { request_id: 'r-12345678', version: '1' },
      });

  it('stores the expiry the server reports and swaps the token on refresh()', async () => {
    const storage = memoryStorage();
    const auth = bearerToken({ storage });
    const soon = new Date(Date.now() + 30 * DAY).toISOString();
    const later = new Date(Date.now() + 60 * DAY).toISOString();
    const { fetch, requests } = fakeFetch(issued('1|a', soon), issued('2|b', later));
    createBridge({ baseURL: 'https://api.test', fetch, auth });

    await auth.login({ email: 'a@b.c', password: 'x' });
    expect((await auth.expiresAt())?.toISOString()).toBe(soon);

    expect(await auth.refresh()).toEqual(user);
    expect(requests[1]?.url).toBe('https://api.test/bridge/v1/auth/refresh');
    expect(requests[1]?.headers['authorization']).toBe('Bearer 1|a');
    expect(await storage.getItem('atannex.bridge.token')).toBe('2|b');
    expect(await storage.getItem('atannex.bridge.token.expires_at')).toBe(later);
  });

  it('refreshes once before calls when the token is close to expiring', async () => {
    const storage = memoryStorage({
      'atannex.bridge.token': 'old',
      'atannex.bridge.token.expires_at': new Date(Date.now() + DAY).toISOString(),
    });
    const auth = bearerToken({ storage });
    const { fetch, requests } = fakeFetch(
      issued('new', new Date(Date.now() + 30 * DAY).toISOString()),
      ok({ items: [], total: '0.00' }),
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth, operations });

    await Promise.all([bridge.call('cart.show'), bridge.call('cart.show'), bridge.call('cart.show')]);
    const refreshes = requests.filter((r) => r.url.endsWith('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
    const calls = requests.filter((r) => r.url.includes('/call/'));
    expect(calls.map((r) => r.headers['authorization'])).toEqual(['Bearer new', 'Bearer new', 'Bearer new']);
  });

  it('does not refresh a token far from expiry, or when turned off', async () => {
    const far = new Date(Date.now() + 20 * DAY).toISOString();
    const near = new Date(Date.now() + DAY).toISOString();
    for (const [expiresAt, refreshBefore] of [
      [far, undefined],
      [near, 0],
    ] as const) {
      const storage = memoryStorage({ 'atannex.bridge.token': 'tok', 'atannex.bridge.token.expires_at': expiresAt });
      const auth = bearerToken({ storage, ...(refreshBefore === undefined ? {} : { refreshBefore }) });
      const { fetch, requests } = fakeFetch(ok({ items: [], total: '0.00' }));
      const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth, operations });
      await bridge.call('cart.show');
      expect(requests.map((r) => r.url)).toEqual(['https://api.test/bridge/v1/call/cart.show']);
    }
  });

  it('forgets a token the server refuses to refresh and reports the session as expired', async () => {
    const storage = memoryStorage({ 'atannex.bridge.token': 'dead' });
    const onSessionExpired = vi.fn();
    const auth = bearerToken({ storage, onSessionExpired });
    createBridge({ baseURL: 'https://api.test', fetch: fakeFetch(fail(401, 'UNAUTHENTICATED')).fetch, auth });
    await expect(auth.refresh()).rejects.toBeInstanceOf(BridgeAuthenticationError);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(await auth.isAuthenticated()).toBe(false);
    await expect(auth.refresh()).rejects.toBeInstanceOf(BridgeAuthenticationError);
  });

  it('keeps the token when a refresh fails for another reason, and the call still goes out', async () => {
    const storage = memoryStorage({
      'atannex.bridge.token': 'tok',
      'atannex.bridge.token.expires_at': new Date(Date.now() + DAY).toISOString(),
    });
    const auth = bearerToken({ storage });
    const { fetch, requests } = fakeFetch(networkDown, ok({ items: [], total: '0.00' }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth, operations, retry: false });
    await bridge.call('cart.show');
    expect(requests.at(-1)?.headers['authorization']).toBe('Bearer tok');
    expect(await storage.getItem('atannex.bridge.token')).toBe('tok');
  });
});

describe('expoSecureStore', () => {
  it('maps the storage interface onto SecureStore, passing options', async () => {
    const store = new Map<string, string>();
    const options = { keychainAccessible: 1 };
    const module = {
      getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
      setItemAsync: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      deleteItemAsync: vi.fn(async (key: string) => void store.delete(key)),
    };
    const storage = expoSecureStore(module, options);
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
    expect(module.setItemAsync).toHaveBeenCalledWith('k', 'v', options);
  });
});

describe('memoryCookieJar', () => {
  it('stores, sends and expires cookies', () => {
    let now = Date.parse('2026-10-30T12:00:00Z');
    const jar = memoryCookieJar(() => now);
    const headers = new Headers();
    headers.append(
      'set-cookie',
      'XSRF-TOKEN=abc%3D; expires=Fri, 30 Oct 2026 14:00:00 GMT; Max-Age=60; path=/; samesite=lax',
    );
    headers.append('set-cookie', 'laravel_session=s1; path=/; httponly');
    jar.store(headers);
    expect(jar.get('XSRF-TOKEN')).toBe('abc%3D');
    expect(jar.header()).toBe('XSRF-TOKEN=abc%3D; laravel_session=s1');

    now += 61_000; // Max-Age wins over Expires
    expect(jar.get('XSRF-TOKEN')).toBeUndefined();
    expect(jar.header()).toBe('laravel_session=s1');

    const deletion = new Headers();
    deletion.append('set-cookie', 'laravel_session=deleted; Max-Age=0; path=/');
    jar.store(deletion);
    expect(jar.header()).toBeUndefined();
  });

  it('splits a combined Set-Cookie header without breaking Expires dates', () => {
    expect(splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2; Path=/')).toEqual([
      'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
      'b=2; Path=/',
    ]);
  });

  it('falls back to the combined header when getSetCookie is missing', () => {
    const jar = memoryCookieJar();
    const headers = {
      get: (name: string) => (name === 'set-cookie' ? 'a=1; Path=/, b=2' : null),
    } as unknown as Headers;
    jar.store(headers);
    expect(jar.header()).toBe('a=1; b=2');
  });
});

describe('sanctumSession', () => {
  const xsrf: Responder = () =>
    new Response(null, {
      status: 204,
      headers: [
        ['set-cookie', 'XSRF-TOKEN=tok%2Bone; path=/; samesite=lax'],
        ['set-cookie', 'laravel_session=sess; path=/; httponly'],
      ],
    });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('fetches the CSRF cookie, logs in through Fortify and loads the user', async () => {
    const jar = memoryCookieJar();
    const auth = sanctumSession({ cookieJar: jar });
    const { fetch, requests } = fakeFetch(xsrf, () => json(200, { two_factor: false }), ok(user));
    createBridge({ baseURL: 'https://api.test', fetch, auth, headers: { Origin: 'http://localhost:5173' } });

    expect(await auth.login({ email: 'alice@example.com', password: 'password' })).toEqual({
      status: 'authenticated',
      user,
    });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://api.test/sanctum/csrf-cookie',
      'POST https://api.test/login',
      'GET https://api.test/bridge/v1/auth/user',
    ]);
    const login = requests[1]!;
    expect(login.credentials).toBe('include');
    expect(login.headers['x-xsrf-token']).toBe('tok+one');
    expect(login.headers['cookie']).toBe('XSRF-TOKEN=tok%2Bone; laravel_session=sess');
    expect(login.headers['origin']).toBe('http://localhost:5173');
    expect(login.headers['accept']).toBe('application/json');
  });

  it('reports a two-factor login and completes it', async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const { fetch, requests } = fakeFetch(
      xsrf,
      () => json(200, { two_factor: true }),
      () => new Response(null, { status: 204 }),
      ok(user),
    );
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    expect(await auth.login({ email: 'carol@example.com', password: 'password' })).toEqual({
      status: 'two_factor_required',
    });
    expect(await auth.twoFactorChallenge({ code: '123456' })).toEqual(user);
    expect(requests[2]?.url).toBe('https://api.test/two-factor-challenge');
  });

  it("surfaces Fortify's 422 as a validation error", async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const { fetch } = fakeFetch(xsrf, () =>
      json(422, {
        message: 'These credentials do not match our records.',
        errors: { email: ['These credentials do not match our records.'] },
      }),
    );
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    const error = await auth.login({ email: 'a@b.c', password: 'bad' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeValidationError);
    expect((error as BridgeValidationError).first('email')).toMatch(/credentials/);
  });

  it('reads the CSRF token from document.cookie in browsers', async () => {
    (globalThis as { document?: unknown }).document = { cookie: 'other=1; XSRF-TOKEN=a%20b' };
    const auth = sanctumSession();
    const { fetch, requests } = fakeFetch(ok(null));
    await createBridge({ baseURL: 'https://api.test', fetch, auth }).call('cart.show');
    expect(requests[0]?.headers['x-xsrf-token']).toBe('a b');
    expect(requests[0]?.headers['cookie']).toBeUndefined();
    expect(requests[0]?.credentials).toBe('include');
  });

  it('refreshes the CSRF cookie on 419 and replays once', async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const { fetch, requests } = fakeFetch(fail(419, 'CSRF_MISMATCH'), xsrf, ok({ items: [], total: '0.00' }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });
    expect(await bridge.call('cart.remove', { product_id: 1 })).toEqual({ items: [], total: '0.00' });
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.test/bridge/v1/call/cart.remove',
      'https://api.test/sanctum/csrf-cookie',
      'https://api.test/bridge/v1/call/cart.remove',
    ]);
    expect(requests[2]?.headers['x-xsrf-token']).toBe('tok+one');
  });

  it('does not loop on repeated 419s', async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const { fetch, requests } = fakeFetch(fail(419, 'CSRF_MISMATCH'), xsrf, fail(419, 'CSRF_MISMATCH'));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });
    await expect(bridge.call('cart.remove', { product_id: 1 })).rejects.toBeInstanceOf(BridgeAuthenticationError);
    expect(requests).toHaveLength(3);
  });

  it('calls onSessionExpired on 401 and returns a null user', async () => {
    const onSessionExpired = vi.fn();
    const auth = sanctumSession({ cookieJar: memoryCookieJar(), onSessionExpired });
    const { fetch } = fakeFetch(fail(401, 'UNAUTHENTICATED'));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });
    await expect(bridge.call('cart.show')).rejects.toBeInstanceOf(BridgeAuthenticationError);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(await auth.user()).toBeNull();
  });

  it('logs out, treating an already-ended session as done', async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 204 }), fail(401, 'UNAUTHENTICATED'));
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    await auth.logout();
    await auth.logout();
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('https://api.test/logout');
  });

  it('refuses to send auth requests to another origin', async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar(), csrfPath: 'https://evil.test/csrf' });
    const { fetch, requests } = fakeFetch(xsrf);
    createBridge({ baseURL: 'https://api.test', fetch, auth });
    await expect(auth.csrf()).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});
