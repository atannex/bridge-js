# @atannex/bridge

[![CI](https://github.com/atannex/bridge-js/actions/workflows/ci.yml/badge.svg)](https://github.com/atannex/bridge-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@atannex/bridge)](https://www.npmjs.com/package/@atannex/bridge)
[![provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)
[![license](https://img.shields.io/npm/l/@atannex/bridge)](LICENSE)

A typed TypeScript client for Laravel apps that use [`atannex/bridge`](https://github.com/atannex/bridge). You register operations in Laravel, generate a contract with `php artisan bridge:generate`, and call them from browsers, React Native, Expo, Node, Bun or Deno with type-checked inputs and outputs. It handles Sanctum cookie sessions and mobile bearer tokens (with two-factor and refresh), safe retries, uploads and downloads with progress, and TanStack Query. No runtime dependencies.

## Install

```bash
npm install @atannex/bridge
```

## Quick start

```ts
import { createBridge, isValidationError } from '@atannex/bridge';
import { operations, type AppBridge } from './generated/bridge'; // from `php artisan bridge:generate`

export const bridge = createBridge<AppBridge>({
  baseURL: 'https://api.example.com',
  operations,
});

try {
  const page = await bridge.call('products.list', { page: 1 }); // typed input and output
} catch (error) {
  if (isValidationError(error)) console.log(error.fields);
}
```

## Why teams use it

- **Typed end to end.** Inputs, outputs and realtime events come from the server's generated contract; a server change that breaks a client fails `tsc`.
- **Safe retries.** Only operations the server marks safe, or idempotent with an `Idempotency-Key`, are ever repeated. Exponential backoff with jitter, `Retry-After` honoured.
- **Credentials stay put.** Redirects are never followed with credentials, nothing is sent to another origin, and interceptors run before tokens are added, so they never see them.
- **Errors you can act on.** One class per failure (`BridgeValidationError`, `BridgeRateLimitError`, ...) with type guards, a protocol `code`, the server's `requestId`, and a log-safe `toJSON()`.
- **Observable.** `onAttempt` reports every attempt's timing, status and retry decision for metrics and tracing; request and correlation ids on every call.
- **Small.** About 5 kB (minified and brotlied) for `createBridge`, checked on every pull request.

## Documentation

1. [The client](docs/client.md): options, interceptors, observability, downloads
2. [Errors](docs/errors.md): classes, codes, type guards, what is safe to log
3. [Authentication](docs/authentication.md): cookie sessions, bearer tokens, two-factor
4. [Uploads and downloads](docs/files.md)
5. [Pagination](docs/pagination.md)
6. [TanStack Query](docs/tanstack-query.md)
7. [Retries and idempotency](docs/retries.md)
8. [Realtime (experimental)](docs/realtime.md)
9. [Environments](docs/environments.md): browsers, React Native, Expo, Next.js, Vue, Astro, Node
10. [Testing your app](docs/testing.md)
11. [Troubleshooting](docs/troubleshooting.md)

## Compatibility

|                     | Supported                                                                   |
| ------------------- | --------------------------------------------------------------------------- |
| Server              | `atannex/bridge` 1.0 or later (Bridge protocol version 1)                   |
| Node                | 20, 22, 24. Node 18 still works in 1.x (smoke-tested) and is dropped in 2.0 |
| Browsers            | Current evergreen browsers (needs `fetch`, `AbortController`, `FormData`)   |
| React Native / Expo | Yes, see [environments](docs/environments.md)                               |
| Bun, Deno           | Bun 1.1+, Deno 2.1+                                                         |
| TypeScript          | 5.0 or later                                                                |

## Versioning and support

The package follows [Semantic Versioning](https://semver.org/). The public API is recorded in [`api/`](api) and checked on every pull request, so a change to it cannot ship unnoticed. `@atannex/bridge/realtime` is experimental and may change in a minor release; everything else is stable.

Only the latest major version gets fixes. Node versions are supported while they are maintained by the Node.js project; dropping one is a major release. Every change is listed in the [changelog](CHANGELOG.md).

Releases are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so you can verify each one was built from this repository: `npm audit signatures`.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Do not open a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project follows a [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
