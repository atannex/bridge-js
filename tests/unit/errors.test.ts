import { describe, expect, it } from 'vitest';
import {
  BridgeAuthenticationError,
  BridgeAuthorizationError,
  BridgeConflictError,
  BridgeError,
  BridgeNotFoundError,
  BridgeRateLimitError,
  BridgeServerError,
  BridgeValidationError,
  ERROR_CODES,
  isAbortError,
  isAuthenticationError,
  isAuthorizationError,
  isBridgeError,
  isConflictError,
  isNetworkError,
  isNotFoundError,
  isProtocolError,
  isRateLimitError,
  isServerError,
  isTimeoutError,
  isValidationError,
  BridgeAbortError,
  BridgeNetworkError,
  BridgeProtocolError,
  BridgeTimeoutError,
} from '@atannex/bridge';
import { errorFromResponse, retryAfterSeconds } from '../../src/protocol/envelope.js';

const envelope = (code: string, details?: unknown) => ({
  error: { code, message: `m:${code}`, ...(details === undefined ? {} : { details }) },
  meta: { request_id: 'req-abcdefgh', version: '1' },
});

// Every row of the PROTOCOL.md error table.
const table: [number, string, new (...args: never[]) => BridgeError][] = [
  [400, 'MALFORMED_REQUEST', BridgeError],
  [400, 'UNSUPPORTED_VERSION', BridgeError],
  [400, 'TENANT_REQUIRED', BridgeError],
  [401, 'UNAUTHENTICATED', BridgeAuthenticationError],
  [403, 'FORBIDDEN', BridgeAuthorizationError],
  [403, 'TENANT_FORBIDDEN', BridgeAuthorizationError],
  [404, 'NOT_FOUND', BridgeNotFoundError],
  [409, 'CONFLICT', BridgeConflictError],
  [409, 'IDEMPOTENCY_KEY_REUSED', BridgeConflictError],
  [409, 'IDEMPOTENCY_IN_PROGRESS', BridgeConflictError],
  [413, 'PAYLOAD_TOO_LARGE', BridgeError],
  [415, 'UNSUPPORTED_MEDIA_TYPE', BridgeError],
  [419, 'CSRF_MISMATCH', BridgeAuthenticationError],
  [422, 'VALIDATION_FAILED', BridgeValidationError],
  [422, 'TWO_FACTOR_FAILED', BridgeValidationError],
  [429, 'RATE_LIMITED', BridgeRateLimitError],
  [500, 'INTERNAL_ERROR', BridgeServerError],
  [503, 'SERVICE_UNAVAILABLE', BridgeServerError],
];

describe('errorFromResponse', () => {
  it('covers every protocol error code', () => {
    expect(new Set(table.map(([, code]) => code))).toEqual(new Set(ERROR_CODES));
  });

  it.each(table)('maps %i %s', (status, code, ErrorClass) => {
    const error = errorFromResponse(status, envelope(code), { operation: 'x.y' });
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toBe(`m:${code}`);
    expect(error.requestId).toBe('req-abcdefgh');
    expect(error.operation).toBe('x.y');
  });

  it('maps unknown codes by status', () => {
    const error = errorFromResponse(403, envelope('SOMETHING_NEW'));
    expect(error).toBeInstanceOf(BridgeAuthorizationError);
    expect(error.code).toBe('SOMETHING_NEW');
    expect(errorFromResponse(418, envelope('TEAPOT'))).toBeInstanceOf(BridgeError);
  });

  it('handles bodies that are not envelopes by status', () => {
    const html = errorFromResponse(502, undefined);
    expect(html).toBeInstanceOf(BridgeServerError);
    expect(html.code).toBe('INTERNAL_ERROR');
    expect(errorFromResponse(419, undefined).code).toBe('CSRF_MISMATCH');
    expect(errorFromResponse(418, undefined).code).toBe('HTTP_418');
  });

  it("reads Laravel's own { message, errors } shape (Fortify)", () => {
    const error = errorFromResponse(422, {
      message: 'These credentials do not match our records.',
      errors: { email: ['bad'] },
    });
    expect(error).toBeInstanceOf(BridgeValidationError);
    expect(error.message).toBe('These credentials do not match our records.');
    expect((error as BridgeValidationError).fields).toEqual({ email: ['bad'] });
  });

  it('takes the request id from the response header when the body has none', () => {
    const error = errorFromResponse(500, undefined, { headers: new Headers({ 'x-request-id': 'hdr-12345678' }) });
    expect(error.requestId).toBe('hdr-12345678');
  });

  it('reads retry-after from details, then the header (seconds or date)', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    expect(retryAfterSeconds(undefined, { retry_after: 7 })).toBe(7);
    expect(retryAfterSeconds(new Headers({ 'retry-after': '12' }), undefined)).toBe(12);
    expect(retryAfterSeconds(new Headers({ 'retry-after': 'Fri, 30 Oct 2026 12:00:30 GMT' }), undefined, now)).toBe(30);
    expect(retryAfterSeconds(new Headers({ 'retry-after': 'nonsense' }), undefined)).toBeUndefined();
    const limited = errorFromResponse(429, envelope('RATE_LIMITED', { retry_after: 3 }));
    expect((limited as BridgeRateLimitError).retryAfter).toBe(3);
  });
});

describe('BridgeError', () => {
  it('serialises to a log-safe object without headers', () => {
    const error = new BridgeRateLimitError({
      code: 'RATE_LIMITED',
      message: 'slow down',
      status: 429,
      requestId: 'r-12345678',
      operation: 'a.b',
      retryAfter: 5,
      cause: new Error('inner with Bearer secret'),
    });
    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(json).toEqual({
      name: 'BridgeRateLimitError',
      code: 'RATE_LIMITED',
      status: 429,
      message: 'slow down',
      requestId: 'r-12345678',
      operation: 'a.b',
      retryAfter: 5,
    });
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('keeps instanceof and name for every subclass', () => {
    const error = new BridgeNotFoundError({ code: 'NOT_FOUND', message: 'x' });
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BridgeNotFoundError');
  });

  it('exposes validation fields and handles odd details', () => {
    const error = new BridgeValidationError({
      code: 'VALIDATION_FAILED',
      message: 'x',
      details: { a: ['one', 'two'], b: 'single', c: 5 },
    });
    expect(error.fields).toEqual({ a: ['one', 'two'], b: ['single'] });
    expect(error.first('a')).toBe('one');
    expect(error.first('zzz')).toBeUndefined();
    expect(new BridgeValidationError({ code: 'V', message: 'x', details: ['x'] }).fields).toEqual({});
  });
});

describe('type guards', () => {
  const init = { code: 'X', message: 'x' };
  it.each([
    [isBridgeError, new BridgeError(init)],
    [isNetworkError, new BridgeNetworkError(init)],
    [isTimeoutError, new BridgeTimeoutError(init)],
    [isAbortError, new BridgeAbortError(init)],
    [isAuthenticationError, new BridgeAuthenticationError(init)],
    [isAuthorizationError, new BridgeAuthorizationError(init)],
    [isNotFoundError, new BridgeNotFoundError(init)],
    [isValidationError, new BridgeValidationError(init)],
    [isConflictError, new BridgeConflictError(init)],
    [isRateLimitError, new BridgeRateLimitError(init)],
    [isServerError, new BridgeServerError(init)],
    [isProtocolError, new BridgeProtocolError(init)],
  ] as const)('%o recognises its class', (guard, error) => {
    expect(guard(error)).toBe(true);
    expect(guard(new Error('plain'))).toBe(false);
    expect(guard(undefined)).toBe(false);
  });
});
