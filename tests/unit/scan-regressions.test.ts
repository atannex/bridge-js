// Regression tests for the issues found in the 1.0.0 deep scan. Each block names the issue.
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  BridgeProtocolError,
  BridgeServerError,
  bearerToken,
  createBridge,
  memoryStorage,
  sanctumSession,
  type AttemptEvent,
} from '@atannex/bridge';
import { infiniteQueryOptions, queryOptions } from '@atannex/bridge/query';
import { createRealtime, type EchoChannelLike, type EchoLike } from '@atannex/bridge/realtime';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fail, fakeFetch, hang, json, ok } from '../fixtures/fake-fetch.js';

describe('responses refused before their body is read release the connection', () => {
  it('aborts the request when Content-Length is over maxResponseBytes', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, { data: 'x'.repeat(100), meta: { request_id: 'r' } }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, maxResponseBytes: 10 });
    await expect(bridge.call('cart.show')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('aborts the request on a redirect', async () => {
    const { fetch, requests } = fakeFetch(() => new Response('moved', { status: 302, headers: { location: '/x' } }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    await expect(bridge.call('cart.show')).rejects.toBeInstanceOf(BridgeProtocolError);
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('aborts a download that is refused on a redirect', async () => {
    const { fetch, requests } = fakeFetch(() => new Response('moved', { status: 302, headers: { location: '/x' } }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    await expect(bridge.download('/files/1')).rejects.toBeInstanceOf(BridgeProtocolError);
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('does not abort a successful call', async () => {
    const { fetch, requests } = fakeFetch(ok({ items: [] }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    await bridge.call('cart.show');
    expect(requests[0]?.signal?.aborted).toBe(false);
  });
});

describe('download honours the request interceptors and a missing fetch', () => {
  it('runs request interceptors on downloads', async () => {
    const { fetch, requests } = fakeFetch(() => new Response('file'));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    bridge.interceptors.request.use((request, context) => {
      request.headers['x-trace'] = `op:${String(context.operation)}`;
    });
    await (await bridge.download('/files/1')).text();
    expect(requests[0]?.headers['x-trace']).toBe('op:undefined');
  });

  it('refuses an interceptor that moves a download to another origin', async () => {
    const { fetch, requests } = fakeFetch(() => new Response('file'));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    bridge.interceptors.request.use((request) => ({ ...request, url: 'https://evil.test/steal' }));
    await expect(bridge.download('/files/1')).rejects.toThrow(/another origin/);
    expect(requests).toHaveLength(0);
  });

  it('says fetch is missing instead of reporting a network error', async () => {
    const original = globalThis.fetch;
    // @ts-expect-error removing the global for this test
    delete globalThis.fetch;
    try {
      const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test' });
      await expect(bridge.download('/files/1')).rejects.toThrow(/No fetch implementation/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('auth requests stay on the baseURL origin when baseURL is relative', () => {
  it('refuses an absolute auth path on a relative baseURL', async () => {
    const { fetch, requests } = fakeFetch(ok(null));
    const auth = sanctumSession({ csrfPath: 'https://evil.test/sanctum/csrf-cookie' });
    createBridge<AppBridge>({ baseURL: '/api', fetch, auth });
    await expect(auth.csrf()).rejects.toThrow(/same origin/);
    expect(requests).toHaveLength(0);
  });

  it('still sends relative auth paths on a relative baseURL', async () => {
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 204 }));
    const auth = sanctumSession();
    createBridge<AppBridge>({ baseURL: '/api', fetch, auth });
    await auth.csrf();
    expect(requests[0]?.url).toBe('/api/sanctum/csrf-cookie');
  });
});

describe('currentTenant with an async tenant function', () => {
  it('throws without leaving a rejected promise unhandled', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const bridge = createBridge<AppBridge>({
        baseURL: 'https://api.test',
        tenant: () => Promise.reject(new Error('storage failed')),
      });
      expect(() => bridge.currentTenant()).toThrow(TypeError);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('removing an interceptor removes only that registration', () => {
  it('keeps a second registration of the same function, and removing twice is a no-op', async () => {
    const { fetch } = fakeFetch(ok(null));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    const seen = vi.fn();
    const removeFirst = bridge.interceptors.request.use(seen);
    bridge.interceptors.request.use(seen);
    removeFirst();
    removeFirst();
    expect(bridge.interceptors.request.items).toHaveLength(1);
    await bridge.call('cart.show');
    expect(seen).toHaveBeenCalledOnce();
  });
});

describe('BridgeServerError.toJSON', () => {
  it('includes retryAfter like BridgeRateLimitError does', () => {
    const error = new BridgeServerError({ code: 'SERVICE_UNAVAILABLE', message: 'down', status: 503, retryAfter: 5 });
    expect(error.toJSON()).toMatchObject({ retryAfter: 5, status: 503 });
  });
});

describe('realtime reauthorize does not double listeners', () => {
  it('rebinds once when Echo hands back the same channel object', () => {
    // Echo caches channels by full name and, without leaveChannel, leave(name)
    // is skipped while another variant of the name is subscribed.
    const cache = new Map<string, EchoChannelLike & { emit(event: string): number }>();
    const make = (full: string) => {
      // An array, like Pusher's bind: binding the same handler twice fires it twice.
      const handlers = new Map<string, ((payload: never) => void)[]>();
      return {
        listen(event: string, handler: (payload: never) => void) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        stopListening(event: string, handler?: (payload: never) => void) {
          handlers.set(event, handler === undefined ? [] : (handlers.get(event) ?? []).filter((h) => h !== handler));
        },
        here: () => undefined,
        joining: () => undefined,
        leaving: () => undefined,
        emit(event: string) {
          const list = handlers.get(event) ?? [];
          for (const handler of list) handler(undefined as never);
          return list.length;
        },
        full,
      };
    };
    const get = (full: string) => {
      if (!cache.has(full)) cache.set(full, make(full));
      return cache.get(full)!;
    };
    const echo: EchoLike = {
      channel: (name) => get(name),
      private: (name) => get(`private-${name}`),
      join: (name) => get(`presence-${name}`) as never,
      leave: (name) => {
        for (const full of [name, `private-${name}`, `presence-${name}`]) cache.delete(full);
      },
    };
    const realtime = createRealtime(echo);
    const handler = vi.fn();
    realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, handler);
    realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'presence' }, () => undefined);
    realtime.reauthorize();
    expect(cache.get('private-orders.1')!.emit('.orders.updated')).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('query helpers', () => {
  it('keys an infinite query apart from a plain query of the same input', () => {
    const { fetch } = fakeFetch(ok(null));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations });
    const plain = queryOptions(bridge, 'products.list', { search: 'a' });
    const infinite = infiniteQueryOptions(bridge, 'products.list', { search: 'a' });
    expect(infinite.queryKey).not.toEqual(plain.queryKey);
    expect(infinite.queryKey.slice(0, 4)).toEqual(plain.queryKey);
  });

  it('honours a signal passed in the call options alongside TanStack’s', async () => {
    const { fetch } = fakeFetch(hang);
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations, retry: false });
    const controller = new AbortController();
    const options = queryOptions(bridge, 'cart.show', undefined, { signal: controller.signal });
    const pending = new QueryClient({ defaultOptions: { queries: { retry: false } } }).query(options);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('bearerToken.user() on 401', () => {
  it('forgets the token and reports the expired session', async () => {
    const { fetch } = fakeFetch(fail(401, 'UNAUTHENTICATED'));
    const storage = memoryStorage({ 'atannex.bridge.token': 'old-token' });
    const onSessionExpired = vi.fn();
    const auth = bearerToken({ storage, onSessionExpired });
    createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });
    expect(await auth.user()).toBeNull();
    expect(await auth.isAuthenticated()).toBe(false);
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it('keeps a token stored while the request was out', async () => {
    // `auth` is only used once the fake fetch runs, after it is declared below.
    const { fetch } = fakeFetch(
      async () => {
        await auth.login({ email: 'a@b.c', password: 'x' });
        return json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' }, meta: { request_id: 'r' } });
      },
      ok({ status: 'authenticated', token: 'new-token' }),
    );
    const storage = memoryStorage({ 'atannex.bridge.token': 'old-token' });
    const auth = bearerToken({ storage });
    createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, auth });
    await expect(auth.user()).resolves.toBeNull();
    expect(await storage.getItem('atannex.bridge.token')).toBe('new-token');
  });
});

describe('onAttempt', () => {
  it('reports each attempt with its outcome and the wait before the next', async () => {
    const { fetch } = fakeFetch(fail(503, 'SERVICE_UNAVAILABLE'), ok({ items: [] }));
    const events: AttemptEvent[] = [];
    const bridge = createBridge<AppBridge>({
      baseURL: 'https://api.test',
      fetch,
      operations,
      retry: { baseDelay: 1, maxDelay: 2 },
      onAttempt: (event) => events.push(event),
    });
    await bridge.call('cart.show');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ operation: 'cart.show', attempt: 1, status: 503 });
    expect(events[0]?.error).toBeInstanceOf(BridgeServerError);
    expect(events[0]?.retryInMs).toBeGreaterThanOrEqual(0);
    expect(events[1]).toMatchObject({ attempt: 2, status: 200, error: undefined, retryInMs: undefined });
    expect(events[0]?.correlationId).toBe(events[1]?.correlationId);
    expect(events[0]?.requestId).not.toBe(events[1]?.requestId);
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('marks the final failure with no retry', async () => {
    const { fetch } = fakeFetch(fail(422, 'VALIDATION_FAILED'));
    const events: AttemptEvent[] = [];
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, onAttempt: (e) => events.push(e) });
    await expect(bridge.call('cart.show')).rejects.toBeDefined();
    expect(events).toEqual([expect.objectContaining({ attempt: 1, status: 422, retryInMs: undefined })]);
  });

  it('ignores an observer that throws', async () => {
    const { fetch } = fakeFetch(ok({ items: [] }));
    const bridge = createBridge<AppBridge>({
      baseURL: 'https://api.test',
      fetch,
      onAttempt: () => {
        throw new Error('metrics backend down');
      },
    });
    await expect(bridge.call('cart.show')).resolves.toEqual({ items: [] });
  });
});
