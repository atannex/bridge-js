import { expect, it } from 'vitest';
import {
  BridgeAuthenticationError,
  BridgeValidationError,
  createBridge,
  memoryCookieJar,
  sanctumSession,
} from '@atannex/bridge';
import { operations, type AppBridge } from './contract.generated.js';
import { baseURL, describeLive, PASSWORD, signedIn, tokenClient, totp } from './support.js';

const CAROL_SECRET = 'JBSWY3DPEHPK3PXP';

describeLive('token authentication', () => {
  it('logs in, calls, and is locked out after logout revokes the token', async () => {
    const { bridge, auth, storage } = await signedIn('alice@example.com');
    const user = await auth.user();
    expect(user).toMatchObject({ email: 'alice@example.com' });
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('two_factor_secret');

    await bridge.call('cart.show');

    // Keep the raw token to prove the server revoked it, not just the client.
    const token = await storage.getItem('atannex.bridge.token');
    expect(token).toBeTruthy();
    const probe = createBridge<AppBridge>({
      baseURL: baseURL ?? '',
      operations,
      auth: { prepare: (request) => void (request.headers['authorization'] = `Bearer ${token ?? ''}`) },
    });

    await auth.logout();
    expect(await auth.isAuthenticated()).toBe(false);
    await expect(bridge.call('cart.show')).rejects.toBeInstanceOf(BridgeAuthenticationError);
    await expect(probe.call('cart.show')).rejects.toBeInstanceOf(BridgeAuthenticationError);
  });

  it('refreshes a live token: the new one works and the old one is revoked', async () => {
    const { bridge, auth, storage } = await signedIn('alice@example.com');
    const old = await storage.getItem('atannex.bridge.token');
    const probe = createBridge<AppBridge>({
      baseURL: baseURL ?? '',
      operations,
      auth: { prepare: (request) => void (request.headers['authorization'] = `Bearer ${old ?? ''}`) },
    });

    expect(await auth.refresh()).toMatchObject({ email: 'alice@example.com' });
    const fresh = await storage.getItem('atannex.bridge.token');
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);

    await bridge.call('cart.show');
    await expect(probe.call('cart.show')).rejects.toBeInstanceOf(BridgeAuthenticationError);
    await auth.logout();
  });

  it('rejects wrong credentials without saying whether the account exists', async () => {
    const { auth } = tokenClient();
    const wrongPassword = await auth.login({ email: 'alice@example.com', password: 'nope' }).catch((e: unknown) => e);
    const noAccount = await auth.login({ email: 'nobody@example.com', password: 'nope' }).catch((e: unknown) => e);
    expect(wrongPassword).toBeInstanceOf(BridgeValidationError);
    expect(noAccount).toBeInstanceOf(BridgeValidationError);
    expect((wrongPassword as BridgeValidationError).fields).toEqual((noAccount as BridgeValidationError).fields);
  });

  it('requires the second factor before issuing a token', async () => {
    const { bridge, auth } = tokenClient();
    const first = await auth.login({ email: 'carol@example.com', password: PASSWORD });
    expect(first.status).toBe('two_factor_required');
    if (first.status !== 'two_factor_required') return;
    expect(await auth.isAuthenticated()).toBe(false);

    const wrong = await auth.completeTwoFactor({ challenge: first.challenge, code: '000000' }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(BridgeValidationError);
    expect((wrong as BridgeValidationError).code).toBe('TWO_FACTOR_FAILED');

    // One login, one challenge: a wrong code does not burn it. The server
    // throttles logins and wrong codes per user, so the test stays frugal.
    // A code may already have been used in this 30 s window by an earlier run;
    // the next window's code is accepted too.
    let user: unknown;
    try {
      user = await auth.completeTwoFactor({ challenge: first.challenge, code: await totp(CAROL_SECRET) });
    } catch {
      user = await auth.completeTwoFactor({ challenge: first.challenge, code: await totp(CAROL_SECRET, 1) });
    }
    expect(user).toMatchObject({ email: 'carol@example.com' });
    await bridge.call('cart.show');
    await auth.logout();
  });
});

describeLive('cookie session authentication (Sanctum SPA + Fortify)', () => {
  it('logs in through Fortify, calls with the session, and logs out', async () => {
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const bridge = createBridge<AppBridge>({
      baseURL: baseURL ?? '',
      operations,
      auth,
      // Sanctum treats requests from this origin as stateful.
      headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
    });

    await expect(bridge.call('cart.show')).rejects.toBeInstanceOf(BridgeAuthenticationError);

    const result = await auth.login({ email: 'bob@example.com', password: PASSWORD });
    expect(result).toMatchObject({ status: 'authenticated', user: { email: 'bob@example.com' } });

    const cart = await bridge.call('cart.show');
    expect(Array.isArray(cart.items)).toBe(true);

    await auth.logout();
    expect(await auth.user()).toBeNull();
    await expect(bridge.call('cart.show')).rejects.toBeInstanceOf(BridgeAuthenticationError);
  });

  it('rejects a session request whose CSRF token is wrong', async () => {
    const jar = memoryCookieJar();
    const auth = sanctumSession({ cookieJar: jar });
    createBridge<AppBridge>({
      baseURL: baseURL ?? '',
      operations,
      auth,
      headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
    });
    await auth.login({ email: 'bob@example.com', password: PASSWORD });
    // Same session cookie, wrong CSRF token, and no adapter to recover from the 419.
    const forged = createBridge<AppBridge>({
      baseURL: baseURL ?? '',
      operations,
      headers: { Origin: 'http://localhost:5173', Referer: 'http://localhost:5173/' },
      auth: {
        prepare: (request) => {
          request.credentials = 'include';
          request.headers['x-xsrf-token'] = 'forged';
          const cookies = jar.header();
          if (cookies !== undefined) request.headers['cookie'] = cookies;
        },
      },
    });
    const error = await forged.call('cart.remove', { product_id: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeAuthenticationError);
    expect((error as BridgeAuthenticationError).status).toBe(419);
    await auth.logout();
  });
});
