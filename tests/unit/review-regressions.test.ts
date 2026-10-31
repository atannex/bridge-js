// Regression tests for the issues found in the 0.1.0 review. Each block names the issue.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BridgeAbortError,
  BridgeProtocolError,
  BridgeTimeoutError,
  DEFAULT_RETRY,
  bearerToken,
  createBridge,
  memoryCookieJar,
  memoryStorage,
  sanctumSession,
} from '@atannex/bridge';
import { echoAuthorizer } from '@atannex/bridge/realtime';
import { xhrTransport } from '@atannex/bridge/xhr';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fail, fakeFetch, json, ok } from '../fixtures/fake-fetch.js';

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('#1 an unsafe call must not switch off retries for later calls', () => {
  const unavailable = fail(503, 'SERVICE_UNAVAILABLE');
  const fast = { baseDelay: 1, maxDelay: 2 };

  it('keeps retrying safe calls on the same client after an unsafe one', async () => {
    const { fetch, requests } = fakeFetch(unavailable);
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations, retry: fast });
    const attempts = async (call: () => Promise<unknown>): Promise<number> => {
      const before = requests.length;
      await call().catch(() => undefined);
      return requests.length - before;
    };
    expect(await attempts(() => bridge.call('cart.show'))).toBe(3);
    expect(await attempts(() => bridge.call('cart.remove', { product_id: 1 }))).toBe(1);
    expect(await attempts(() => bridge.call('cart.show'))).toBe(3);
  });

  it('does not touch the shared default policy used by other clients', async () => {
    const first = fakeFetch(unavailable);
    await createBridge<AppBridge>({ baseURL: 'https://a.test', fetch: first.fetch, operations })
      .call('cart.remove', { product_id: 1 })
      .catch(() => undefined);
    expect(DEFAULT_RETRY.attempts).toBe(3);
    expect(Object.isFrozen(DEFAULT_RETRY)).toBe(true);

    const second = fakeFetch(unavailable, unavailable, ok({ items: [], total: '0.00' }));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://b.test', fetch: second.fetch, operations });
    // Retry-After is absent, so the default backoff (300 ms base) applies; two retries fit in the test timeout.
    await bridge.call('cart.show');
    expect(second.requests).toHaveLength(3);
  });
});

describe('#2 redirects are never followed with credentials', () => {
  async function trap(): Promise<{ origin: string; seen: IncomingHttpHeaders[] }> {
    const seen: IncomingHttpHeaders[] = [];
    const origin = await serve((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":1,"meta":{"request_id":"rrrrrrrr","version":"1"}}');
    });
    return { origin: origin.replace('127.0.0.1', 'localhost'), seen };
  }

  async function redirecting(target: string): Promise<string> {
    return serve((req, res) => {
      if (req.url?.includes('csrf') === true) {
        res.writeHead(204, { 'set-cookie': ['XSRF-TOKEN=xsrf-secret; Path=/', 'laravel_session=sess; Path=/'] });
        res.end();
        return;
      }
      res.writeHead(307, { location: `${target}/steal` });
      res.end();
    });
  }

  it('rejects a 307 on calls instead of re-sending token, tenant and body elsewhere', async () => {
    const { origin, seen } = await trap();
    const base = await redirecting(origin);
    const auth = bearerToken({ storage: memoryStorage({ 'atannex.bridge.token': 'TOKEN-SECRET' }) });
    const bridge = createBridge({ baseURL: base, auth, tenant: 7 });
    const error = await bridge.call('x.y', { secret: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeProtocolError);
    expect((error as BridgeProtocolError).code).toBe('UNEXPECTED_REDIRECT');
    expect(seen).toEqual([]);
  });

  it('rejects redirects on session requests and on login', async () => {
    const { origin, seen } = await trap();
    const base = await redirecting(origin);
    const auth = sanctumSession({ cookieJar: memoryCookieJar() });
    const bridge = createBridge({ baseURL: base, auth, tenant: 7 });
    await auth.csrf();
    await expect(bridge.call('x.y')).rejects.toBeInstanceOf(BridgeProtocolError);
    await expect(auth.login({ email: 'a@b.c', password: 'pw' })).rejects.toBeInstanceOf(BridgeProtocolError);
    expect(seen).toEqual([]);
  });

  it('rejects redirected downloads', async () => {
    const { origin, seen } = await trap();
    const base = await redirecting(origin);
    const auth = bearerToken({ storage: memoryStorage({ 'atannex.bridge.token': 'TOKEN-SECRET' }) });
    const bridge = createBridge({ baseURL: base, auth });
    await expect(bridge.download('/bridge/v1/files/abc')).rejects.toBeInstanceOf(BridgeProtocolError);
    expect(seen).toEqual([]);
  });

  it('refuses a response a transport followed to another origin (React Native fetch, XHR)', async () => {
    const followed = fakeFetch(() => {
      const response = json(200, { data: 1, meta: { request_id: 'rrrrrrrr', version: '1' } });
      Object.defineProperty(response, 'url', { value: 'https://evil.test/steal' });
      return response;
    });
    const bridge = createBridge({ baseURL: 'https://api.test', fetch: followed.fetch });
    await expect(bridge.call('x.y')).rejects.toBeInstanceOf(BridgeProtocolError);

    class RedirectedXhr {
      responseURL = 'https://evil.test/steal';
      status = 200;
      responseText = '{"data":1,"meta":{"request_id":"rrrrrrrr","version":"1"}}';
      withCredentials = false;
      responseType = '';
      upload = undefined;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      getAllResponseHeaders() {
        return '';
      }
      send() {
        queueMicrotask(() => this.onload?.());
      }
      abort() {}
    }
    const viaXhr = createBridge({
      baseURL: 'https://api.test',
      transport: xhrTransport({ XMLHttpRequest: RedirectedXhr as unknown as typeof XMLHttpRequest }),
    });
    await expect(viaXhr.call('x.y')).rejects.toBeInstanceOf(BridgeProtocolError);
  });

  it('does not follow a redirect when authorizing a channel', async () => {
    const { origin, seen } = await trap();
    const base = await redirecting(origin);
    const auth = bearerToken({ storage: memoryStorage({ 'atannex.bridge.token': 'TOKEN-SECRET' }) });
    const error = await new Promise((resolve) => {
      echoAuthorizer(auth, { authEndpoint: `${base}/broadcasting/auth` })({ name: 'private-a' }).authorize(
        '1.2',
        (e) => {
          resolve(e);
        },
      );
    });
    expect(error).toBeInstanceOf(Error);
    expect(seen).toEqual([]);
  });
});

describe('#3 download cancellation and timeout cover the body', () => {
  async function trickle(): Promise<string> {
    return serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const timer = setInterval(() => res.write('x'.repeat(1000)), 20);
      req.on('close', () => clearInterval(timer));
    });
  }

  async function readAll(response: Response): Promise<number> {
    const reader = response.body!.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes;
      bytes += value.byteLength;
    }
  }

  it('aborts while the body is being read', async () => {
    const bridge = createBridge({ baseURL: await trickle() });
    const controller = new AbortController();
    const response = await bridge.download('/file', { signal: controller.signal, timeout: 60_000 });
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(readAll(response)).rejects.toBeInstanceOf(BridgeAbortError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times out while the body is being read', async () => {
    const bridge = createBridge({ baseURL: await trickle(), timeout: 150 });
    const response = await bridge.download('/file');
    await expect(readAll(response)).rejects.toBeInstanceOf(BridgeTimeoutError);
  });

  it('still delivers a complete body', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    const response = await createBridge({ baseURL: base }).download('/file');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('#5 interceptors cannot move a request to another origin', () => {
  it('refuses before the auth adapter adds credentials', async () => {
    const { fetch, requests } = fakeFetch(ok(null));
    let prepared = false;
    const bridge = createBridge({
      baseURL: 'https://api.test',
      fetch,
      auth: {
        prepare: () => {
          prepared = true;
        },
      },
      interceptors: {
        request: [
          (request) => {
            request.url = 'https://evil.test/collect';
          },
        ],
      },
    });
    await expect(bridge.call('x.y')).rejects.toThrow(TypeError);
    expect(prepared).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('still allows changes on the same origin', async () => {
    const { fetch, requests } = fakeFetch(ok(null));
    const bridge = createBridge({
      baseURL: 'https://api.test',
      fetch,
      interceptors: { request: [(request) => ({ ...request, url: `${request.url}?trace=1` })] },
    });
    await bridge.call('x.y');
    expect(requests[0]?.url).toBe('https://api.test/bridge/v1/call/x.y?trace=1');
  });
});

describe('#6 maxResponseBytes', () => {
  it('fails on a declared Content-Length over the limit', async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { data: 'x', meta: { request_id: 'rrrrrrrr', version: '1' } }, { 'content-length': '5000' }),
    );
    const error = await createBridge({ baseURL: 'https://api.test', fetch, maxResponseBytes: 1000 })
      .call('x.y')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeProtocolError);
    expect((error as BridgeProtocolError).code).toBe('RESPONSE_TOO_LARGE');
  });

  it('fails on a body over the limit without Content-Length, counting bytes not characters', async () => {
    const { fetch } = fakeFetch(
      () =>
        // 400 three-byte characters: 400 chars, 1200 bytes.
        new Response(JSON.stringify({ data: '€'.repeat(400), meta: { request_id: 'rrrrrrrr', version: '1' } })),
    );
    const bridge = createBridge({ baseURL: 'https://api.test', fetch, maxResponseBytes: 1000 });
    await expect(bridge.call('x.y')).rejects.toBeInstanceOf(BridgeProtocolError);
  });

  it('accepts responses within the limit and has no limit by default', async () => {
    const big = 'a'.repeat(200_000);
    const { fetch } = fakeFetch(ok(big));
    expect(await createBridge({ baseURL: 'https://api.test', fetch }).call('x.y')).toBe(big);
    expect(await createBridge({ baseURL: 'https://api.test', fetch, maxResponseBytes: 300_000 }).call('x.y')).toBe(big);
  });
});
