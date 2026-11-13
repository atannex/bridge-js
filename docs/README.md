# @atannex/bridge documentation

The TypeScript client for [`atannex/bridge`](https://github.com/atannex/bridge).

1. [The client](client.md): `createBridge`, calling operations, options, interceptors, downloads
2. [Errors](errors.md): classes, codes, type guards, what is safe to log
3. [Authentication](authentication.md): cookie sessions for web apps, bearer tokens for mobile, two-factor
4. [Uploads and downloads](files.md)
5. [Pagination](pagination.md)
6. [TanStack Query](tanstack-query.md)
7. [Retries and idempotency](retries.md)
8. [Realtime (experimental)](realtime.md)
9. [Environments](environments.md): browsers, React Native, Expo, Next.js, Vue, Astro, Node
10. [Testing your app](testing.md)
11. [Troubleshooting](troubleshooting.md)

## What this package is, and is not

It is a communication layer: it turns `bridge.call('orders.create', input)` into
one HTTP request that follows the Bridge protocol, and turns the response into
typed data or a typed error.

It does not validate input on the client (beyond TypeScript's compile-time
checks), does not decide what a user may do, and does not cache data. The
Laravel app validates and authorizes every call; caching belongs to TanStack
Query or whatever state library you use.

## Status of each part

| Part | Status |
|------|--------|
| Core client, errors, JSON + multipart, retries | Stable: follows semver |
| `sanctumSession`, `bearerToken`, `expoSecureStore` | Stable: follows semver |
| `@atannex/bridge/xhr` | Stable: follows semver |
| `@atannex/bridge/query` | Stable: follows semver |
| `@atannex/bridge/realtime` | **Experimental**: API may change in a minor release |
| Offline queue / sync | **Not implemented.** Deferred; see [environments](environments.md#offline) |
