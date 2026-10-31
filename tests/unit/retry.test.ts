import { describe, expect, it } from 'vitest';
import {
  BridgeAbortError,
  BridgeConflictError,
  BridgeNetworkError,
  BridgeRateLimitError,
  BridgeServerError,
  BridgeTimeoutError,
  createBridge,
  mayRepeat,
} from '@atannex/bridge';
import { retryDelay, DEFAULT_RETRY } from '../../src/client/retry.js';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fail, fakeFetch, hang, networkDown, ok } from '../fixtures/fake-fetch.js';

const fast = { attempts: 3, baseDelay: 1, maxDelay: 2 };

function client(fetch: typeof globalThis.fetch, withManifest = true) {
  return createBridge<AppBridge>({
    baseURL: 'https://api.test',
    fetch,
    retry: fast,
    ...(withManifest ? { operations } : {}),
  });
}

const cart = { items: [], total: '0.00' };

describe('retries', () => {
  it('retries a safe operation after a network error', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    expect(await client(fetch).call('cart.show')).toEqual(cart);
    expect(requests).toHaveLength(2);
    // A new request id per attempt, one correlation id per call.
    expect(requests[0]?.headers['x-request-id']).not.toBe(requests[1]?.headers['x-request-id']);
    expect(requests[0]?.headers['x-correlation-id']).toBe(requests[1]?.headers['x-correlation-id']);
  });

  it.each([502, 503, 504])('retries a safe operation after %i', async (status) => {
    const { fetch, requests } = fakeFetch(fail(status, 'SERVICE_UNAVAILABLE'), ok(cart));
    await client(fetch).call('cart.show');
    expect(requests).toHaveLength(2);
  });

  it('does not retry 500', async () => {
    const { fetch, requests } = fakeFetch(fail(500, 'INTERNAL_ERROR'), ok(cart));
    await expect(client(fetch).call('cart.show')).rejects.toBeInstanceOf(BridgeServerError);
    expect(requests).toHaveLength(1);
  });

  it('gives up after the configured number of attempts', async () => {
    const { fetch, requests } = fakeFetch(networkDown);
    await expect(client(fetch).call('cart.show')).rejects.toBeInstanceOf(BridgeNetworkError);
    expect(requests).toHaveLength(3);
  });

  it('honours Retry-After on 429', async () => {
    const { fetch, requests } = fakeFetch(
      fail(429, 'RATE_LIMITED', { retry_after: 0 }, { 'retry-after': '0' }),
      ok(cart),
    );
    await client(fetch).call('cart.show');
    expect(requests).toHaveLength(2);
  });

  it('fails at once when Retry-After is longer than maxRetryAfter', async () => {
    const { fetch, requests } = fakeFetch(fail(429, 'RATE_LIMITED', { retry_after: 120 }), ok(cart));
    const error = await client(fetch)
      .call('cart.show')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeRateLimitError);
    expect((error as BridgeRateLimitError).retryAfter).toBe(120);
    expect(requests).toHaveLength(1);
  });

  it('never retries an unsafe operation', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    await expect(client(fetch).call('cart.remove', { product_id: 1 })).rejects.toBeInstanceOf(BridgeNetworkError);
    expect(requests).toHaveLength(1);
  });

  it('never retries an unsafe operation even with an idempotency key', async () => {
    const { fetch, requests } = fakeFetch(fail(503, 'SERVICE_UNAVAILABLE'), ok(cart));
    await expect(client(fetch).call('cart.remove', { product_id: 1 }, { idempotencyKey: true })).rejects.toBeInstanceOf(
      BridgeServerError,
    );
    expect(requests).toHaveLength(1);
  });

  it('does not retry an idempotent operation without a key', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    await expect(client(fetch).call('cart.add', { product_id: 1, quantity: 1 })).rejects.toBeInstanceOf(
      BridgeNetworkError,
    );
    expect(requests).toHaveLength(1);
  });

  it('retries an idempotent operation with a key, reusing the key', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    await client(fetch).call('cart.add', { product_id: 1, quantity: 1 }, { idempotencyKey: true });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers['idempotency-key']).toBeDefined();
    expect(requests[0]?.headers['idempotency-key']).toBe(requests[1]?.headers['idempotency-key']);
  });

  it('does not retry anything when there is no manifest', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    await expect(client(fetch, false).call('cart.show')).rejects.toBeInstanceOf(BridgeNetworkError);
    expect(requests).toHaveLength(1);
  });

  it('can be switched off per call', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    await expect(client(fetch).call('cart.show', {}, { retry: false })).rejects.toBeInstanceOf(BridgeNetworkError);
    expect(requests).toHaveLength(1);
  });

  it('does not retry client errors', async () => {
    const { fetch, requests } = fakeFetch(fail(409, 'IDEMPOTENCY_IN_PROGRESS'), ok(cart));
    await expect(
      client(fetch).call('cart.add', { product_id: 1, quantity: 1 }, { idempotencyKey: true }),
    ).rejects.toBeInstanceOf(BridgeConflictError);
    expect(requests).toHaveLength(1);
  });

  it('stops waiting when the caller aborts during backoff', async () => {
    const { fetch, requests } = fakeFetch(networkDown, ok(cart));
    const controller = new AbortController();
    const bridge = createBridge<AppBridge>({
      baseURL: 'https://api.test',
      fetch,
      operations,
      retry: { attempts: 3, baseDelay: 10_000, maxDelay: 10_000 },
    });
    const pending = bridge.call('cart.show', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(BridgeAbortError);
    expect(requests).toHaveLength(1);
  });

  it('retries timeouts of safe operations', async () => {
    const { fetch, requests } = fakeFetch(hang, ok(cart));
    const bridge = createBridge<AppBridge>({
      baseURL: 'https://api.test',
      fetch,
      operations,
      retry: fast,
      timeout: 20,
    });
    expect(await bridge.call('cart.show')).toEqual(cart);
    expect(requests).toHaveLength(2);
  });
});

describe('retry policy helpers', () => {
  it('only allows repeats of safe operations, or idempotent ones with a key', () => {
    expect(mayRepeat('safe', false)).toBe(true);
    expect(mayRepeat('idempotent', true)).toBe(true);
    expect(mayRepeat('idempotent', false)).toBe(false);
    expect(mayRepeat('unsafe', true)).toBe(false);
    expect(mayRepeat(undefined, true)).toBe(false);
  });

  it('backs off exponentially with jitter, capped at maxDelay', () => {
    const policy = { ...DEFAULT_RETRY, attempts: 10, baseDelay: 100, maxDelay: 1000 };
    const error = new BridgeNetworkError({ code: 'NETWORK_ERROR', message: 'x' });
    expect(retryDelay(error, 1, policy, () => 0)).toBe(50);
    expect(retryDelay(error, 1, policy, () => 1)).toBe(100);
    expect(retryDelay(error, 3, policy, () => 1)).toBe(400);
    expect(retryDelay(error, 8, policy, () => 1)).toBe(1000);
    expect(retryDelay(error, 10, policy)).toBeUndefined();
  });

  it('respects retryTimeouts: false', () => {
    const error = new BridgeTimeoutError({ code: 'TIMEOUT', message: 'x' });
    expect(retryDelay(error, 1, { ...DEFAULT_RETRY, retryTimeouts: false })).toBeUndefined();
  });
});
