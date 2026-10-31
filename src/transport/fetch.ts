import type { Transport } from './types.js';

/**
 * The default transport, on the Fetch API.
 *
 * Fetch cannot report upload progress, so `onUploadProgress` is ignored here;
 * use `xhrTransport` from `@atannex/bridge/xhr` when you need it.
 *
 * Redirects are not followed (`redirect: 'manual'`); the client rejects them.
 * React Native's fetch ignores that mode and follows them anyway, so there the
 * client can only refuse the redirected response afterwards.
 */
export function fetchTransport(fetchImpl?: typeof fetch): Transport {
  return async (request) => {
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new TypeError('No fetch implementation is available. Pass one as `fetch` in the Bridge config.');
    }
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      // Bridge endpoints never redirect. Following one would resend headers
      // (CSRF token, tenant) and the body to wherever the Location points.
      redirect: 'manual',
    };
    if (request.body !== undefined) init.body = request.body;
    if (request.credentials !== undefined) init.credentials = request.credentials;

    const response = await doFetch(request.url, init);
    return {
      status: response.status,
      headers: response.headers,
      url: response.url,
      redirected: response.redirected,
      text: () => response.text(),
    };
  };
}
