import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import Echo from 'laravel-echo';
import { describe, expectTypeOf, it } from 'vitest';
import {
  createBridge,
  type BridgeResponse,
  type DownloadLink,
  type EventPayload,
  type Paginated,
} from '@atannex/bridge';
import { infiniteQueryOptions, mutationOptions, queryOptions } from '@atannex/bridge/query';
import { createRealtime, type EchoLike } from '@atannex/bridge/realtime';
import { operations, type AppBridge, type Cart, type Order, type Product } from '../fixtures/contract.js';

const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', operations });

describe('typed calls', () => {
  it('infers outputs', () => {
    expectTypeOf(bridge.call('products.list', { page: 1 })).resolves.toEqualTypeOf<Paginated<Product>>();
    expectTypeOf(bridge.call('orders.show', { id: 1 })).resolves.toEqualTypeOf<Order>();
    expectTypeOf(bridge.callRaw('cart.show')).resolves.toEqualTypeOf<BridgeResponse<Cart>>();
    expectTypeOf(bridge.call('profile.avatar.upload', { avatar: new Blob([]) })).resolves.toExtend<{
      download: DownloadLink;
    }>();
  });

  it('allows leaving out input that has no required keys', () => {
    void bridge.call('cart.show');
    void bridge.call('cart.show', {});
    void bridge.call('products.list');
    void bridge.call('orders.create', {}, { idempotencyKey: true });
  });

  it('rejects unknown operations', () => {
    // @ts-expect-error not an operation in the contract
    void bridge.call('products.delete', { id: 1 });
  });

  it('rejects missing required input', () => {
    // @ts-expect-error input is required
    void bridge.call('products.show');
    // @ts-expect-error quantity is missing
    void bridge.call('cart.add', { product_id: 1 });
  });

  it('rejects wrong input types and unknown keys', () => {
    // @ts-expect-error id must be a number
    void bridge.call('products.show', { id: '1' });
    // @ts-expect-error unknown key
    void bridge.call('products.show', { id: 1, admin: true });
    // @ts-expect-error cart.show takes no input
    void bridge.call('cart.show', { anything: 1 });
    // @ts-expect-error not a file
    void bridge.call('profile.avatar.upload', { avatar: 'file.png' });
  });

  it('accepts React Native style files', () => {
    void bridge.call('profile.avatar.upload', { avatar: { uri: 'file:///a.png', name: 'a.png', type: 'image/png' } });
  });

  it('rejects wrong assumptions about outputs', async () => {
    const product = await bridge.call('products.show', { id: 1 });
    // @ts-expect-error price is a decimal string, not a number
    const price: number = product.price;
    expectTypeOf(price).toBeNumber();
  });

  it('is loosely typed without a contract', () => {
    const untyped = createBridge({ baseURL: 'https://api.test' });
    expectTypeOf(untyped.call('anything.at.all', { x: 1 })).resolves.toBeUnknown();
  });
});

describe('TanStack Query compatibility', () => {
  it('plugs into the real hooks with inferred data', () => {
    // Hooks are only type-checked here, never called.
    expectTypeOf(useQuery(queryOptions(bridge, 'products.show', { id: 1 })).data).toEqualTypeOf<Product | undefined>();
    expectTypeOf(useMutation(mutationOptions(bridge, 'cart.add', { idempotencyKey: true })).mutate)
      .parameter(0)
      .toEqualTypeOf<{ product_id: number; quantity: number }>();
    expectTypeOf(useInfiniteQuery(infiniteQueryOptions(bridge, 'products.list', { search: 'x' })).data).toExtend<
      { pages: Paginated<Product>[] } | undefined
    >();

    // @ts-expect-error products.show needs an id
    queryOptions(bridge, 'products.show');
  });
});

describe('realtime typing', () => {
  it('types payloads and enforces the channel type', () => {
    const realtime = createRealtime<AppBridge>({} as EchoLike);
    realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, (payload) => {
      expectTypeOf(payload).toEqualTypeOf<EventPayload<AppBridge, 'orders.updated'>>();
      expectTypeOf(payload.status).toEqualTypeOf<'pending' | 'paid'>();
    });
    // @ts-expect-error a private event cannot be subscribed on a public channel
    realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'public' }, () => undefined);
    // @ts-expect-error unknown event
    realtime.subscribe('nope', { channel: 'x', type: 'public' }, () => undefined);
  });

  it('accepts a real Laravel Echo instance', () => {
    const echo = new Echo({ broadcaster: 'reverb', key: 'k' });
    createRealtime<AppBridge>(echo);
  });
});
