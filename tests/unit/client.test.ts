import { describe, expect, it, vi } from 'vitest';
import {
  BridgeAuthorizationError,
  BridgeProtocolError,
  BridgeValidationError,
  createBridge,
  type Bridge,
  type BridgeError,
} from '@atannex/bridge';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fail, fakeFetch, json, ok } from '../fixtures/fake-fetch.js';

const ID = /^[A-Za-z0-9._:-]{8,128}$/;

function client(
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof createBridge>[0]> = {},
): Bridge<AppBridge> {
  return createBridge<AppBridge>({ baseURL: 'https://api.test/', fetch, operations, ...extra });
}

describe('createBridge', () => {
  it('requires a baseURL', () => {
    expect(() => createBridge({ baseURL: '' })).toThrow(TypeError);
  });

  it('posts the input in an envelope to the call endpoint with protocol headers', async () => {
    const { fetch, requests } = fakeFetch(
      ok({ id: 1, name: 'Toghu', price: '12.50', created_at: '2026-10-30T00:00:00+00:00' }),
    );
    const product = await client(fetch).call('products.show', { id: 1 });

    expect(product.name).toBe('Toghu');
    const [request] = requests;
    expect(request?.url).toBe('https://api.test/bridge/v1/call/products.show');
    expect(request?.method).toBe('POST');
    expect(request?.body).toBe('{"input":{"id":1}}');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['accept']).toBe('application/json');
    expect(request?.headers['x-bridge-version']).toBe('1');
    expect(request?.headers['x-request-id']).toMatch(ID);
    expect(request?.headers['x-correlation-id']).toMatch(ID);
    expect(request?.headers['idempotency-key']).toBeUndefined();
    expect(request?.headers['x-bridge-tenant']).toBeUndefined();
  });

  it('sends {} when the input is left out', async () => {
    const { fetch, requests } = fakeFetch(ok({ items: [], total: '0.00' }));
    await client(fetch).call('cart.show');
    expect(requests[0]?.body).toBe('{"input":{}}');
  });

  it('honours a custom prefix', async () => {
    const { fetch, requests } = fakeFetch(ok(null));
    await createBridge({ baseURL: 'https://api.test/app', prefix: '/rpc/v1/', fetch }).call('ping');
    expect(requests[0]?.url).toBe('https://api.test/app/rpc/v1/call/ping');
  });

  it('sends client, locale, tenant and static/async headers', async () => {
    const { fetch, requests } = fakeFetch(ok({ team: 'red', projects: [] }));
    const bridge = client(fetch, {
      client: 'shop-app/1.2.0',
      locale: () => 'fr',
      tenant: async () => 1,
      headers: async () => ({ 'X-Custom': 'yes' }),
    });
    await bridge.call('team.projects.list');
    expect(requests[0]?.headers).toMatchObject({
      'x-bridge-client': 'shop-app/1.2.0',
      'accept-language': 'fr',
      'x-bridge-tenant': '1',
      'x-custom': 'yes',
    });
  });

  it('lets a call override or drop the tenant', async () => {
    const { fetch, requests } = fakeFetch(ok({ team: 'blue', projects: [] }));
    const bridge = client(fetch, { tenant: 1 });
    await bridge.call('team.projects.list', {}, { tenant: 2 });
    await bridge.call('team.projects.list', {}, { tenant: null });
    expect(requests[0]?.headers['x-bridge-tenant']).toBe('2');
    expect(requests[1]?.headers['x-bridge-tenant']).toBeUndefined();
  });

  it('truncates the client header to 64 characters', async () => {
    const { fetch, requests } = fakeFetch(ok(null));
    await client(fetch, { client: 'x'.repeat(100) }).call('cart.show');
    expect(requests[0]?.headers['x-bridge-client']).toHaveLength(64);
  });

  it('rejects operation names the protocol does not allow, before any request', async () => {
    const { fetch, requests } = fakeFetch(ok(null));
    const bridge = createBridge({ baseURL: 'https://api.test', fetch });
    await expect(bridge.call('../admin')).rejects.toThrow(TypeError);
    await expect(bridge.call('Products.List')).rejects.toThrow(TypeError);
    await expect(bridge.call('a'.repeat(121))).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it('sends a given idempotency key and validates it', async () => {
    const { fetch, requests } = fakeFetch(ok({ items: [], total: '0.00' }));
    const bridge = client(fetch);
    await bridge.call('cart.add', { product_id: 1, quantity: 1 }, { idempotencyKey: 'order-key-0001' });
    expect(requests[0]?.headers['idempotency-key']).toBe('order-key-0001');
    await expect(bridge.call('cart.add', { product_id: 1, quantity: 1 }, { idempotencyKey: 'short' })).rejects.toThrow(
      TypeError,
    );
  });

  it('generates an idempotency key on request', async () => {
    const { fetch, requests } = fakeFetch(ok({ items: [], total: '0.00' }));
    await client(fetch).call('cart.add', { product_id: 1, quantity: 1 }, { idempotencyKey: true });
    expect(requests[0]?.headers['idempotency-key']).toMatch(ID);
  });

  it('returns data and meta from callRaw', async () => {
    const { fetch } = fakeFetch(
      ok({ id: 9 }, { operation: 'orders.show', idempotent_replay: true }, { 'x-request-id': 'req-12345678' }),
    );
    const response = await client(fetch).callRaw('orders.show', { id: 9 });
    expect(response.status).toBe(200);
    expect(response.meta).toMatchObject({ request_id: 'req-12345678', version: '1', idempotent_replay: true });
    expect(response.headers.get('x-request-id')).toBe('req-12345678');
  });

  it('throws a protocol error when a 2xx body is not an envelope', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>ok</html>', { status: 200 }));
    await expect(client(fetch).call('cart.show')).rejects.toBeInstanceOf(BridgeProtocolError);
    const { fetch: fetch2 } = fakeFetch(() => json(200, { data: 1 }));
    await expect(client(fetch2).call('cart.show')).rejects.toBeInstanceOf(BridgeProtocolError);
  });

  it('maps failures to errors carrying the request id and operation', async () => {
    const { fetch } = fakeFetch(
      fail(422, 'VALIDATION_FAILED', { quantity: ['The quantity field must be at least 1.'] }),
    );
    const error = (await client(fetch)
      .call('cart.add', { product_id: 1, quantity: 0 })
      .catch((e: unknown) => e)) as BridgeValidationError;
    expect(error).toBeInstanceOf(BridgeValidationError);
    expect(error.requestId).toBe('req-err-1234');
    expect(error.operation).toBe('cart.add');
    expect(error.first('quantity')).toBe('The quantity field must be at least 1.');
  });

  it('reports deprecation once per operation', async () => {
    const { fetch } = fakeFetch(
      ok({ users: 1, orders: 2 }, { deprecated: { message: 'Use admin.dashboard instead.' } }),
    );
    const onDeprecated = vi.fn();
    const bridge = client(fetch, { onDeprecated });
    await bridge.call('admin.stats');
    await bridge.call('admin.stats');
    expect(onDeprecated).toHaveBeenCalledOnce();
    expect(onDeprecated).toHaveBeenCalledWith('admin.stats', 'Use admin.dashboard instead.');
  });

  it('builds URLs under the prefix', () => {
    const bridge = createBridge({ baseURL: 'https://api.test/', fetch: fakeFetch().fetch });
    expect(bridge.url('/health')).toBe('https://api.test/bridge/v1/health');
    expect(bridge.prefix).toBe('bridge/v1');
    expect(bridge.baseURL).toBe('https://api.test');
  });
});

describe('interceptors', () => {
  it('runs request interceptors before auth, so they never see the token', async () => {
    const { fetch, requests } = fakeFetch(ok({ items: [], total: '0.00' }));
    const seen: Record<string, string>[] = [];
    const bridge = client(fetch, {
      auth: { prepare: (request) => void (request.headers['authorization'] = 'Bearer secret') },
      interceptors: {
        request: [
          (request, context) => {
            seen.push({ ...request.headers });
            request.headers['x-attempt'] = String(context.attempt);
          },
        ],
      },
    });
    await bridge.call('cart.show');
    expect(seen[0]?.['authorization']).toBeUndefined();
    expect(requests[0]?.headers['x-attempt']).toBe('1');
    expect(requests[0]?.headers['authorization']).toBe('Bearer secret');
  });

  it('lets response interceptors replace the response and can be removed', async () => {
    const { fetch } = fakeFetch(ok({ items: [], total: '0.00' }));
    const bridge = client(fetch);
    const remove = bridge.interceptors.response.use((response) => ({ ...response, data: { replaced: true } }));
    expect(await bridge.call('cart.show')).toEqual({ replaced: true });
    remove();
    expect(await bridge.call('cart.show')).toEqual({ items: [], total: '0.00' });
  });

  it('runs error interceptors once on the final error and lets them replace it', async () => {
    const { fetch } = fakeFetch(fail(403, 'FORBIDDEN'));
    const interceptor = vi.fn((error: BridgeError) => {
      expect(error).toBeInstanceOf(BridgeAuthorizationError);
      return new BridgeAuthorizationError({ code: 'FORBIDDEN', message: 'Nope', status: 403 });
    });
    const bridge = client(fetch, { interceptors: { error: [interceptor] } });
    await expect(bridge.call('admin.stats')).rejects.toThrow('Nope');
    expect(interceptor).toHaveBeenCalledOnce();
  });
});

describe('download', () => {
  it('fetches a same-origin link with the auth adapter credentials', async () => {
    const { fetch, requests } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const bridge = client(fetch, { auth: { prepare: (r) => void (r.headers['authorization'] = 'Bearer t0k3n') } });
    const response = await bridge.download({
      url: 'https://api.test/bridge/v1/files/abc',
      name: 'a.png',
      expires_at: '2026-10-30T00:00:00+00:00',
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.headers['authorization']).toBe('Bearer t0k3n');
  });

  it('refuses to send credentials to another origin', async () => {
    const { fetch, requests } = fakeFetch(() => new Response('x'));
    const bridge = client(fetch, { auth: { prepare: (r) => void (r.headers['authorization'] = 'Bearer t0k3n') } });
    await expect(bridge.download('https://evil.test/steal')).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
    await bridge.download('https://cdn.test/file', { withCredentials: false });
    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('reports download progress as the body is read', async () => {
    const chunks = [new Uint8Array(4), new Uint8Array(6)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    });
    const { fetch } = fakeFetch(() => new Response(body, { status: 200, headers: { 'content-length': '10' } }));
    const progress: unknown[] = [];
    const response = await client(fetch).download('/bridge/v1/files/abc', {
      onDownloadProgress: (p) => progress.push(p),
    });
    expect((await response.arrayBuffer()).byteLength).toBe(10);
    expect(progress).toEqual([
      { loaded: 4, total: 10 },
      { loaded: 10, total: 10 },
    ]);
  });

  it('leaves the total unknown for a compressed body', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(new Uint8Array(8), {
          status: 200,
          headers: { 'content-length': '3', 'content-encoding': 'gzip' },
        }),
    );
    const progress: { loaded: number; total: number | undefined }[] = [];
    const response = await client(fetch).download('/bridge/v1/files/abc', {
      onDownloadProgress: (p) => progress.push(p),
    });
    await response.arrayBuffer();
    expect(progress.at(-1)).toEqual({ loaded: 8, total: undefined });
  });

  it('maps a failed download to a Bridge error', async () => {
    const { fetch } = fakeFetch(fail(403, 'FORBIDDEN'));
    await expect(client(fetch).download('/bridge/v1/files/abc')).rejects.toBeInstanceOf(BridgeAuthorizationError);
  });
});
