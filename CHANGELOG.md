# Changelog

All notable changes to `@atannex/bridge` are documented here. The project
follows [Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-11-13

### Added

- `onAttempt` config option: called after every attempt of an operation call
  with its timing, status, error and retry decision (`AttemptEvent`), for
  metrics and tracing. Exceptions it throws are ignored.
- Releases are published from CI with npm provenance (`npm audit signatures`).

### Fixed

- Responses refused before their body was read (redirect, `maxResponseBytes`
  exceeded, a throwing `handleResponse`) now abort the request, so the
  connection is released instead of held until garbage collection. Same for
  `download` and `echoAuthorizer`.
- With a relative `baseURL`, auth requests to an absolute URL on another host
  are refused instead of sent with credentials.
- `currentTenant()` with an async tenant function no longer leaves a rejected
  promise unhandled.
- `queryOptions` / `infiniteQueryOptions` honour a `signal` passed in the call
  options as well as TanStack's.
- `realtime.reauthorize()` no longer binds listeners twice when Echo hands back
  the same channel.
- `download` reports a missing fetch implementation clearly.
- Removing an interceptor removes only that registration, once.
- `bearerToken.user()` on a 401 keeps a token stored meanwhile and calls
  `onSessionExpired`.
- `BridgeServerError.toJSON()` includes `retryAfter`.

### Changed

- Infinite query keys end in `'infinite'`
  (`['bridge', scope, operation, input, 'infinite']`), so they no longer share
  a cache entry with a plain query of the same input. Prefix filters and
  `invalidate` still match both.
- `download` runs request interceptors, with the same origin check as calls.

## 1.0.0 — 2026-10-31

First release, speaking Bridge protocol version 1. Requires `atannex/bridge` 1.0 or later on the server.

- `bearerToken` refreshes tokens: `refresh()`, `expiresAt()`, and automatic
  refresh `refreshBefore` seconds (default 3 days) before the expiry the
  server reports. Needs the server's `POST auth/refresh` endpoint.
- `download(link, { onDownloadProgress })`.
- `@atannex/bridge/react-native`: `connectReactNative()` wires `AppState`,
  NetInfo and realtime reconnects into TanStack Query.
- `createBridge` with typed `call` / `callRaw` from generated contracts, timeouts,
  `AbortSignal`, request and correlation ids, interceptors, tenant and locale headers.
- JSON and multipart encoding (browser `Blob`/`File` and React Native `{ uri, name, type }` files).
- Error classes per HTTP status with type guards; log-safe `toJSON`.
- Retries only for operations the manifest marks `safe`, or `idempotent` with an
  `Idempotency-Key`; exponential backoff with jitter; honours `Retry-After`.
- `sanctumSession` (cookie session + CSRF, Fortify login and two-factor) and
  `bearerToken` (Bridge token endpoint, two-factor challenge, revocation on logout,
  concurrent-401 safe). `memoryCookieJar` for Node; `memoryStorage`.
- `@atannex/bridge/xhr`: XMLHttpRequest transport with upload progress.
- `@atannex/bridge/expo`: Expo SecureStore storage adapter.
- `@atannex/bridge/query`: TanStack Query option builders, keys, invalidation, infinite pagination.
- `@atannex/bridge/realtime` (experimental): typed Laravel Echo subscriptions and an Echo authorizer.
- Query keys carry a scope (`['bridge', scope, operation, input]`), the tenant
  by default, so tenants never share cached data. `invalidate` takes a scope.
- New `maxResponseBytes` option.
- `bridge.currentTenant()`.
- Credentials are never sent across a redirect or to another origin; redirects fail with `UNEXPECTED_REDIRECT`.
