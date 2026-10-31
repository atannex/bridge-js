import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { createBridge, type Paginated } from '@atannex/bridge';
import {
  getNextPageParam,
  getPreviousPageParam,
  infiniteQueryOptions,
  invalidate,
  mutationOptions,
  queryKey,
  queryOptions,
} from '@atannex/bridge/query';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fakeFetch, json } from '../fixtures/fake-fetch.js';

const page = (current: number, hasMore: boolean) => ({
  items: [{ id: current }],
  pagination: { type: 'length_aware', per_page: 1, current_page: current, has_more: hasMore, total: 2, last_page: 2 },
});

describe('query helpers', () => {
  it('builds stable keys', () => {
    expect(queryKey('products.list', { page: 1 })).toEqual(['bridge', null, 'products.list', { page: 1 }]);
    expect(queryKey('cart.show')).toEqual(['bridge', null, 'cart.show', {}]);
    expect(queryKey('cart.show', {}, '7')).toEqual(['bridge', '7', 'cart.show', {}]);
  });

  it('runs queries through a real QueryClient and passes its abort signal', async () => {
    const { fetch, requests } = fakeFetch((request) =>
      json(200, {
        data: page(JSON.parse(request.body as string).input.page as number, true),
        meta: { request_id: 'r-12345678', version: '1' },
      }),
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations });
    const client = new QueryClient();
    const data = await client.query(queryOptions(bridge, 'products.list', { page: 2 }));
    expect(data.pagination.type).toBe('length_aware');
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(client.getQueryData(['bridge', null, 'products.list', { page: 2 }])).toEqual(data);
  });

  it('builds mutations that call the operation with the given options', async () => {
    const { fetch, requests } = fakeFetch(() =>
      json(200, { data: { items: [], total: '0.00' }, meta: { request_id: 'r-12345678', version: '1' } }),
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations });
    const options = mutationOptions(bridge, 'cart.add', { idempotencyKey: true });
    expect(options.mutationKey).toEqual(['bridge', 'cart.add']);
    await options.mutationFn({ product_id: 1, quantity: 2 });
    await options.mutationFn({ product_id: 1, quantity: 2 });
    expect(requests[0]?.headers['idempotency-key']).toBeDefined();
    // Each mutation gets its own key.
    expect(requests[0]?.headers['idempotency-key']).not.toBe(requests[1]?.headers['idempotency-key']);
  });

  it('invalidates one operation in every scope, one scope, or everything', async () => {
    const client = new QueryClient();
    client.setQueryData(['bridge', '1', 'cart.show', {}], 1);
    client.setQueryData(['bridge', '2', 'cart.show', {}], 1);
    client.setQueryData(['bridge', '1', 'products.list', {}], 2);
    client.setQueryData(['other', 'cart.show'], 3);
    const invalidated = (key: unknown[]) => client.getQueryState(key)?.isInvalidated;

    await invalidate(client, 'cart.show');
    expect(invalidated(['bridge', '1', 'cart.show', {}])).toBe(true);
    expect(invalidated(['bridge', '2', 'cart.show', {}])).toBe(true);
    expect(invalidated(['bridge', '1', 'products.list', {}])).toBe(false);
    expect(invalidated(['other', 'cart.show'])).toBe(false);

    client.setQueryData(['bridge', '2', 'products.list', {}], 2);
    await invalidate(client, undefined, { scope: '2' });
    expect(invalidated(['bridge', '2', 'products.list', {}])).toBe(true);
    expect(invalidated(['bridge', '1', 'products.list', {}])).toBe(false);

    await invalidate(client);
    expect(invalidated(['bridge', '1', 'products.list', {}])).toBe(true);
    expect(invalidated(['other', 'cart.show'])).toBe(false);
  });

  // Regression: keys had no tenant, so switching tenant served the other tenant's cached data.
  it('keeps tenants apart in the cache and sends the tenant the key names', async () => {
    let tenant: number | null = 1;
    const { fetch, requests } = fakeFetch((request) =>
      json(200, {
        data: { team: `team-${request.headers['x-bridge-tenant'] ?? 'none'}`, projects: [] },
        meta: { request_id: 'r-12345678', version: '1' },
      }),
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations, tenant: () => tenant });
    const client = new QueryClient();

    const red = queryOptions(bridge, 'team.projects.list');
    expect(red.queryKey).toEqual(['bridge', '1', 'team.projects.list', {}]);
    tenant = 2;
    const blue = queryOptions(bridge, 'team.projects.list');
    expect(blue.queryKey).toEqual(['bridge', '2', 'team.projects.list', {}]);

    // The tenant is pinned when the options are built, even if it changes before the fetch.
    tenant = null;
    expect((await client.query(red)).team).toBe('team-1');
    expect((await client.query(blue)).team).toBe('team-2');
    expect(requests.map((r) => r.headers['x-bridge-tenant'])).toEqual(['1', '2']);

    expect(queryOptions(bridge, 'team.projects.list', {}, { tenant: 5 }).queryKey[1]).toBe('5');
    expect(queryOptions(bridge, 'team.projects.list', {}, { scope: 'user:9/team:2' }).queryKey[1]).toBe(
      'user:9/team:2',
    );
    expect(infiniteQueryOptions(bridge, 'products.list', {}, { tenant: 3 }).queryKey[1]).toBe('3');
  });

  it('asks for an explicit scope when the tenant is only known asynchronously', () => {
    const bridge = createBridge<AppBridge>({
      baseURL: 'https://api.test',
      fetch: fakeFetch().fetch,
      tenant: async () => 1,
    });
    expect(() => queryOptions(bridge, 'cart.show')).toThrow(/scope/);
    expect(queryOptions(bridge, 'cart.show', {}, { scope: '1' }).queryKey[1]).toBe('1');
  });

  it('computes page parameters for page and cursor pagination', () => {
    expect(getNextPageParam(page(1, true) as never)).toBe(2);
    expect(getNextPageParam(page(2, false) as never)).toBeUndefined();
    expect(getPreviousPageParam(page(2, false) as never)).toBe(1);
    expect(getPreviousPageParam(page(1, true) as never)).toBeUndefined();
    const cursor: Paginated<never> = {
      items: [],
      pagination: { type: 'cursor', per_page: 5, has_more: true, next_cursor: 'n', prev_cursor: null },
    };
    expect(getNextPageParam(cursor)).toBe('n');
    expect(getPreviousPageParam(cursor)).toBeUndefined();
  });

  it('pages through an infinite query', async () => {
    const { fetch, requests } = fakeFetch((request) => {
      const input = JSON.parse(request.body as string).input as { page: number };
      return json(200, { data: page(input.page, input.page < 2), meta: { request_id: 'r-12345678', version: '1' } });
    });
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations });
    const client = new QueryClient();
    const options = infiniteQueryOptions(bridge, 'products.list', { search: 'toghu' });
    const first = await client.infiniteQuery({ ...options, pages: 3 });
    expect(first.pages).toHaveLength(2);
    expect(JSON.parse(requests[1]?.body as string)).toEqual({ input: { search: 'toghu', page: 2 } });
  });

  it('starts cursor queries without a cursor', async () => {
    const { fetch, requests } = fakeFetch(() =>
      json(200, {
        data: {
          items: [],
          pagination: { type: 'cursor', per_page: 5, has_more: false, next_cursor: null, prev_cursor: null },
        },
        meta: { request_id: 'r-12345678', version: '1' },
      }),
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations });
    const options = infiniteQueryOptions(bridge, 'feed.list', {}, { param: 'cursor' });
    expect(options.initialPageParam).toBeNull();
    await new QueryClient().infiniteQuery(options);
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ input: {} });
  });
});
