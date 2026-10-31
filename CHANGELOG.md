# Changelog

All notable changes to `@atannex/bridge` are documented here. The project
follows [Semantic Versioning](https://semver.org/).

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
