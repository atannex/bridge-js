# The client

## Creating one

```ts
import { createBridge } from '@atannex/bridge';
import { operations, type AppBridge } from './generated/bridge';

export const bridge = createBridge<AppBridge>({
  baseURL: 'https://api.example.com',
  operations,
});
```

`AppBridge` and `operations` come from `php artisan bridge:generate` in your
Laravel app. Commit the generated file, and run `bridge:generate --check` in CI
so it never drifts from the server.

Create one client per API and share it. It holds no per-request state.

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `baseURL` | required | Where Laravel runs, e.g. `https://api.example.com` |
| `prefix` | `bridge/v1` | Route prefix configured on the server (`bridge.prefix`) |
| `operations` | none | The generated manifest. Without it nothing is ever retried |
| `auth` | none | `sanctumSession()`, `bearerToken()` or your own adapter |
| `timeout` | `15000` | Per attempt, in ms. `0` or `Infinity` turns it off |
| `retry` | `{ attempts: 3 }` | See [retries](retries.md). `false` turns retries off |
| `headers` | none | Object, or (async) function returning one, sent on every request |
| `client` | none | `name/version`, sent as `X-Bridge-Client` for server logs |
| `locale` | none | String or function; sent as `Accept-Language` |
| `tenant` | none | Value or (async) function; sent as `X-Bridge-Tenant` |
| `credentials` | fetch default | Fetch credentials mode; session auth sets `include` |
| `fetch` | global `fetch` | A fetch implementation to use instead |
| `transport` | fetch | Replace the transport, e.g. `xhrTransport()` |
| `interceptors` | none | `{ request, response, error }` arrays |
| `onDeprecated` | none | `(operation, message) => void`, once per operation |
| `onAttempt` | none | `(event) => void` after every attempt, for metrics and tracing. See [observability](#observability) |
| `maxResponseBytes` | none | Largest JSON response accepted; bigger fails with `RESPONSE_TOO_LARGE`. Not applied to `download` |

## Calling operations

```ts
const product = await bridge.call('products.show', { id: 7 });
const cart = await bridge.call('cart.show'); // input is optional when nothing is required
```

The compiler rejects unknown operation names, missing required keys, wrong
types and unknown keys. That is a convenience: the server validates
everything again and is the only authority.

`call` resolves with `data`. `callRaw` resolves with `{ data, meta, status, headers }`,
where `meta.request_id` is the id to quote in a bug report and
`meta.idempotent_replay` tells you the server replayed a stored response.

### Per-call options

```ts
await bridge.call('orders.create', { note: null }, {
  signal: controller.signal,  // cancel
  timeout: 30_000,            // override the client timeout
  idempotencyKey: true,       // or a string you keep, see retries.md
  tenant: 2,                  // or null to send none
  headers: { 'X-Trace': '1' },
  retry: false,
  onUploadProgress: (p) => {}, // XHR transport only
});
```

### Tenants

`tenant` asks the server to act within one tenant (team, workspace, school...).
The server checks that the signed-in user belongs to it and answers
`403 TENANT_FORBIDDEN` otherwise, or `400 TENANT_REQUIRED` when an operation
needs one and none was given. Sending a tenant id never grants anything on its
own.

## Interceptors

```ts
const stop = bridge.interceptors.request.use((request, { operation, attempt }) => {
  request.headers['x-app-build'] = BUILD_ID;
});
bridge.interceptors.response.use((response) => { /* read response.meta */ });
bridge.interceptors.error.use((error) => { report(error.toJSON()); });
stop(); // removes it
```

- Request interceptors run before every attempt, and before downloads
  (`operation` is then undefined), **before** the auth adapter
  adds credentials, so they never see tokens or CSRF values. Header names are
  lower-case. They may change the URL's path or query, but not its origin:
  a request moved to another origin is refused before credentials are added.
- Response interceptors run on each successful response and may return a
  replacement.
- Error interceptors run once, on the final error after retries, and may return
  a replacement error. They cannot turn an error into success.

## Observability

`onAttempt` is called after every attempt of an operation call, retries
included, with what metrics and tracing need:

```ts
const bridge = createBridge<AppBridge>({
  baseURL,
  operations,
  onAttempt: ({ operation, attempt, status, durationMs, error, retryInMs, requestId, correlationId }) => {
    metrics.histogram('bridge.attempt.duration', durationMs, { operation, status: String(status ?? 'none') });
    if (retryInMs !== undefined) metrics.increment('bridge.retry', { operation, code: error?.code ?? '' });
  },
});
```

`error` is undefined on success; `retryInMs` is set when the call will try
again, and undefined on the last attempt. `requestId` changes per attempt,
`correlationId` stays the same for the whole call: log both, and quote the
`requestId` when reporting a problem. Exceptions thrown by `onAttempt` are
ignored, so a failing metrics backend never fails a call.

To propagate a trace context, add the header in a request interceptor:

```ts
bridge.interceptors.request.use((request) => {
  request.headers['traceparent'] = currentTraceparent();
});
```

## Redirects

The protocol never redirects, so the client never follows one: calls, auth
requests, downloads and channel authorization use `redirect: 'manual'`, and a
redirect fails with a `BridgeProtocolError` (`UNEXPECTED_REDIRECT`).
React Native's fetch and XMLHttpRequest follow redirects regardless; there the
client refuses any response whose final URL is on another origin, but the
redirected request has by then been sent. Keep your API from redirecting
(serve it over HTTPS directly, no HTTP→HTTPS hop on the API host).

## Response size

`maxResponseBytes` caps JSON responses: a larger `Content-Length` fails before
the body is read; without one, the body is read and then measured. Leave it
unset for no limit.

## Downloads

Operations can return a [`DownloadLink`](files.md#downloads). Fetch it with the
client's credentials:

```ts
const response = await bridge.download(result.download);
const blob = await response.blob();
```

`download` refuses to send credentials to an origin other than `baseURL`, so a
tampered link cannot leak a token. Its `signal` and `timeout` cover the body
too: aborting or timing out while you read it fails the read with
`BridgeAbortError` / `BridgeTimeoutError`. The timeout defaults to the
client's; raise it for large files. Pass `{ withCredentials: false }` to fetch a
public URL elsewhere.

## Without a contract

`createBridge()` without a type argument accepts any operation name and returns
`unknown`. Useful for scripts; use the generated contract in apps.
