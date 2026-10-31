import type { ResponseMeta } from '../contracts/types.js';
import {
  BridgeAuthenticationError,
  BridgeAuthorizationError,
  BridgeConflictError,
  BridgeError,
  type BridgeErrorInit,
  BridgeNotFoundError,
  BridgeProtocolError,
  BridgeRateLimitError,
  BridgeServerError,
  BridgeValidationError,
} from '../errors/errors.js';
import { codeForStatus } from './constants.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parses a body as JSON, or returns `undefined` when it is empty or not JSON. */
export function parseJson(text: string): unknown {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads a `Retry-After` header or `details.retry_after`, in seconds. */
export function retryAfterSeconds(
  headers: Headers | undefined,
  details: unknown,
  now = Date.now(),
): number | undefined {
  if (isObject(details) && typeof details['retry_after'] === 'number' && details['retry_after'] >= 0) {
    return details['retry_after'];
  }
  const header = headers?.get('retry-after');
  if (header === null || header === undefined || header.trim() === '') {
    return undefined;
  }
  if (/^\d+$/.test(header.trim())) {
    return Number(header.trim());
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

export interface ErrorContext {
  operation?: string | undefined;
  requestId?: string | undefined;
  headers?: Headers | undefined;
}

/**
 * Builds the right error for a failed response.
 *
 * The class follows the HTTP status, so codes added to the protocol later still
 * land in a sensible class. Bodies that are not a Bridge error envelope are
 * accepted too: Laravel's own `{ message, errors }` (Fortify's login, for
 * instance) becomes a validation error with `errors` as its details.
 */
export function errorFromResponse(status: number, body: unknown, context: ErrorContext = {}): BridgeError {
  let code = codeForStatus(status);
  let message = defaultMessage(status);
  let details: unknown;
  let requestId = context.requestId ?? context.headers?.get('x-request-id') ?? undefined;

  if (isObject(body)) {
    const error = body['error'];
    if (isObject(error)) {
      if (typeof error['code'] === 'string' && error['code'] !== '') code = error['code'];
      if (typeof error['message'] === 'string' && error['message'] !== '') message = error['message'];
      if ('details' in error) details = error['details'];
    } else {
      if (typeof body['message'] === 'string' && body['message'] !== '') message = body['message'];
      if (isObject(body['errors'])) details = body['errors'];
    }
    const meta = body['meta'];
    if (isObject(meta) && typeof meta['request_id'] === 'string') requestId = meta['request_id'];
  }

  const init: BridgeErrorInit = { code, message, status, details, requestId, operation: context.operation };

  if (status === 401 || status === 419) return new BridgeAuthenticationError(init);
  if (status === 403) return new BridgeAuthorizationError(init);
  if (status === 404) return new BridgeNotFoundError(init);
  if (status === 409) return new BridgeConflictError(init);
  if (status === 422) return new BridgeValidationError(init);
  if (status === 429)
    return new BridgeRateLimitError({ ...init, retryAfter: retryAfterSeconds(context.headers, details) });
  if (status >= 500) return new BridgeServerError({ ...init, retryAfter: retryAfterSeconds(context.headers, details) });
  return new BridgeError(init);
}

function defaultMessage(status: number): string {
  if (status === 401) return 'You need to sign in.';
  if (status === 403) return 'You are not allowed to do this.';
  if (status === 404) return 'Not found.';
  if (status === 419) return 'Your session has expired. Please try again.';
  if (status === 422) return 'The supplied data is invalid.';
  if (status === 429) return 'Too many requests. Please slow down.';
  if (status >= 500) return 'The server could not complete the request.';
  return `The request failed with status ${status}.`;
}

/** Reads a success envelope, or throws a protocol error when the body is not one. */
export function successFromBody(
  status: number,
  body: unknown,
  context: ErrorContext = {},
): { data: unknown; meta: ResponseMeta } {
  if (
    !isObject(body) ||
    !('data' in body) ||
    !isObject(body['meta']) ||
    typeof body['meta']['request_id'] !== 'string'
  ) {
    throw new BridgeProtocolError({
      code: 'PROTOCOL_ERROR',
      message: 'The server sent a response that is not a Bridge envelope.',
      status,
      requestId: context.requestId ?? context.headers?.get('x-request-id') ?? undefined,
      operation: context.operation,
    });
  }
  return { data: body['data'], meta: body['meta'] as unknown as ResponseMeta };
}
