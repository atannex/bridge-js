import type { AuthAdapter, AuthHost, HostRequest, HostResponse } from '../authentication/types.js';
import type {
  BridgeResponse,
  Contract,
  DownloadLink,
  HasOptionalInput,
  InputOf,
  OperationName,
  OperationsManifest,
  OutputOf,
  UntypedContract,
} from '../contracts/types.js';
import {
  BridgeAbortError,
  BridgeError,
  type BridgeErrorInit,
  BridgeNetworkError,
  BridgeProtocolError,
  BridgeTimeoutError,
} from '../errors/errors.js';
import {
  type ErrorInterceptor,
  type InterceptorContext,
  type InterceptorList,
  interceptorList,
  type RequestInterceptor,
  type ResponseInterceptor,
} from '../interceptors/interceptors.js';
import {
  DEFAULT_PREFIX,
  ID_PATTERN,
  MAX_CLIENT_HEADER_LENGTH,
  MAX_OPERATION_LENGTH,
  OPERATION_PATTERN,
  PROTOCOL_VERSION,
} from '../protocol/constants.js';
import { errorFromResponse, parseJson, successFromBody } from '../protocol/envelope.js';
import { encodeInput } from '../serialization/body.js';
import { fetchTransport } from '../transport/fetch.js';
import type {
  DownloadProgress,
  Transport,
  TransportRequest,
  TransportResponse,
  UploadProgress,
} from '../transport/types.js';
import { randomId } from '../utilities/id.js';
import { type LinkedSignal, linkSignal, sleep } from '../utilities/signal.js';
import { joinUrl, originOf } from '../utilities/url.js';
import { DEFAULT_RETRY, mayRepeat, resolveRetry, type RetryPolicy, retryDelay } from './retry.js';

type MaybePromise<T> = T | Promise<T>;
type TenantValue = string | number | null | undefined;

export interface BridgeConfig {
  /** Where the Laravel app lives, for example `https://api.example.com`. */
  baseURL: string;
  /** Route prefix of the Bridge endpoints. Default `bridge/v1`. */
  prefix?: string;
  /** A fetch implementation, when the global one is missing or must be wrapped. Ignored when `transport` is set. */
  fetch?: typeof fetch;
  /** Replaces the fetch transport, for example with `xhrTransport()` for upload progress. */
  transport?: Transport;
  /** Extra headers for every request, or a function returning them. */
  headers?: Record<string, string> | (() => MaybePromise<Record<string, string>>);
  /** Per-attempt timeout in ms. Default 15000. `0` or `Infinity` disables it. */
  timeout?: number;
  /** How requests are authenticated. See `sanctumSession` and `bearerToken`. */
  auth?: AuthAdapter;
  interceptors?: {
    request?: RequestInterceptor[];
    response?: ResponseInterceptor[];
    error?: ErrorInterceptor[];
  };
  /** Default retry policy. Retries only ever happen for operations the manifest marks safe to repeat. */
  retry?: RetryPolicy | false;
  /** The generated `operations` constant. Without it nothing is retried. */
  operations?: OperationsManifest;
  /** `name/version` sent as `X-Bridge-Client`, for server logs. */
  client?: string;
  /** Sent as `Accept-Language`. */
  locale?: string | (() => string | undefined);
  /** The tenant to ask for, sent as `X-Bridge-Tenant`. The server checks membership. */
  tenant?: TenantValue | (() => MaybePromise<TenantValue>);
  /** Fetch credentials mode. Auth adapters may override it (sessions use `include`). */
  credentials?: RequestCredentials;
  /** Called once per operation per client the first time the server reports it deprecated. */
  onDeprecated?: (operation: string, message: string) => void;
  /**
   * Largest JSON response body to accept, in bytes. Bigger responses fail
   * with a `BridgeProtocolError` (`RESPONSE_TOO_LARGE`): at once when
   * `Content-Length` says so, otherwise after reading. No limit by default.
   * Does not apply to `download`.
   */
  maxResponseBytes?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the client timeout for this call. */
  timeout?: number;
  headers?: Record<string, string>;
  /**
   * Sends `Idempotency-Key`. `true` generates one, reused across retries.
   * Needed before an `idempotent` operation is retried.
   */
  idempotencyKey?: string | true;
  /** Upload progress. Only transports that can observe it call this (the XHR transport). */
  onUploadProgress?: (progress: UploadProgress) => void;
  /** Overrides the client retry policy; `false` disables retries for this call. */
  retry?: RetryPolicy | false;
  /** Overrides the client tenant for this call; `null` sends none. */
  tenant?: string | number | null;
}

export interface DownloadOptions {
  /** Cancels the download, including while the body is being read. */
  signal?: AbortSignal;
  /** Covers the whole download, body included. Defaults to the client timeout; raise it for large files. */
  timeout?: number;
  /**
   * Called as the body is read, with bytes so far and the size when the
   * server sent an uncompressed `Content-Length`. Where bodies are not
   * streams (React Native) it fires once, when the whole body has arrived.
   */
  onDownloadProgress?: (progress: DownloadProgress) => void;
  /**
   * Attach the auth adapter's credentials. Default true. Links on another
   * origin than `baseURL` are refused while this is true, so tokens never
   * leave for a host you did not configure.
   */
  withCredentials?: boolean;
}

/** The arguments after the operation name: input is optional when it has no required keys. */
export type CallArgs<C extends Contract, K extends OperationName<C>> =
  HasOptionalInput<InputOf<C, K>> extends true
    ? [input?: InputOf<C, K>, options?: CallOptions]
    : [input: InputOf<C, K>, options?: CallOptions];

export interface Bridge<C extends Contract = UntypedContract> {
  /** Runs an operation and resolves with its `data`. Rejects with a `BridgeError`. */
  readonly call: <K extends OperationName<C>>(operation: K, ...args: CallArgs<C, K>) => Promise<OutputOf<C, K>>;
  /** Like `call`, but resolves with `data`, `meta`, status and headers. */
  readonly callRaw: <K extends OperationName<C>>(
    operation: K,
    ...args: CallArgs<C, K>
  ) => Promise<BridgeResponse<OutputOf<C, K>>>;
  /** Fetches a download link (or URL) with the client's credentials. Resolves with the raw `Response`. */
  readonly download: (target: DownloadLink | string, options?: DownloadOptions) => Promise<Response>;
  readonly interceptors: {
    readonly request: InterceptorList<RequestInterceptor>;
    readonly response: InterceptorList<ResponseInterceptor>;
    readonly error: InterceptorList<ErrorInterceptor>;
  };
  readonly auth: AuthAdapter | undefined;
  readonly baseURL: string;
  readonly prefix: string;
  /** Absolute URL of a path under the prefix. */
  readonly url: (path: string) => string;
  /**
   * The tenant the client sends by default, as a string, or null for none.
   * Throws when `tenant` is an async function, since the value is not known
   * synchronously; query helpers then need an explicit `scope`.
   */
  readonly currentTenant: () => string | null;
}

interface Exchange {
  status: number;
  headers: Headers;
  body: unknown;
  request: TransportRequest;
}

type ErrorContext = Pick<BridgeErrorInit, 'operation' | 'requestId'>;

/**
 * True when the response came from a redirect. The protocol never redirects,
 * and following one sends headers and body to wherever `Location` points.
 * Status 0 is fetch's opaque redirect in browsers.
 */
function wasRedirected(response: TransportResponse, requestUrl: string): boolean {
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) return true;
  if (response.redirected === true) return true;
  const finalOrigin = response.url === undefined || response.url === '' ? undefined : originOf(response.url);
  return finalOrigin !== undefined && finalOrigin !== originOf(requestUrl);
}

const redirectError = (context: ErrorContext, status: number): BridgeProtocolError =>
  new BridgeProtocolError({
    ...context,
    status,
    code: 'UNEXPECTED_REDIRECT',
    message: 'The server answered with a redirect, which Bridge never follows.',
  });

const tooLargeError = (context: ErrorContext, status: number, limit: number): BridgeProtocolError =>
  new BridgeProtocolError({
    ...context,
    status,
    code: 'RESPONSE_TOO_LARGE',
    message: `The response is larger than the ${limit}-byte limit.`,
  });

function byteLength(text: string): number {
  return typeof TextEncoder === 'undefined' ? text.length : new TextEncoder().encode(text).byteLength;
}

/** Maps a failure while waiting on the network to the right error class. */
function failureError(
  cause: unknown,
  signal: AbortSignal | undefined,
  linked: LinkedSignal,
  context: ErrorContext,
): BridgeError {
  if (cause instanceof BridgeError) return cause;
  if (signal?.aborted) {
    return new BridgeAbortError({ ...context, code: 'ABORTED', message: 'The request was cancelled.', cause });
  }
  if (linked.timedOut()) {
    return new BridgeTimeoutError({ ...context, code: 'TIMEOUT', message: 'The request timed out.', cause });
  }
  return new BridgeNetworkError({
    ...context,
    code: 'NETWORK_ERROR',
    message: 'The server could not be reached.',
    cause,
  });
}

/**
 * Returns a response whose body keeps `linked` (timeout + caller signal) alive
 * until it is read to the end, cancelled or fails, so aborting still works
 * mid-body. Where bodies are not streams (React Native), the body is read
 * into a Blob first, under the same signal.
 */
async function holdUntilConsumed(
  response: Response,
  linked: LinkedSignal,
  signal: AbortSignal | undefined,
  context: ErrorContext,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<Response> {
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  const body = response.body;
  // A compressed body's Content-Length counts encoded bytes, not the ones read.
  const encoding = response.headers.get('content-encoding');
  const length = Number(response.headers.get('content-length') ?? NaN);
  const total = (encoding === null || encoding === 'identity') && Number.isFinite(length) ? length : undefined;
  let loaded = 0;
  if (body !== null && typeof ReadableStream !== 'undefined') {
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            linked.dispose();
            controller.close();
          } else {
            loaded += value.byteLength;
            onProgress?.({ loaded, total });
            controller.enqueue(value);
          }
        } catch (cause) {
          linked.dispose();
          controller.error(failureError(cause, signal, linked, context));
        }
      },
      cancel(reason) {
        linked.dispose();
        return reader.cancel(reason);
      },
    });
    return new Response(stream, init);
  }
  try {
    const blob = await response.blob();
    onProgress?.({ loaded: blob.size, total: total ?? blob.size });
    return new Response(blob, init);
  } catch (cause) {
    throw failureError(cause, signal, linked, context);
  } finally {
    linked.dispose();
  }
}

const lowerKeys = (headers: Record<string, string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
};

/**
 * Creates a Bridge client.
 *
 * ```ts
 * import { createBridge } from '@atannex/bridge';
 * import { operations, type AppBridge } from './generated/bridge';
 *
 * const bridge = createBridge<AppBridge>({ baseURL: 'https://api.example.com', operations });
 * const page = await bridge.call('products.list', { page: 1 });
 * ```
 */
export function createBridge<C extends Contract = UntypedContract>(config: BridgeConfig): Bridge<C> {
  if (typeof config.baseURL !== 'string' || config.baseURL === '') {
    throw new TypeError('createBridge needs a baseURL.');
  }
  const baseURL = config.baseURL.replace(/\/+$/, '');
  const prefix = (config.prefix ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
  const transport = config.transport ?? fetchTransport(config.fetch);
  const defaultTimeout = config.timeout ?? 15000;
  const defaultRetry = resolveRetry(config.retry, DEFAULT_RETRY);
  const auth = config.auth;
  const warnedDeprecated = new Set<string>();

  const interceptors = {
    request: interceptorList<RequestInterceptor>(config.interceptors?.request),
    response: interceptorList<ResponseInterceptor>(config.interceptors?.response),
    error: interceptorList<ErrorInterceptor>(config.interceptors?.error),
  };

  const url = (path: string): string => joinUrl(baseURL, `${prefix}/${path.replace(/^\/+/, '')}`);

  async function baseHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-bridge-version': PROTOCOL_VERSION,
      'x-requested-with': 'XMLHttpRequest',
    };
    if (config.client !== undefined && config.client !== '') {
      headers['x-bridge-client'] = config.client.slice(0, MAX_CLIENT_HEADER_LENGTH);
    }
    const locale = typeof config.locale === 'function' ? config.locale() : config.locale;
    if (locale !== undefined && locale !== '') headers['accept-language'] = locale;
    const extra = typeof config.headers === 'function' ? await config.headers() : config.headers;
    return { ...headers, ...lowerKeys(extra) };
  }

  /** Sends one request through interceptors, auth and the transport. Throws only for no-response failures. */
  async function exchange(
    request: TransportRequest,
    context: InterceptorContext,
    options: { signal?: AbortSignal | undefined; timeout?: number | undefined; auth: boolean },
  ): Promise<Exchange> {
    const expectedOrigin = originOf(request.url);
    let prepared = request;
    for (const interceptor of interceptors.request.items) {
      prepared = (await interceptor(prepared, context)) ?? prepared;
    }
    // Interceptors run before credentials are added; make sure none of them
    // pointed the request somewhere the credentials must not go.
    if (originOf(prepared.url) !== expectedOrigin) {
      throw new TypeError('A request interceptor changed the request to another origin; Bridge will not send it.');
    }
    if (options.auth && auth !== undefined) await auth.prepare(prepared);

    const linked = linkSignal(options.signal, options.timeout ?? defaultTimeout);
    prepared.signal = linked.signal;
    const errorContext: ErrorContext = { operation: context.operation, requestId: prepared.headers['x-request-id'] };
    const limit = config.maxResponseBytes;
    try {
      const response = await transport(prepared);
      if (wasRedirected(response, prepared.url)) throw redirectError(errorContext, response.status);
      if (auth?.handleResponse !== undefined) await auth.handleResponse(response, prepared);
      if (limit !== undefined && Number(response.headers.get('content-length') ?? 0) > limit) {
        throw tooLargeError(errorContext, response.status, limit);
      }
      const text = await response.text();
      if (limit !== undefined && byteLength(text) > limit) throw tooLargeError(errorContext, response.status, limit);
      return { status: response.status, headers: response.headers, body: parseJson(text), request: prepared };
    } catch (cause) {
      throw failureError(cause, options.signal, linked, errorContext);
    } finally {
      linked.dispose();
    }
  }

  async function tenantHeader(options: CallOptions): Promise<string | undefined> {
    const value =
      'tenant' in options
        ? options.tenant
        : typeof config.tenant === 'function'
          ? await config.tenant()
          : config.tenant;
    return value === null || value === undefined || value === '' ? undefined : String(value);
  }

  async function callRaw(
    operation: string,
    input: unknown,
    options: CallOptions = {},
  ): Promise<BridgeResponse<unknown>> {
    if (
      typeof operation !== 'string' ||
      operation.length > MAX_OPERATION_LENGTH ||
      !OPERATION_PATTERN.test(operation)
    ) {
      throw new TypeError(`"${operation}" is not a valid Bridge operation name.`);
    }

    let idempotencyKey: string | undefined;
    if (options.idempotencyKey === true) {
      idempotencyKey = randomId();
    } else if (typeof options.idempotencyKey === 'string') {
      if (!ID_PATTERN.test(options.idempotencyKey)) {
        throw new TypeError('An idempotency key must be 8-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-".');
      }
      idempotencyKey = options.idempotencyKey;
    }

    const info = config.operations?.[operation];
    const resolved = resolveRetry(options.retry, defaultRetry);
    const policy = mayRepeat(info?.idempotency, idempotencyKey !== undefined) ? resolved : { ...resolved, attempts: 1 };

    const encoded = encodeInput(input);
    const correlationId = randomId();
    const tenant = await tenantHeader(options);
    let csrfReplayed = false;
    let attempt = 1;

    for (;;) {
      const context: InterceptorContext = { operation, attempt };
      const headers: Record<string, string> = {
        ...(await baseHeaders()),
        'x-request-id': randomId(),
        'x-correlation-id': correlationId,
      };
      if (encoded.kind === 'json') headers['content-type'] = 'application/json';
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
      if (tenant !== undefined) headers['x-bridge-tenant'] = tenant;
      Object.assign(headers, lowerKeys(options.headers));

      const request: TransportRequest = {
        url: url(`call/${encodeURIComponent(operation)}`),
        method: 'POST',
        headers,
        body: encoded.body,
        credentials: config.credentials,
        signal: new AbortController().signal,
        onUploadProgress: options.onUploadProgress,
      };

      let error: BridgeError;
      try {
        const result = await exchange(request, context, {
          signal: options.signal,
          timeout: options.timeout,
          auth: true,
        });
        if (result.status >= 200 && result.status < 300) {
          const { data, meta } = successFromBody(result.status, result.body, { operation, headers: result.headers });
          let response: BridgeResponse<unknown> = { data, meta, status: result.status, headers: result.headers };
          for (const interceptor of interceptors.response.items) {
            response = (await interceptor(response, context)) ?? response;
          }
          noteDeprecation(operation, response);
          return response;
        }
        error = errorFromResponse(result.status, result.body, { operation, headers: result.headers });
        if (result.status === 419 && !csrfReplayed && auth?.recover !== undefined) {
          csrfReplayed = true;
          if (await auth.recover(error, result.request)) continue;
        }
        if (result.status === 401 && auth?.onUnauthenticated !== undefined) {
          await auth.onUnauthenticated(error, result.request);
        }
      } catch (caught) {
        if (!(caught instanceof BridgeError)) throw caught;
        error = caught;
      }

      const delay = error instanceof BridgeAbortError ? undefined : retryDelay(error, attempt, policy);
      if (delay === undefined) {
        throw await finalError(error, context);
      }
      try {
        await sleep(delay, options.signal);
      } catch (cause) {
        throw await finalError(
          new BridgeAbortError({ code: 'ABORTED', message: 'The request was cancelled.', operation, cause }),
          context,
        );
      }
      attempt++;
    }
  }

  async function finalError(error: BridgeError, context: InterceptorContext): Promise<BridgeError> {
    let result = error;
    for (const interceptor of interceptors.error.items) {
      result = (await interceptor(result, context)) ?? result;
    }
    return result;
  }

  function noteDeprecation(operation: string, response: BridgeResponse<unknown>): void {
    const deprecated = response.meta.deprecated;
    if (deprecated === undefined || config.onDeprecated === undefined || warnedDeprecated.has(operation)) return;
    warnedDeprecated.add(operation);
    config.onDeprecated(operation, typeof deprecated.message === 'string' ? deprecated.message : '');
  }

  const host: AuthHost = {
    prefixed: (path) => `/${prefix}/${path.replace(/^\/+/, '')}`,
    async send(hostRequest: HostRequest): Promise<HostResponse> {
      const target = joinUrl(baseURL, hostRequest.path);
      if (originOf(target) !== originOf(baseURL) && originOf(baseURL) !== undefined) {
        throw new TypeError('Auth requests must go to the same origin as the Bridge baseURL.');
      }
      const headers: Record<string, string> = { ...(await baseHeaders()), 'x-request-id': randomId() };
      let body: string | undefined;
      if (hostRequest.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(hostRequest.body);
      }
      Object.assign(headers, lowerKeys(hostRequest.headers));
      const request: TransportRequest = {
        url: target,
        method: hostRequest.method,
        headers,
        body,
        credentials: config.credentials,
        signal: new AbortController().signal,
      };
      const result = await exchange(
        request,
        { operation: undefined, attempt: 1 },
        {
          signal: hostRequest.signal,
          auth: hostRequest.auth !== false,
        },
      );
      if (result.status >= 400) {
        throw errorFromResponse(result.status, result.body, { headers: result.headers });
      }
      return { status: result.status, headers: result.headers, body: result.body };
    },
  };

  async function download(target: DownloadLink | string, options: DownloadOptions = {}): Promise<Response> {
    const link = typeof target === 'string' ? target : target.url;
    const absolute = joinUrl(baseURL, link);
    const withCredentials = options.withCredentials !== false;
    if (withCredentials && originOf(absolute) !== originOf(baseURL)) {
      throw new TypeError(
        'Refusing to send credentials to another origin. Pass { withCredentials: false } to download it without them.',
      );
    }
    const doFetch = config.fetch ?? globalThis.fetch;
    const request: TransportRequest = {
      url: absolute,
      method: 'GET',
      headers: { ...(await baseHeaders()), accept: '*/*', 'x-request-id': randomId() },
      credentials: config.credentials,
      signal: new AbortController().signal,
    };
    if (withCredentials && auth !== undefined) await auth.prepare(request);
    const linked = linkSignal(options.signal, options.timeout ?? defaultTimeout);
    const errorContext: ErrorContext = { requestId: request.headers['x-request-id'] };
    let response: Response;
    try {
      const init: RequestInit = { method: 'GET', headers: request.headers, signal: linked.signal, redirect: 'manual' };
      if (request.credentials !== undefined) init.credentials = request.credentials;
      response = await doFetch(absolute, init);
      if (wasRedirected(response, absolute)) throw redirectError(errorContext, response.status);
      if (withCredentials && auth?.handleResponse !== undefined) await auth.handleResponse(response, request);
      if (!response.ok) {
        throw errorFromResponse(response.status, parseJson(await response.text()), { headers: response.headers });
      }
    } catch (cause) {
      linked.dispose();
      throw failureError(cause, options.signal, linked, errorContext);
    }
    // The signal stays linked until the body has been read.
    return holdUntilConsumed(response, linked, options.signal, errorContext, options.onDownloadProgress);
  }

  function currentTenant(): string | null {
    const value = typeof config.tenant === 'function' ? config.tenant() : config.tenant;
    if (value !== null && typeof value === 'object') {
      throw new TypeError(
        'The tenant function is async, so the tenant is not known synchronously. Pass `scope` explicitly.',
      );
    }
    return value === null || value === undefined || value === '' ? null : String(value);
  }

  auth?.attach?.(host);

  const bridge: Bridge = {
    call: async (operation: string, input?: unknown, options?: CallOptions) =>
      (await callRaw(operation, input, options)).data,
    callRaw: (operation: string, input?: unknown, options?: CallOptions) => callRaw(operation, input, options),
    download,
    interceptors,
    auth,
    baseURL,
    prefix,
    url,
    currentTenant,
  };
  return bridge as unknown as Bridge<C>;
}
