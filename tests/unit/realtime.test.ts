import { describe, expect, it, vi } from 'vitest';
import { bearerToken, memoryStorage } from '@atannex/bridge';
import { createRealtime, echoAuthorizer, type EchoLike } from '@atannex/bridge/realtime';
import type { AppBridge } from '../fixtures/contract.js';
import { fakeFetch, json } from '../fixtures/fake-fetch.js';

type Handler = (payload: never) => void;

class FakeChannel {
  listeners = new Map<string, Set<Handler>>();
  presence: Record<string, unknown> = {};
  constructor(readonly name: string) {}
  listen(event: string, handler: Handler) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return this;
  }
  stopListening(event: string, handler?: Handler) {
    if (handler === undefined) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(handler);
    return this;
  }
  here(cb: unknown) {
    this.presence['here'] = cb;
    return this;
  }
  joining(cb: unknown) {
    this.presence['joining'] = cb;
    return this;
  }
  leaving(cb: unknown) {
    this.presence['leaving'] = cb;
    return this;
  }
  emit(event: string, payload: unknown) {
    for (const handler of this.listeners.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

function fakeEcho(withLeaveChannel = true) {
  const opened: string[] = [];
  const left: string[] = [];
  const channels = new Map<string, FakeChannel>();
  const stateBindings = new Set<(s: { previous: string; current: string }) => void>();
  const get = (full: string) => {
    opened.push(full);
    const channel = new FakeChannel(full);
    channels.set(full, channel);
    return channel;
  };
  const echo: EchoLike & { opened: string[]; left: string[]; channels: Map<string, FakeChannel> } = {
    opened,
    left,
    channels,
    channel: (name) => get(name),
    private: (name) => get(`private-${name}`),
    join: (name) => get(`presence-${name}`),
    leave: (name) => void left.push(`leave:${name}`),
    connector: {
      pusher: {
        connection: {
          state: 'connected',
          bind: (_e: string, cb: (s: { previous: string; current: string }) => void) => stateBindings.add(cb),
          unbind: (_e: string, cb: (s: { previous: string; current: string }) => void) => stateBindings.delete(cb),
        },
      },
    },
  };
  if (withLeaveChannel) echo.leaveChannel = (name) => void left.push(name);
  return { echo, stateBindings };
}

describe('createRealtime', () => {
  it('subscribes with a leading dot and delivers typed payloads', () => {
    const { echo } = fakeEcho();
    const realtime = createRealtime<AppBridge>(echo);
    const handler = vi.fn();
    realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, handler);
    expect(echo.opened).toEqual(['private-orders.1']);
    echo.channels.get('private-orders.1')?.emit('.orders.updated', { id: 1, status: 'paid' });
    expect(handler).toHaveBeenCalledWith({ id: 1, status: 'paid' });
  });

  it('shares a channel between subscriptions and leaves after the last one', () => {
    const { echo } = fakeEcho();
    const realtime = createRealtime<AppBridge>(echo);
    const a = realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, () => undefined);
    const b = realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, () => undefined);
    expect(echo.opened).toHaveLength(1);
    a.unsubscribe();
    a.unsubscribe();
    expect(echo.left).toEqual([]);
    b.unsubscribe();
    expect(echo.left).toEqual(['private-orders.1']);
  });

  it('without leaveChannel, only leaves a name when no other variant uses it', () => {
    const { echo } = fakeEcho(false);
    const realtime = createRealtime<AppBridge>(echo);
    const pub = realtime.subscribe('products.restocked', { channel: 'shop', type: 'public' }, () => undefined);
    const priv = realtime.subscribe('orders.updated', { channel: 'shop', type: 'private' }, () => undefined);
    pub.unsubscribe();
    expect(echo.left).toEqual([]);
    priv.unsubscribe();
    expect(echo.left).toEqual(['leave:shop']);
  });

  it('joins presence channels and wires presence handlers', () => {
    const { echo } = fakeEcho();
    const realtime = createRealtime<AppBridge>(echo);
    const here = vi.fn();
    realtime.subscribe('room.message', { channel: 'room.7', type: 'presence', presence: { here } }, () => undefined);
    expect(echo.opened).toEqual(['presence-room.7']);
    expect(echo.channels.get('presence-room.7')?.presence['here']).toBe(here);
  });

  it('re-authorizes private channels and keeps listeners', () => {
    const { echo } = fakeEcho();
    const realtime = createRealtime<AppBridge>(echo);
    const handler = vi.fn();
    const sub = realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, handler);
    realtime.subscribe('products.restocked', { channel: 'shop', type: 'public' }, () => undefined);
    realtime.reauthorize();
    expect(echo.left).toEqual(['private-orders.1']);
    expect(echo.opened).toEqual(['private-orders.1', 'shop', 'private-orders.1']);
    echo.channels.get('private-orders.1')?.emit('.orders.updated', { id: 2, status: 'pending' });
    expect(handler).toHaveBeenCalledOnce();
    sub.unsubscribe();
    expect(echo.left).toEqual(['private-orders.1', 'private-orders.1']);
  });

  it('reports connection state and changes', () => {
    const { echo, stateBindings } = fakeEcho();
    const realtime = createRealtime<AppBridge>(echo);
    expect(realtime.connectionState()).toBe('connected');
    const listener = vi.fn();
    const stop = realtime.onStateChange(listener);
    for (const cb of stateBindings) cb({ previous: 'connected', current: 'unavailable' });
    expect(listener).toHaveBeenCalledWith('unavailable');
    stop();
    expect(stateBindings.size).toBe(0);
    expect(createRealtime({ ...echo, connector: undefined }).connectionState()).toBe('unknown');
  });

  it('disconnects everything', () => {
    const { echo } = fakeEcho();
    const realtime = createRealtime<AppBridge>(echo);
    realtime.subscribe('orders.updated', { channel: 'orders.1', type: 'private' }, () => undefined);
    realtime.subscribe('products.restocked', { channel: 'shop', type: 'public' }, () => undefined);
    realtime.disconnectAll();
    expect(echo.left.sort()).toEqual(['private-orders.1', 'shop']);
  });
});

describe('echoAuthorizer', () => {
  it('authorizes channels with the bearer token', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, { auth: 'key:signature' }));
    const auth = bearerToken({ storage: memoryStorage({ 'atannex.bridge.token': 'tok' }) });
    const authorizer = echoAuthorizer(auth, { authEndpoint: 'https://api.test/broadcasting/auth', fetch });
    const result = await new Promise((resolve) => {
      authorizer({ name: 'private-orders.1' }).authorize('123.456', (error, data) => resolve({ error, data }));
    });
    expect(result).toEqual({ error: null, data: { auth: 'key:signature' } });
    expect(requests[0]?.headers['authorization']).toBe('Bearer tok');
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ socket_id: '123.456', channel_name: 'private-orders.1' });
  });

  it('reports refusals as errors', async () => {
    const { fetch } = fakeFetch(() => json(403, { message: 'no' }));
    const auth = bearerToken({ storage: memoryStorage() });
    const authorizer = echoAuthorizer(auth, { authEndpoint: 'https://api.test/broadcasting/auth', fetch });
    const error = await new Promise((resolve) => {
      authorizer({ name: 'private-orders.2' }).authorize('1.2', (e) => resolve(e));
    });
    expect(error).toBeInstanceOf(Error);
  });
});
