# Retries and idempotency

Repeating a request that changes data can do the change twice: two orders,
two payments. So the client retries only what the server says is safe to
repeat. The generated `operations` manifest carries that for each operation:

| `idempotency` | Meaning | Retried? |
|---------------|---------|----------|
| `safe` | Reads only | Yes |
| `idempotent` | Writes, but the server recognises a repeat by its `Idempotency-Key` | Only when the call sends a key |
| `unsafe` (default) | Anything else | Never |

Without the manifest, nothing is retried.

## What is retried

When an operation may be repeated, the client retries on:

- network errors and timeouts (timeouts can be excluded with `retryTimeouts: false`),
- `429`, waiting `Retry-After` / `details.retry_after` when the server gave it,
- `502`, `503` (honouring `Retry-After`), `504`.

Never on other 4xx (they will fail the same way again), `500`, or when your
`AbortSignal` fires.

## Policy

```ts
createBridge({
  ...,
  retry: {
    attempts: 3,        // total, including the first
    baseDelay: 300,     // ms
    maxDelay: 5000,     // ms
    maxRetryAfter: 30,  // s; a longer Retry-After fails at once
    retryTimeouts: true,
  },
});
```

Backoff doubles from `baseDelay` up to `maxDelay`, with jitter (half fixed,
half random) so many clients don't retry in lockstep. Per call:
`{ retry: false }` or a partial policy.

## Idempotency keys

```ts
await bridge.call('orders.create', input, { idempotencyKey: true });
```

`true` generates a key and reuses it for every retry of that call. To make a
repeat safe across app restarts (the user taps "Pay" again after a crash),
generate the key yourself, store it with the pending action, and pass the same
string again:

```ts
const key = pendingCheckout.idempotencyKey ?? crypto.randomUUID();
await bridge.call('orders.create', input, { idempotencyKey: key });
```

Keys are 8–128 characters of `A–Z a–z 0–9 . _ : -`.

The server stores the first response for the key (per operation and user) and
replays it for the same input; `callRaw` shows `meta.idempotent_replay: true`.
The same key with different input fails with `409 IDEMPOTENCY_KEY_REUSED`;
a key whose first request is still running fails with
`409 IDEMPOTENCY_IN_PROGRESS`.

Each attempt gets a new `X-Request-Id`; all attempts of one call share an
`X-Correlation-Id`.
