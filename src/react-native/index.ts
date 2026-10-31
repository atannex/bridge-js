/**
 * App lifecycle and connectivity wiring for React Native and Expo.
 *
 * TanStack Query refetches on window focus and on reconnect, but React Native
 * has no window events: without this, queries never refetch when the app
 * comes back to the foreground or the network returns. `connectReactNative`
 * feeds `AppState` and NetInfo into TanStack's managers, and refetches Bridge
 * queries when the realtime socket reconnects (events sent while it was down
 * are not replayed).
 *
 * ```ts
 * // AppState comes from React Native, NetInfo from @react-native-community/netinfo,
 * // focusManager and onlineManager from @tanstack/react-query.
 * import { connectReactNative } from '@atannex/bridge/react-native';
 *
 * const disconnect = connectReactNative({ appState: AppState, netInfo: NetInfo,
 *   focusManager, onlineManager, queryClient, realtime });
 * ```
 *
 * Every dependency is optional and passed in, so this entry imports nothing
 * from React Native, NetInfo or TanStack itself.
 *
 * @packageDocumentation
 */
import { invalidate, type InvalidatingClient } from '../query/index.js';
import type { ConnectionState } from '../realtime/index.js';

/** The parts of React Native's `AppState` this uses. */
export interface AppStateLike {
  currentState?: string | null;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/** The parts of a NetInfo state this uses. `null` means not known yet. */
export interface NetInfoStateLike {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

/** The parts of `@react-native-community/netinfo` this uses. */
export interface NetInfoLike {
  addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
}

/** TanStack's `focusManager`. */
export interface FocusManagerLike {
  setEventListener(setup: (setFocused: (focused?: boolean) => void) => (() => void) | undefined): void;
}

/** TanStack's `onlineManager`. */
export interface OnlineManagerLike {
  setEventListener(setup: (setOnline: (online: boolean) => void) => (() => void) | undefined): void;
}

/** A realtime client from `createRealtime`, or anything reporting socket states. */
export interface ConnectionStateSource {
  onStateChange(listener: (state: ConnectionState) => void): () => void;
}

export interface ReactNativeOptions {
  appState?: AppStateLike;
  netInfo?: NetInfoLike;
  focusManager?: FocusManagerLike;
  onlineManager?: OnlineManagerLike;
  /** Bridge queries in it are refetched after the realtime socket reconnects. */
  queryClient?: InvalidatingClient;
  realtime?: ConnectionStateSource;
  /** Called when the app returns to the foreground, with how long it was away in ms. */
  onResume?: (awayMs: number) => void;
  /** Called after the realtime socket comes back from a dropped connection. */
  onReconnect?: () => void;
}

/** Whether a NetInfo state counts as online. Unknown (`null`) counts as online, so a slow probe never blocks requests. */
export function isOnline(state: NetInfoStateLike): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/**
 * Connects app lifecycle, network state and realtime reconnects to TanStack
 * Query. Returns a function that undoes it; TanStack's managers are left
 * with no listener (React Native has no default one) and keep their last state.
 */
export function connectReactNative(options: ReactNativeOptions): () => void {
  const cleanups: (() => void)[] = [];

  if (options.appState !== undefined && (options.focusManager !== undefined || options.onResume !== undefined)) {
    const appState = options.appState;
    let hiddenAt: number | undefined;
    let setFocused: ((focused?: boolean) => void) | undefined;
    const subscription = appState.addEventListener('change', (state) => {
      if (state === 'active') {
        setFocused?.(true);
        if (hiddenAt !== undefined) options.onResume?.(Date.now() - hiddenAt);
        hiddenAt = undefined;
      } else {
        // 'inactive' (iOS app switcher, a system sheet) and 'background' both
        // count as away; the first of them starts the clock.
        setFocused?.(false);
        hiddenAt ??= Date.now();
      }
    });
    cleanups.push(() => subscription.remove());
    if (options.focusManager !== undefined) {
      const manager = options.focusManager;
      manager.setEventListener((handler) => {
        setFocused = handler;
        if (appState.currentState != null) handler(appState.currentState === 'active');
        return () => {
          setFocused = undefined;
        };
      });
      cleanups.push(() => manager.setEventListener(() => undefined));
    }
  }

  if (options.netInfo !== undefined && options.onlineManager !== undefined) {
    const netInfo = options.netInfo;
    const manager = options.onlineManager;
    manager.setEventListener((setOnline) => netInfo.addEventListener((state) => setOnline(isOnline(state))));
    cleanups.push(() => manager.setEventListener(() => undefined));
  }

  if (options.realtime !== undefined) {
    let dropped = false;
    const stop = options.realtime.onStateChange((state) => {
      if (state === 'connected') {
        // The first connect is not a reconnect: nothing was missed yet.
        if (!dropped) return;
        dropped = false;
        if (options.queryClient !== undefined) void invalidate(options.queryClient);
        options.onReconnect?.();
      } else if (state === 'unavailable' || state === 'disconnected' || state === 'failed') {
        dropped = true;
      }
    });
    cleanups.push(stop);
  }

  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
