# Errors

Every failure rejects with a `BridgeError` subclass. The class follows the HTTP
status, so a code the server adds later still lands in the right class.

| Class | When | Useful fields |
|-------|------|---------------|
| `BridgeNetworkError` | No response: offline, DNS, refused, CORS | `cause` |
| `BridgeTimeoutError` | The attempt exceeded `timeout` | |
| `BridgeAbortError` | Your `AbortSignal` fired | |
| `BridgeAuthenticationError` | 401 `UNAUTHENTICATED`, 419 `CSRF_MISMATCH` | |
| `BridgeAuthorizationError` | 403 `FORBIDDEN`, `TENANT_FORBIDDEN` | |
| `BridgeNotFoundError` | 404: unknown operation or missing record | |
| `BridgeConflictError` | 409 `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS` | `details` |
| `BridgeValidationError` | 422 `VALIDATION_FAILED`, `TWO_FACTOR_FAILED` | `fields`, `first(path)` |
| `BridgeRateLimitError` | 429 | `retryAfter` (seconds) |
| `BridgeServerError` | 5xx | `retryAfter` on 503 |
| `BridgeProtocolError` | A 2xx response that is not a Bridge envelope | |
| `BridgeError` | Anything else (400, 413, 415, ...) | `code` |

All of them carry `code`, `status` (undefined without a response), `message`,
`details`, `requestId` and `operation`.

```ts
import { isAuthenticationError, isValidationError } from '@atannex/bridge';

try {
  await bridge.call('cart.add', input);
} catch (error) {
  if (isValidationError(error)) return showFieldErrors(error.fields); // { quantity: ['...'] }
  if (isAuthenticationError(error)) return goToLogin();
  throw error;
}
```

Use the type guards (`isBridgeError`, `isNetworkError`, `isTimeoutError`,
`isAbortError`, `isAuthenticationError`, `isAuthorizationError`,
`isNotFoundError`, `isValidationError`, `isConflictError`,
`isRateLimitError`, `isServerError`, `isProtocolError`) rather than comparing
`name` strings.

## Messages

`message` comes from the server and is written for end users. The server never
puts stack traces, SQL or file paths in it. For failures without a server
message (a proxy's HTML 502, say), the client uses a short generic sentence.

## Logging

`error.toJSON()` (and so `JSON.stringify(error)`) returns only the fields
above: no headers, no tokens, no request body. `cause` is left out because it
may be a platform error with arbitrary content. Send `toJSON()` to your error
tracker, and always include `requestId` — the server logs it too.

The client itself never logs anything.
