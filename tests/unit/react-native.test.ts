import { describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '@atannex/bridge/realtime';
import {
  connectReactNative,
  isOnline,
  type AppStateLike,
  type NetInfoLike,
  type NetInfoStateLike,
} from '@atannex/bridge/react-native';

/** A stand-in for TanStack's focus/online managers: one listener, replaced on each call. */
function manager<T>(): {
  setEventListener: (setup: (set: (value: T) => void) => (() => void) | undefined) => void;
  values: T[];
  cleanups: number;
} {
  let cleanup: (() => void) | undefined;
  const state = {
    values: [] as T[],
    cleanups: 0,
    setEventListener(setup: (set: (value: T) => void) => (() => void) | undefined) {
      if (cleanup !== undefined) {
        cleanup();
        state.cleanups++;
      }
      cleanup = setup((value) => state.values.push(value));
    },
  };
  return state;
}

function appState(initial = 'active'): AppStateLike & { emit: (s: string) => void; listeners: number } {
  const listeners = new Set<(s: string) => void>();
  return {
    currentState: initial,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit: (s) => listeners.forEach((l) => l(s)),
    get listeners() {
      return listeners.size;
    },
  };
}

function netInfo(): NetInfoLike & { emit: (s: NetInfoStateLike) => void; listeners: number } {
  const listeners = new Set<(s: NetInfoStateLike) => void>();
  return {
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (s) => listeners.forEach((l) => l(s)),
    get listeners() {
      return listeners.size;
    },
  };
}

function socket(): {
  onStateChange: (l: (s: ConnectionState) => void) => () => void;
  emit: (s: ConnectionState) => void;
} {
  const listeners = new Set<(s: ConnectionState) => void>();
  return {
    onStateChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (s) => listeners.forEach((l) => l(s)),
  };
}

describe('connectReactNative', () => {
  it('tells TanStack when the app is focused, starting from the current state', () => {
    const app = appState('active');
    const focus = manager<boolean | undefined>();
    connectReactNative({ appState: app, focusManager: focus });
    app.emit('background');
    app.emit('active');
    expect(focus.values).toEqual([true, false, true]);
  });

  it('reports how long the app was away, from the first inactive or background state', () => {
    vi.useFakeTimers();
    try {
      const app = appState();
      const onResume = vi.fn();
      connectReactNative({ appState: app, onResume });
      app.emit('inactive');
      vi.advanceTimersByTime(2_000);
      app.emit('background');
      vi.advanceTimersByTime(3_000);
      app.emit('active');
      expect(onResume).toHaveBeenCalledWith(5_000);
      app.emit('active');
      expect(onResume).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('feeds NetInfo into the online manager, treating unknown as online', () => {
    const net = netInfo();
    const online = manager<boolean>();
    connectReactNative({ netInfo: net, onlineManager: online });
    net.emit({ isConnected: false });
    net.emit({ isConnected: true, isInternetReachable: false });
    net.emit({ isConnected: true, isInternetReachable: null });
    net.emit({ isConnected: null });
    expect(online.values).toEqual([false, false, true, true]);
    expect(isOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
  });

  it('refetches Bridge queries after the socket comes back, but not on the first connect', () => {
    const rt = socket();
    const queryClient = { invalidateQueries: vi.fn() };
    const onReconnect = vi.fn();
    connectReactNative({ realtime: rt, queryClient, onReconnect });
    rt.emit('connecting');
    rt.emit('connected');
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    rt.emit('unavailable');
    rt.emit('connecting');
    rt.emit('connected');
    rt.emit('connected');
    expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bridge'] });
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('undoes everything it set up, once', () => {
    const app = appState();
    const net = netInfo();
    const rt = socket();
    const focus = manager<boolean | undefined>();
    const online = manager<boolean>();
    const queryClient = { invalidateQueries: vi.fn() };
    const disconnect = connectReactNative({
      appState: app,
      netInfo: net,
      realtime: rt,
      queryClient,
      focusManager: focus,
      onlineManager: online,
    });
    expect([app.listeners, net.listeners]).toEqual([1, 1]);

    disconnect();
    disconnect();
    expect([app.listeners, net.listeners]).toEqual([0, 0]);
    expect([focus.cleanups, online.cleanups]).toEqual([1, 1]);
    const before = focus.values.length;
    app.emit('background');
    rt.emit('disconnected');
    rt.emit('connected');
    expect(focus.values).toHaveLength(before);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
