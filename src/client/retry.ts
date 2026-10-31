import type { IdempotencyLevel } from '../contracts/types.js';
import {
  BridgeError,
  BridgeNetworkError,
  BridgeRateLimitError,
  BridgeServerError,
  BridgeTimeoutError,
} from '../errors/errors.js';

/** When and how often to retry. Applies only to operations it is safe to repeat. */
export interface RetryPolicy {
  /** Total attempts, including the first. Default 3. `1` disables retries. */
  attempts?: number;
  /** First backoff delay in ms. Default 300. */
  baseDelay?: number;
  /** Largest backoff delay in ms. Default 5000. */
  maxDelay?: number;
  /** Longest `Retry-After` (seconds) worth waiting for; longer waits fail at once. Default 30. */
  maxRetryAfter?: number;
  /** Retry after a timeout. Default true. */
  retryTimeouts?: boolean;
}

export type ResolvedRetryPolicy = Required<RetryPolicy>;

export const DEFAULT_RETRY: Readonly<ResolvedRetryPolicy> = Object.freeze({
  attempts: 3,
  baseDelay: 300,
  maxDelay: 5000,
  maxRetryAfter: 30,
  retryTimeouts: true,
});

/** Merges `policy` over `base`. Always returns a new object, so callers may change it freely. */
export function resolveRetry(
  policy: RetryPolicy | false | undefined,
  base: Readonly<ResolvedRetryPolicy>,
): ResolvedRetryPolicy {
  const resolved = { ...base };
  if (policy === false) return { ...resolved, attempts: 1 };
  if (policy === undefined) return resolved;
  for (const [key, value] of Object.entries(policy) as [keyof RetryPolicy, number | boolean | undefined][]) {
    if (value !== undefined) (resolved as Record<string, unknown>)[key] = value;
  }
  return resolved;
}

/**
 * Whether repeating the request could do harm. Safe operations can always be
 * repeated; idempotent ones only when the server can recognise the repeat by
 * its idempotency key. Everything else — including operations the client knows
 * nothing about — is never retried.
 */
export function mayRepeat(level: IdempotencyLevel | undefined, hasIdempotencyKey: boolean): boolean {
  return level === 'safe' || (level === 'idempotent' && hasIdempotencyKey);
}

/** The wait before the next attempt, or undefined when this error must not be retried. */
export function retryDelay(
  error: BridgeError,
  attempt: number,
  policy: ResolvedRetryPolicy,
  random = Math.random,
): number | undefined {
  if (attempt >= policy.attempts) return undefined;

  if (error instanceof BridgeRateLimitError || (error instanceof BridgeServerError && error.status === 503)) {
    const after = error.retryAfter;
    if (after !== undefined) {
      return after > policy.maxRetryAfter ? undefined : after * 1000;
    }
  }

  const retryable =
    error instanceof BridgeNetworkError ||
    (error instanceof BridgeTimeoutError && policy.retryTimeouts) ||
    error instanceof BridgeRateLimitError ||
    (error instanceof BridgeServerError && (error.status === 502 || error.status === 503 || error.status === 504));
  if (!retryable) return undefined;

  const exponential = Math.min(policy.maxDelay, policy.baseDelay * 2 ** (attempt - 1));
  // "Equal jitter": half fixed, half random, so retries from many clients spread out.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
