/**
 * Realtime events over Laravel Echo (Reverb, Pusher or any Echo connector).
 *
 * **Experimental.** Bridge does not run a socket server and does not promise
 * delivery: events missed while disconnected are not replayed. Refetch the
 * data you care about after a reconnect.
 *
 * ```ts
 * import Echo from 'laravel-echo';
 * import Pusher from 'pusher-js';
 * import { createRealtime, echoAuthorizer } from '@atannex/bridge/realtime';
 *
 * const echo = new Echo({ broadcaster: 'reverb', key, wsHost, Pusher,
 *   authorizer: echoAuthorizer(auth, { authEndpoint: `${baseURL}/broadcasting/auth` }) });
 * const realtime = createRealtime<AppBridge>(echo);
 * const sub = realtime.subscribe('orders.updated', { channel: `orders.${userId}`, type: 'private' }, (order) => {});
 * sub.unsubscribe();
 * ```
 *
 * @packageDocumentation
 */
import type { AuthAdapter } from '../authentication/types.js';
import type {
  ChannelType,
  Contract,
  EventChannel,
  EventName,
  EventPayload,
  UntypedContract,
} from '../contracts/types.js';
import type { TransportRequest } from '../transport/types.js';
import { parseJson } from '../protocol/envelope.js';
import { originOf } from '../utilities/url.js';

/** The parts of an Echo channel this adapter uses. */
export interface EchoChannelLike {
  listen(event: string, callback: (payload: never) => void): unknown;
  stopListening(event: string, callback?: (payload: never) => void): unknown;
}

/** The parts of an Echo presence channel this adapter uses. */
export interface EchoPresenceChannelLike extends EchoChannelLike {
  here(callback: (members: never[]) => void): unknown;
  joining(callback: (member: never) => void): unknown;
  leaving(callback: (member: never) => void): unknown;
}

interface PusherConnectionLike {
  state?: string;
  bind(event: string, callback: (states: { previous: string; current: string }) => void): unknown;
  unbind(event: string, callback?: (states: { previous: string; current: string }) => void): unknown;
}

/** The parts of a Laravel Echo instance this adapter uses. */
export interface EchoLike {
  channel(name: string): EchoChannelLike;
  private(name: string): EchoChannelLike;
  join(name: string): EchoPresenceChannelLike;
  leave(name: string): void;
  leaveChannel?(name: string): void;
  connector?: unknown;
}

export interface PresenceHandlers<Member = unknown> {
  here?: (members: Member[]) => void;
  joining?: (member: Member) => void;
  leaving?: (member: Member) => void;
}

export interface SubscribeTarget<T extends ChannelType> {
  /** The channel name as Laravel defines it in routes/channels.php, without `private-` / `presence-`. */
  channel: string;
  /** Must match the event's channel type in the contract. */
  type: T;
  /** Presence channels only. */
  presence?: PresenceHandlers;
}

export interface Subscription {
  unsubscribe(): void;
}

/** Connection states as reported by the Pusher protocol client (Reverb and Pusher). */
export type ConnectionState =
  'initialized' | 'connecting' | 'connected' | 'unavailable' | 'failed' | 'disconnected' | 'unknown';

export interface Realtime<C extends Contract> {
  subscribe<E extends EventName<C>>(
    event: E,
    target: SubscribeTarget<EventChannel<C, E>>,
    handler: (payload: EventPayload<C, E>) => void,
  ): Subscription;
  /** The socket's state, when the connector exposes it. */
  connectionState(): ConnectionState;
  /** Listens for state changes; returns a function that stops listening. */
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  /**
   * Leaves and rejoins every private and presence channel, so they are
   * authorized again. Call after signing in, signing out or switching tenant.
   */
  reauthorize(): void;
  /** Removes every subscription and leaves every channel. */
  disconnectAll(): void;
}

interface Listener {
  event: string;
  handler: (payload: never) => void;
}

interface ChannelEntry {
  type: ChannelType;
  name: string;
  channel: EchoChannelLike;
  listeners: Set<Listener>;
  presence: PresenceHandlers | undefined;
}

const fullName = (type: ChannelType, name: string): string => (type === 'public' ? name : `${type}-${name}`);

function pusherConnection(echo: EchoLike): PusherConnectionLike | undefined {
  const connector = echo.connector as { pusher?: { connection?: PusherConnectionLike } } | undefined;
  const connection = connector?.pusher?.connection;
  return connection !== undefined && typeof connection.bind === 'function' ? connection : undefined;
}

/** Creates a typed realtime client over an existing Echo instance. */
export function createRealtime<C extends Contract = UntypedContract>(echo: EchoLike): Realtime<C> {
  const channels = new Map<string, ChannelEntry>();

  const open = (type: ChannelType, name: string): EchoChannelLike => {
    if (type === 'private') return echo.private(name);
    if (type === 'presence') return echo.join(name);
    return echo.channel(name);
  };

  const attachPresence = (entry: ChannelEntry): void => {
    if (entry.type !== 'presence' || entry.presence === undefined) return;
    const channel = entry.channel as EchoPresenceChannelLike;
    const { here, joining, leaving } = entry.presence;
    if (here !== undefined) channel.here(here);
    if (joining !== undefined) channel.joining(joining);
    if (leaving !== undefined) channel.leaving(leaving);
  };

  const close = (entry: ChannelEntry): void => {
    const key = fullName(entry.type, entry.name);
    if (typeof echo.leaveChannel === 'function') {
      echo.leaveChannel(key);
      return;
    }
    // echo.leave(name) drops the public, private and presence variants at
    // once, so only use it when no other variant is still subscribed.
    const others = [...channels.values()].some((other) => other.name === entry.name && other !== entry);
    if (!others) echo.leave(entry.name);
  };

  const realtime: Realtime<C> = {
    subscribe(event, target, handler) {
      const key = fullName(target.type, target.channel);
      let entry = channels.get(key);
      if (entry === undefined) {
        entry = {
          type: target.type,
          name: target.channel,
          channel: open(target.type, target.channel),
          listeners: new Set(),
          presence: target.presence,
        };
        channels.set(key, entry);
        attachPresence(entry);
      }
      // Bridge events have explicit names (broadcastAs), which Echo wants with a leading dot.
      const listener: Listener = { event: `.${event}`, handler: handler };
      entry.channel.listen(listener.event, listener.handler);
      entry.listeners.add(listener);

      let active = true;
      const current = entry;
      return {
        unsubscribe() {
          if (!active) return;
          active = false;
          current.channel.stopListening(listener.event, listener.handler);
          current.listeners.delete(listener);
          if (current.listeners.size === 0 && channels.get(key) === current) {
            channels.delete(key);
            close(current);
          }
        },
      };
    },

    connectionState() {
      const state = pusherConnection(echo)?.state;
      return (state as ConnectionState | undefined) ?? 'unknown';
    },

    onStateChange(listener) {
      const connection = pusherConnection(echo);
      if (connection === undefined) return () => undefined;
      const callback = (states: { current: string }): void => listener(states.current as ConnectionState);
      connection.bind('state_change', callback);
      return () => connection.unbind('state_change', callback);
    },

    reauthorize() {
      // Entries are updated in place: live Subscription objects hold them.
      for (const entry of channels.values()) {
        if (entry.type === 'public') continue;
        // When close() cannot leave (another variant shares the name), open()
        // hands back the same Echo channel; listening again would double up.
        for (const listener of entry.listeners) entry.channel.stopListening(listener.event, listener.handler);
        close(entry);
        entry.channel = open(entry.type, entry.name);
        attachPresence(entry);
        for (const listener of entry.listeners) entry.channel.listen(listener.event, listener.handler);
      }
    },

    disconnectAll() {
      for (const entry of [...channels.values()]) {
        for (const listener of entry.listeners) entry.channel.stopListening(listener.event, listener.handler);
        entry.listeners.clear();
      }
      const entries = [...channels.values()];
      channels.clear();
      for (const entry of entries) close(entry);
    },
  };
  return realtime;
}

/** Echo's `authorizer` option: a factory per channel. */
export type EchoAuthorizer = (
  channel: { name: string },
  options?: unknown,
) => { authorize(socketId: string, callback: (error: Error | null, data: unknown) => void): void };

export interface EchoAuthorizerOptions {
  /** Usually `${baseURL}/broadcasting/auth`; for bearer tokens the route needs `auth:sanctum` middleware. */
  authEndpoint: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * An Echo `authorizer` that authorizes private and presence channels with the
 * same credentials Bridge calls use (bearer token or session cookie + CSRF).
 */
export function echoAuthorizer(auth: AuthAdapter, options: EchoAuthorizerOptions): EchoAuthorizer {
  return (channel) => ({
    authorize(socketId, callback) {
      void (async () => {
        const request: TransportRequest = {
          url: options.authEndpoint,
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            ...options.headers,
          },
          body: JSON.stringify({ socket_id: socketId, channel_name: channel.name }),
          signal: new AbortController().signal,
        };
        await auth.prepare(request);
        const doFetch = options.fetch ?? globalThis.fetch;
        // Never follow a redirect with the credentials attached.
        const init: RequestInit = {
          method: 'POST',
          headers: request.headers,
          signal: request.signal,
          redirect: 'manual',
        };
        if (request.body !== undefined) init.body = request.body;
        if (request.credentials !== undefined) init.credentials = request.credentials;
        const response = await doFetch(request.url, init);
        const finalOrigin = response.url === '' ? undefined : originOf(response.url);
        if (response.redirected || (finalOrigin !== undefined && finalOrigin !== originOf(request.url))) {
          await response.body?.cancel().catch(() => undefined);
          callback(new Error('Channel authorization was redirected; refusing it.'), null);
          return;
        }
        if (auth.handleResponse !== undefined) await auth.handleResponse(response, request);
        const body = parseJson(await response.text());
        if (!response.ok) {
          callback(new Error(`Channel authorization failed with status ${response.status}.`), null);
          return;
        }
        callback(null, body);
      })().catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error('Channel authorization failed.'), null);
      });
    },
  });
}
