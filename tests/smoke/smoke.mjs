/**
 * Runtime smoke test for the built package. Plain ESM with no imports of its
 * own, so the same checks run unchanged in Node, Bun, Deno and a browser:
 * each runner imports `dist/index.js`, passes it in, and fails on a throw.
 *
 * Requests go to an in-memory fetch, so no server is needed; the Laravel side
 * is covered by the integration tests.
 */

const envelope = (data) => ({ data, meta: { request_id: 'r-12345678', version: '1' } });
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function check(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`);
}

/** A fetch that answers from `responders` in turn and records each request. */
function fakeFetch(...responders) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ url: String(url), method: init.method, headers, body: init.body });
    const responder = responders[Math.min(requests.length - 1, responders.length - 1)];
    return responder(init);
  };
  return { fetch, requests };
}

/** Never answers; rejects when the request's signal aborts, as real fetch does. */
const hang = (init) =>
  new Promise((_, reject) => {
    const fail = () => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (init.signal?.aborted) fail();
    else init.signal?.addEventListener('abort', fail);
  });

const operations = {
  'products.list': { idempotency: 'safe', auth: 'optional' },
  'cart.add': { idempotency: 'idempotent', auth: 'required' },
};

/** Runs every check against `sdk` (the package's main entry). Resolves with the names of the checks that passed. */
export async function smoke(sdk) {
  const passed = [];
  const run = async (name, body) => {
    await body();
    passed.push(name);
  };

  await run('call returns the envelope data with protocol headers', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, envelope({ items: [1, 2] })));
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch, operations, tenant: 7 });
    const data = await bridge.call('products.list', { page: 1 });
    check(data.items.length === 2, 'data');
    const sent = requests[0];
    check(sent.url === 'https://api.test/bridge/v1/call/products.list', `url ${sent.url}`);
    check(sent.method === 'POST', 'method');
    check(sent.headers['x-bridge-version'] === '1', 'version header');
    check(typeof sent.headers['x-request-id'] === 'string' && sent.headers['x-request-id'].length >= 8, 'request id');
    check(sent.headers['x-bridge-tenant'] === '7', 'tenant header');
    check(JSON.parse(sent.body).input.page === 1, 'json body');
  });

  await run('validation errors are typed with field messages', async () => {
    const { fetch } = fakeFetch(() =>
      json(422, {
        error: { code: 'VALIDATION_FAILED', message: 'Invalid.', details: { quantity: ['Too many.'] } },
        meta: { request_id: 'r-12345678', version: '1' },
      }),
    );
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch });
    const error = await bridge.call('cart.add', { quantity: 99 }).catch((e) => e);
    check(error instanceof sdk.BridgeValidationError, `got ${error?.name}`);
    check(error instanceof sdk.BridgeError && error.status === 422, 'status');
    check(error.fields.quantity?.[0] === 'Too many.', 'field messages');
  });

  await run('safe operations retry a 503, honouring Retry-After', async () => {
    const { fetch, requests } = fakeFetch(
      () =>
        json(
          503,
          { error: { code: 'SERVICE_UNAVAILABLE', message: 'Busy.' }, meta: { request_id: 'r-1', version: '1' } },
          { 'retry-after': '0' },
        ),
      () => json(200, envelope({ items: [] })),
    );
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch, operations, retry: { baseDelay: 1 } });
    await bridge.call('products.list');
    check(requests.length === 2, `attempts ${requests.length}`);
  });

  await run('timeouts and caller cancellation are told apart', async () => {
    const { fetch } = fakeFetch(hang);
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch, timeout: 30, retry: false });
    const timedOut = await bridge.call('cart.add', {}).catch((e) => e);
    check(timedOut instanceof sdk.BridgeTimeoutError, `timeout got ${timedOut?.name}`);

    const controller = new AbortController();
    const pending = sdk
      .createBridge({ baseURL: 'https://api.test', fetch, timeout: 0 })
      .call('cart.add', {}, { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    const aborted = await pending;
    check(aborted instanceof sdk.BridgeAbortError, `abort got ${aborted?.name}`);
  });

  await run('bearer tokens are stored, sent and forgotten', async () => {
    const storage = sdk.memoryStorage();
    const auth = sdk.bearerToken({ storage });
    const { fetch, requests } = fakeFetch(
      () => json(200, envelope({ status: 'authenticated', token: '1|tok', token_type: 'Bearer', expires_at: null })),
      () => json(200, envelope({ items: [] })),
      () => json(200, envelope(null)),
    );
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch, auth, operations });
    await auth.login({ email: 'a@b.c', password: 'secret' });
    await bridge.call('products.list');
    check(requests[1].headers['authorization'] === 'Bearer 1|tok', 'auth header');
    await auth.logout();
    check((await auth.isAuthenticated()) === false, 'logged out');
  });

  await run('files go up as multipart', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, envelope({ ok: true })));
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch });
    await bridge.call('profile.avatar.upload', { avatar: new Blob(['png'], { type: 'image/png' }), caption: 'me' });
    check(requests[0].body instanceof FormData, 'FormData body');
    check(JSON.parse(requests[0].body.get('input')).caption === 'me', 'input field');
    check(requests[0].body.get('files[avatar]') instanceof Blob, 'file part');
  });

  await run('downloads report progress while the body is read', async () => {
    const { fetch } = fakeFetch(
      () => new Response(new Uint8Array(12), { status: 200, headers: { 'content-length': '12' } }),
    );
    const bridge = sdk.createBridge({ baseURL: 'https://api.test', fetch });
    let last;
    const response = await bridge.download('/bridge/v1/files/abc', { onDownloadProgress: (p) => (last = p) });
    const bytes = await response.arrayBuffer();
    check(bytes.byteLength === 12, 'body');
    check(last !== undefined && last.loaded === 12 && last.total === 12, `progress ${JSON.stringify(last)}`);
  });

  return passed;
}
