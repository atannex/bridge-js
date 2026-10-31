/** The wire protocol version this client speaks. */
export const PROTOCOL_VERSION = '1';

/** Default route prefix on the Laravel side. */
export const DEFAULT_PREFIX = 'bridge/v1';

/** Request ids, correlation ids and idempotency keys must match this to be accepted by the server. */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Operation names the server accepts. */
export const OPERATION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export const MAX_OPERATION_LENGTH = 120;

export const MAX_CLIENT_HEADER_LENGTH = 64;

/** Error codes defined by protocol version 1. Servers may add more; clients fall back to the HTTP status. */
export const ERROR_CODES = [
  'MALFORMED_REQUEST',
  'UNSUPPORTED_VERSION',
  'TENANT_REQUIRED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TENANT_FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'CSRF_MISMATCH',
  'VALIDATION_FAILED',
  'TWO_FACTOR_FAILED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ProtocolErrorCode = (typeof ERROR_CODES)[number];

/** The code assumed when a failed response has no usable error envelope (for example a proxy's HTML 502). */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'MALFORMED_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 419:
      return 'CSRF_MISMATCH';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`;
  }
}
