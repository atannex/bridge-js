import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { baseURL, describeLive, PASSWORD } from './support.js';

/**
 * Loads the built package the way Metro does — through the `react-native`
 * export condition — with no DOM globals, then signs in with a bearer token
 * and calls operations over real HTTP.
 */
describeLive('react-native entry over HTTP', () => {
  it('logs in with a token and calls the API using only the built RN entry', async () => {
    const root = new URL('../../', import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    const entry = pkg.exports['.']?.['react-native'];
    expect(entry).toBe('./dist/index.js');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');

    const sdk = (await import(/* @vite-ignore */ new URL(entry!, root).href)) as typeof import('@atannex/bridge');

    // An in-memory stand-in for expo-secure-store's async API.
    const secure = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => secure.get(key) ?? null,
      setItem: async (key: string, value: string) => void secure.set(key, value),
      removeItem: async (key: string) => void secure.delete(key),
    };
    const auth = sdk.bearerToken({ storage, deviceName: 'rn-entry-test' });
    const bridge = sdk.createBridge({ baseURL: baseURL ?? '', auth, client: 'rn-entry-test/0.1.0' });

    const login = await auth.login({ email: 'alice@example.com', password: PASSWORD });
    expect(login.status).toBe('authenticated');
    expect(secure.has('atannex.bridge.token')).toBe(true);

    const page = (await bridge.call('products.list', { page: 1 })) as { items: unknown[] };
    expect(page.items.length).toBeGreaterThan(0);
    const cart = (await bridge.call('cart.show')) as { items: unknown[] };
    expect(Array.isArray(cart.items)).toBe(true);

    await auth.logout();
    expect(secure.size).toBe(0);
    await expect(bridge.call('cart.show')).rejects.toBeInstanceOf(sdk.BridgeAuthenticationError);
  });
});
