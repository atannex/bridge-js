import type { BridgeResponse } from '../contracts/types.js';
import type { BridgeError } from '../errors/errors.js';
import type { TransportRequest } from '../transport/types.js';

export interface InterceptorContext {
  /** The operation being called, or undefined for auth and download requests. */
  operation: string | undefined;
  /** 1 for the first attempt, 2 for the first retry, ... */
  attempt: number;
}

/**
 * Runs before each attempt is sent, before the auth adapter adds credentials,
 * so interceptors never see tokens. Mutate the request or return a new one.
 */
export type RequestInterceptor = (
  request: TransportRequest,
  context: InterceptorContext,
) => TransportRequest | void | Promise<TransportRequest | void>;

/** Runs on each successful operation response. Return a replacement or nothing. */
export type ResponseInterceptor = (
  response: BridgeResponse<unknown>,
  context: InterceptorContext,
) => BridgeResponse<unknown> | void | Promise<BridgeResponse<unknown> | void>;

/** Runs once on the final error of a call (after retries). Return a replacement error or nothing. */
export type ErrorInterceptor = (
  error: BridgeError,
  context: InterceptorContext,
) => BridgeError | void | Promise<BridgeError | void>;

export interface InterceptorList<T> {
  /** Adds an interceptor; returns a function that removes it. */
  use(interceptor: T): () => void;
  readonly items: readonly T[];
}

export function interceptorList<T>(initial: readonly T[] = []): InterceptorList<T> {
  let items: readonly T[] = [...initial];
  return {
    use(interceptor) {
      items = [...items, interceptor];
      let removed = false;
      return () => {
        // Removes this registration only: the same function added twice stays once.
        if (removed) return;
        removed = true;
        const index = items.lastIndexOf(interceptor);
        if (index !== -1) items = [...items.slice(0, index), ...items.slice(index + 1)];
      };
    },
    get items() {
      return items;
    },
  };
}
