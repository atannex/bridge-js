import { vi } from 'vitest';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  credentials: RequestCredentials | undefined;
  signal: AbortSignal | undefined;
}

export type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

/** A fetch that records requests and answers from a list (or one function) of responders. */
export function fakeFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: RecordedRequest = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      credentials: init.credentials,
      signal: init.signal ?? undefined,
    };
    const index = requests.length;
    requests.push(request);
    if (init.signal?.aborted) throw init.signal.reason;
    const responder = responders[Math.min(index, responders.length - 1)];
    if (responder === undefined) throw new Error('fakeFetch has no responder');
    return responder(request, index);
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const ok =
  (data: unknown, meta: Record<string, unknown> = {}, headers: Record<string, string> = {}): Responder =>
  () =>
    json(200, { data, meta: { request_id: 'req-12345678', version: '1', ...meta } }, headers);

export const fail =
  (status: number, code: string, details?: unknown, headers: Record<string, string> = {}): Responder =>
  () =>
    json(
      status,
      {
        error: { code, message: `failed: ${code}`, ...(details === undefined ? {} : { details }) },
        meta: { request_id: 'req-err-1234', version: '1' },
      },
      headers,
    );

export const networkDown: Responder = () => {
  throw new TypeError('fetch failed');
};

/** Never resolves until the signal aborts. */
export const hang: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal?.reason ?? new Error('aborted')));
  });
