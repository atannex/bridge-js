/** Where an error came from, for logs and error reporting. Never holds headers, tokens or bodies. */
export interface BridgeErrorInit {
  code: string;
  message: string;
  status?: number | undefined;
  details?: unknown;
  requestId?: string | undefined;
  operation?: string | undefined;
  cause?: unknown;
}

/**
 * Base class of every error the client throws.
 *
 * `code` is the protocol error code (for example `VALIDATION_FAILED`), `status`
 * the HTTP status when there was a response, and `requestId` the server's id
 * for the request, which is what to quote when reporting a problem.
 */
export class BridgeError extends Error {
  override readonly name: string = 'BridgeError';
  readonly code: string;
  readonly status: number | undefined;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly operation: string | undefined;

  constructor(init: BridgeErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.operation = init.operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** A plain, log-safe representation. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      details: this.details,
      requestId: this.requestId,
      operation: this.operation,
    };
  }
}

/** The request never got a response: offline, DNS failure, refused connection, CORS rejection. */
export class BridgeNetworkError extends BridgeError {
  override readonly name: string = 'BridgeNetworkError';
}

/** The request took longer than the configured timeout and was cancelled. */
export class BridgeTimeoutError extends BridgeError {
  override readonly name: string = 'BridgeTimeoutError';
}

/** The caller's `AbortSignal` cancelled the request. */
export class BridgeAbortError extends BridgeError {
  override readonly name: string = 'BridgeAbortError';
}

/** 401, or 419 for a session whose CSRF token is missing or stale. */
export class BridgeAuthenticationError extends BridgeError {
  override readonly name: string = 'BridgeAuthenticationError';
}

/** 403: signed in, but not allowed (includes `TENANT_FORBIDDEN`). */
export class BridgeAuthorizationError extends BridgeError {
  override readonly name: string = 'BridgeAuthorizationError';
}

/** 404: unknown operation, or a record the server reports as missing. */
export class BridgeNotFoundError extends BridgeError {
  override readonly name: string = 'BridgeNotFoundError';
}

/** 422: the input failed validation. */
export class BridgeValidationError extends BridgeError {
  override readonly name: string = 'BridgeValidationError';

  /** Messages per input path, for example `{ "items.0.quantity": ["..."] }`. */
  get fields(): Record<string, string[]> {
    const details = this.details;
    if (details === null || typeof details !== 'object' || Array.isArray(details)) {
      return {};
    }
    const fields: Record<string, string[]> = {};
    for (const [path, messages] of Object.entries(details as Record<string, unknown>)) {
      if (Array.isArray(messages)) {
        fields[path] = messages.filter((m): m is string => typeof m === 'string');
      } else if (typeof messages === 'string') {
        fields[path] = [messages];
      }
    }
    return fields;
  }

  /** The first message for one input path, if any. */
  first(path: string): string | undefined {
    return this.fields[path]?.[0];
  }
}

/** 409: a conflict, or a reused / still-running idempotency key. */
export class BridgeConflictError extends BridgeError {
  override readonly name: string = 'BridgeConflictError';
}

/** 429: too many requests. */
export class BridgeRateLimitError extends BridgeError {
  override readonly name: string = 'BridgeRateLimitError';
  /** Seconds the server asked us to wait, when it said. */
  readonly retryAfter: number | undefined;

  constructor(init: BridgeErrorInit & { retryAfter?: number | undefined }) {
    super(init);
    this.retryAfter = init.retryAfter;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfter: this.retryAfter };
  }
}

/** 5xx. */
export class BridgeServerError extends BridgeError {
  override readonly name: string = 'BridgeServerError';
  /** Seconds the server asked us to wait (503 with `Retry-After`), when it said. */
  readonly retryAfter: number | undefined;

  constructor(init: BridgeErrorInit & { retryAfter?: number | undefined }) {
    super(init);
    this.retryAfter = init.retryAfter;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfter: this.retryAfter };
  }
}

/** A response that does not follow the Bridge protocol (wrong shape, not JSON on success, ...). */
export class BridgeProtocolError extends BridgeError {
  override readonly name: string = 'BridgeProtocolError';
}
