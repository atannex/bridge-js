/**
 * TanStack Query helpers. No dependency on TanStack: these return plain option
 * objects that `useQuery`, `useInfiniteQuery` and `useMutation` accept, in
 * React, Vue, Solid or Svelte alike.
 *
 * ```ts
 * import { queryOptions } from '@atannex/bridge/query';
 * const { data } = useQuery(queryOptions(bridge, 'products.list', { page: 1 }));
 * ```
 *
 * Keys are `['bridge', scope, operation, input]`. `scope` defaults to the
 * tenant the call is sent for, so two tenants never share cached data. The
 * signed-in user is not part of the key: clear Bridge queries when the user
 * changes (`queryClient.removeQueries({ queryKey: ['bridge'] })`), or pass a
 * `scope` that includes the user.
 *
 * @packageDocumentation
 */
import type { Bridge, CallOptions } from '../client/create-bridge.js';
import type { Contract, HasOptionalInput, InputOf, OperationName, OutputOf, Paginated } from '../contracts/types.js';

/** Every Bridge query key starts with this, so `invalidate(queryClient)` can reach them all. */
export const QUERY_KEY_ROOT = 'bridge';

/** Which cache partition a query belongs to: a tenant id, your own string (e.g. `user:7/team:3`), or null. */
export type QueryScope = string | null;

export type BridgeQueryKey<K extends string = string, I = unknown> = readonly [typeof QUERY_KEY_ROOT, QueryScope, K, I];

/** Call options plus `scope`. Without `scope`, the scope is the call's `tenant`, else the client's. */
export interface QueryCallOptions extends CallOptions {
  scope?: QueryScope;
}

export type QueryArgs<C extends Contract, K extends OperationName<C>> =
  HasOptionalInput<InputOf<C, K>> extends true
    ? [input?: InputOf<C, K>, options?: QueryCallOptions]
    : [input: InputOf<C, K>, options?: QueryCallOptions];

type LooseCall = (operation: string, input?: unknown, options?: CallOptions) => Promise<unknown>;
const callOf = <C extends Contract>(bridge: Bridge<C>): LooseCall => bridge.call as unknown as LooseCall;

/**
 * Works out the key scope and the call options to use with it. When the scope
 * comes from the client's tenant, that tenant is pinned on the call too, so
 * the request always matches the key it is cached under.
 */
function scoped<C extends Contract>(
  bridge: Bridge<C>,
  options: QueryCallOptions = {},
): { scope: QueryScope; callOptions: CallOptions } {
  const { scope, ...callOptions } = options;
  if (scope !== undefined) return { scope, callOptions };
  if ('tenant' in callOptions) {
    // Widened: JavaScript callers can pass `tenant: undefined` explicitly.
    const tenant = callOptions.tenant as string | number | null | undefined;
    return { scope: tenant === null || tenant === undefined ? null : String(tenant), callOptions };
  }
  const tenant = bridge.currentTenant();
  return { scope: tenant, callOptions: { ...callOptions, tenant } };
}

/** `['bridge', scope, operation, input]`. TanStack hashes keys with sorted object keys, so input key order does not matter. */
export function queryKey<K extends string, I = Record<string, never>>(
  operation: K,
  input?: I,
  scope: QueryScope = null,
): BridgeQueryKey<K, I | Record<string, never>> {
  return [QUERY_KEY_ROOT, scope, operation, input ?? {}] as const;
}

export interface BridgeQueryOptions<K extends string, I, O> {
  queryKey: BridgeQueryKey<K, I | Record<string, never>>;
  queryFn: (context: { signal: AbortSignal }) => Promise<O>;
}

/** Options for `useQuery`. Cancellation from TanStack aborts the HTTP request. */
export function queryOptions<C extends Contract, K extends OperationName<C>>(
  bridge: Bridge<C>,
  operation: K,
  ...args: QueryArgs<C, K>
): BridgeQueryOptions<K, InputOf<C, K>, OutputOf<C, K>> {
  const [input, options] = args as [InputOf<C, K> | undefined, QueryCallOptions | undefined];
  const { scope, callOptions } = scoped(bridge, options);
  return {
    queryKey: queryKey(operation, input, scope),
    queryFn: ({ signal }) => callOf(bridge)(operation, input, { ...callOptions, signal }),
  };
}

export interface BridgeMutationOptions<K extends string, I, O> {
  mutationKey: readonly [typeof QUERY_KEY_ROOT, K];
  mutationFn: (input: I) => Promise<O>;
}

/**
 * Options for `useMutation`.
 *
 * With `{ idempotencyKey: true }` every `mutationFn` call gets a new key: the
 * Bridge client's own retries reuse it, but a retry by `useMutation` (its
 * `retry` option) is a new call with a new key and can repeat the write.
 * Leave `useMutation`'s `retry` at 0, or pass a string key you keep for one
 * user action.
 */
export function mutationOptions<C extends Contract, K extends OperationName<C>>(
  bridge: Bridge<C>,
  operation: K,
  options?: CallOptions,
): BridgeMutationOptions<K, InputOf<C, K>, OutputOf<C, K>> {
  return {
    mutationKey: [QUERY_KEY_ROOT, operation] as const,
    mutationFn: (input) => callOf(bridge)(operation, input, options),
  };
}

/** The structural part of TanStack's `QueryClient` that `invalidate` needs. */
export interface InvalidatingClient {
  invalidateQueries(filters: {
    queryKey?: readonly unknown[];
    predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
  }): unknown;
}

/**
 * Invalidates Bridge queries: all of them, one operation's in every scope, or
 * only those of one scope (`{ scope }`, optionally with an operation).
 */
export function invalidate(
  queryClient: InvalidatingClient,
  operation?: string,
  options: { scope?: QueryScope } = {},
): Promise<unknown> {
  if (options.scope !== undefined) {
    const key = operation === undefined ? [QUERY_KEY_ROOT, options.scope] : [QUERY_KEY_ROOT, options.scope, operation];
    return Promise.resolve(queryClient.invalidateQueries({ queryKey: key }));
  }
  if (operation === undefined) {
    return Promise.resolve(queryClient.invalidateQueries({ queryKey: [QUERY_KEY_ROOT] }));
  }
  return Promise.resolve(
    queryClient.invalidateQueries({
      queryKey: [QUERY_KEY_ROOT],
      predicate: (query) => query.queryKey[2] === operation,
    }),
  );
}

/** The next page parameter of a paginated output: a page number, a cursor, or undefined at the end. */
export function getNextPageParam(lastPage: Paginated<unknown>): number | string | undefined {
  const pagination = lastPage.pagination;
  if (pagination.type === 'cursor') return pagination.next_cursor ?? undefined;
  return pagination.has_more ? pagination.current_page + 1 : undefined;
}

/** The previous page parameter, for bidirectional infinite lists. */
export function getPreviousPageParam(firstPage: Paginated<unknown>): number | string | undefined {
  const pagination = firstPage.pagination;
  if (pagination.type === 'cursor') return pagination.prev_cursor ?? undefined;
  return pagination.current_page > 1 ? pagination.current_page - 1 : undefined;
}

type PageOutput<C extends Contract, K extends OperationName<C>> =
  OutputOf<C, K> extends Paginated<unknown> ? OutputOf<C, K> : never;

export interface BridgeInfiniteQueryOptions<K extends string, I, O> {
  queryKey: BridgeQueryKey<K, I | Record<string, never>>;
  initialPageParam: number | string | null;
  queryFn: (context: { signal: AbortSignal; pageParam: unknown }) => Promise<O>;
  getNextPageParam: (lastPage: O) => number | string | undefined;
  getPreviousPageParam: (firstPage: O) => number | string | undefined;
}

/**
 * Options for `useInfiniteQuery` over a paginated operation. `param` is the
 * input key that carries the page: `page` (default) for page-number
 * paginators, `cursor` for cursor paginators.
 */
export function infiniteQueryOptions<C extends Contract, K extends OperationName<C>>(
  bridge: Bridge<C>,
  operation: K,
  input?: Omit<InputOf<C, K>, 'page' | 'cursor'>,
  options: QueryCallOptions & { param?: 'page' | 'cursor' } = {},
): BridgeInfiniteQueryOptions<K, Omit<InputOf<C, K>, 'page' | 'cursor'>, PageOutput<C, K>> {
  const { param = 'page', ...rest } = options;
  const { scope, callOptions } = scoped(bridge, rest);
  return {
    queryKey: queryKey(operation, input, scope),
    initialPageParam: param === 'page' ? 1 : null,
    queryFn: ({ signal, pageParam }) => {
      const pageInput: Record<string, unknown> = { ...(input as Record<string, unknown> | undefined) };
      if (pageParam !== null && pageParam !== undefined) pageInput[param] = pageParam;
      return callOf(bridge)(operation, pageInput, { ...callOptions, signal }) as Promise<PageOutput<C, K>>;
    },
    getNextPageParam: (lastPage) => getNextPageParam(lastPage),
    getPreviousPageParam: (firstPage) => getPreviousPageParam(firstPage),
  };
}
