# Testing your app

## Unit tests: a fake fetch

The client takes any `fetch`. Answer with Bridge envelopes:

```ts
const fetch = vi.fn(async () =>
  new Response(JSON.stringify({ data: { items: [], total: '0.00' }, meta: { request_id: 'test-0001', version: '1' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
);
const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
```

Errors:

```ts
new Response(JSON.stringify({
  error: { code: 'VALIDATION_FAILED', message: 'The supplied data is invalid.', details: { quantity: ['Too small.'] } },
  meta: { request_id: 'test-0002', version: '1' },
}), { status: 422 });
```

Use `memoryStorage()` for `bearerToken` and `memoryCookieJar()` for
`sanctumSession` in Node tests.

## Against a real server

This package's own integration tests (`tests/integration`) run against the
example Laravel app in the `atannex/bridge` workspace:

```bash
BRIDGE_TEST_URL=http://127.0.0.1:8123 npm run test:integration
```

They skip themselves when `BRIDGE_TEST_URL` is not set.

In CI, the `Laravel integration` job checks out `atannex/bridge` and
`atannex/bridge-workspace` next to this repository and runs the workspace's
`scripts/integration.sh`: a fresh SQLite backend, the generated-contract
check, these integration tests (including the built `react-native` entry) and
the Expo example's flow test.

## Other runtimes

`tests/smoke` checks the built package in each runtime, with an in-memory
`fetch`:

```bash
npm run build
node tests/smoke/run.mjs                    # or: npm run test:smoke
bun tests/smoke/run.mjs
deno run --allow-read tests/smoke/run.mjs
node tests/smoke/browser.mjs                # headless Chromium; needs playwright
```
