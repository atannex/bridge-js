# Environments

The package is ESM only, has no runtime dependencies, and uses no Node
built-ins, so the same files run in browsers, React Native and Node. A test
fails the build if `src/` or `dist/` ever imports a Node module or uses
`process` or `Buffer`.

## Support matrix

What each runtime needs, and what has been verified:

| Runtime | Needs | Auth | Verified by |
|---------|-------|------|-------------|
| Modern browsers | `fetch`, `AbortController`, `FormData` | `sanctumSession` | Smoke test of the built package in headless Chromium (CI); examples type-check |
| React Native / Expo | Same; RN provides them | `bearerToken` + `expoSecureStore` | See below |
| Node 20, 22, 24 | Built-in `fetch` | `bearerToken`; `sanctumSession` with `memoryCookieJar` | CI matrix (full test suite); integration tests run on Node |
| Node 18 (end-of-life) | Built-in `fetch` | As above | Smoke test of the built package (CI); support ends in 2.0 |
| Bun 1.1, Deno 2.1 | Built-in `fetch` | `bearerToken` | Smoke test of the built package (CI) |
| Next.js | Client components as browsers; server code as Node | See [authentication](authentication.md#nextjs) | Example type-checks |
| Vue / Nuxt | — | `sanctumSession` | Example type-checks |
| Astro | — | `sanctumSession` | Example script type-checks |

What has actually been verified for React Native, and nothing more:

- An integration test loads the built `react-native` entry in Node, with no
  DOM globals, and signs in with a bearer token and calls operations against a
  live Laravel app over HTTP.
- A Metro bundle (`expo export` for android and ios) of an app using the
  package builds on **Expo SDK 58 / React Native 0.88.1**.

No other React Native or Expo version has been tried, and the package has not
run on a device or simulator. Older versions may work; that is untested.

The smoke test (`tests/smoke`) runs the same checks of the built package in
Node, Bun, Deno and Chromium: calls and protocol headers, typed validation
errors, retries with `Retry-After`, timeouts versus cancellation, bearer
tokens, multipart uploads and download progress. It uses an in-memory
`fetch`, so it shows the runtime runs the package, not that it talks to
Laravel; the integration tests do that, on Node.

Not verified: Cloudflare Workers and other edge runtimes. They should work
where `fetch` exists, but nothing tests them.

## Package entry points

| Import | Contents |
|--------|----------|
| `@atannex/bridge` | Client, errors, auth adapters, types |
| `@atannex/bridge/xhr` | `xhrTransport()` with upload progress |
| `@atannex/bridge/query` | TanStack Query helpers |
| `@atannex/bridge/realtime` | Echo adapter (experimental) |
| `@atannex/bridge/expo` | `expoSecureStore()` |
| `@atannex/bridge/react-native` | `connectReactNative()`: app focus, connectivity, realtime reconnects |

Every entry has `types`, `react-native` and `default` conditions. Metro
resolves the `react-native` condition when package exports are enabled; with
them off it uses the top-level `react-native` / `main` fields, which point at
the same file. Subpath imports (`@atannex/bridge/expo`, ...) need package
exports enabled in Metro.

## React Native: focus, connectivity and reconnects

TanStack Query refetches stale queries when the window regains focus and when
the network returns, but React Native has no window events. Connect them once,
at startup:

```ts
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { connectReactNative } from '@atannex/bridge/react-native';

const disconnect = connectReactNative({
  appState: AppState,         // foreground → focusManager
  netInfo: NetInfo,           // connectivity → onlineManager
  focusManager,
  onlineManager,
  realtime,                   // optional: createRealtime(echo)
  queryClient,                // refetch Bridge queries after a socket reconnect
  onResume: (awayMs) => {},   // optional
});
```

- Coming back to the foreground marks the app focused, so stale queries
  refetch. `inactive` (the iOS app switcher) counts as away.
- NetInfo drives TanStack's online state: queries pause offline and refetch
  when the connection returns. "Unknown" counts as online, so a slow
  reachability probe never holds requests back.
- Echo reconnects by itself, but events sent while the socket was down are
  lost. After a dropped connection comes back, every Bridge query is
  invalidated. The first connect does not count.
- Every dependency is optional and passed in; the entry imports nothing from
  React Native, NetInfo or TanStack. NetInfo is a separate install
  (`npx expo install @react-native-community/netinfo`).
- Expiring tokens are handled by `bearerToken` itself (see
  [authentication](authentication.md#mobile-apps-bearer-tokens)).

## React Native notes

- `crypto.randomUUID` is missing without a polyfill. Request ids then come
  from `Math.random`; they are for correlation, not secrecy. Generate
  idempotency keys you persist with a proper random source
  (`expo-crypto`'s `randomUUID`).
- `FormData` takes `{ uri, name, type }` objects; pass those as files.
- Some versions have no `xhr.upload`; progress is then not reported.
- Use `http://10.0.2.2:8000` to reach a Laravel dev server on the host from
  the Android emulator; iOS simulators can use `http://localhost:8000`.
  Release builds need HTTPS (App Transport Security / cleartext rules).

## Offline

Not implemented. An offline queue needs decisions only your app can make:
which operations may wait, how long data may stay on the device and how it is
encrypted, what to do when the server state moved on. A future, opt-in
adapter may help with the mechanics (connectivity, a queue limited to
operations you list, replay with idempotency keys, conflict hooks), but it
will never queue anything by default.

Today, combine TanStack Query's `networkMode` and persisted cache for reads,
and for writes keep your own list of pending actions with their idempotency
keys (see [retries](retries.md#idempotency-keys)).
