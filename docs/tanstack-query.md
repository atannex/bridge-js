# TanStack Query

`@atannex/bridge/query` builds option objects for TanStack Query v5. It does not
import TanStack, so it works with the React, Vue, Solid and Svelte adapters
alike, and Bridge adds no cache of its own.

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidate, mutationOptions, queryOptions } from '@atannex/bridge/query';

const product = useQuery(queryOptions(bridge, 'products.show', { id }));

const queryClient = useQueryClient();
const addToCart = useMutation({
  ...mutationOptions(bridge, 'cart.add', { idempotencyKey: true }),
  onSuccess: () => invalidate(queryClient, 'cart.show'),
});
addToCart.mutate({ product_id: id, quantity: 1 });
```

Types flow through: `product.data` is the operation's output,
`addToCart.mutate` takes its input.

## Keys

Every key is `['bridge', scope, operation, input]`
(`queryKey(operation, input, scope)`). TanStack hashes object keys in sorted
order, so `{ a, b }` and `{ b, a }` share a cache entry.

`scope` keeps cached data of different tenants apart. It is, in order:

1. the `scope` option, if you pass one (any string, or `null`);
2. the call's `tenant` option;
3. the client's `tenant` at the moment the options are built. That tenant is
   also pinned on the request, so the data cached under a key is always the
   data of the tenant the key names.

If the client's `tenant` is an async function, the helpers cannot know it in
advance and throw: pass `scope` explicitly.

The signed-in **user is not in the key**. When the user signs out or another
user signs in, drop every Bridge query so nothing of the previous user is
shown:

```ts
await auth.logout();
queryClient.removeQueries({ queryKey: ['bridge'] });
```

Do the same when switching tenant if you'd rather not keep the old tenant's
data in memory. Alternatively, pass a `scope` that includes the user
(for example `scope: 'user:7/team:3'`).

- `invalidate(queryClient, 'cart.show')` invalidates `cart.show` in every scope.
- `invalidate(queryClient, 'cart.show', { scope: '2' })` only in scope `'2'`.
- `invalidate(queryClient)` invalidates every Bridge query.

## Cancellation

`queryFn` passes TanStack's `signal` to the call, so unmounting or a newer
query aborts the HTTP request.

## Mutations and idempotency

Pass `{ idempotencyKey: true }` for operations the server marks idempotent.
The Bridge client then retries the call with the same key, so its own retries
cannot create two orders.

But `idempotencyKey: true` makes a **new key for every `mutationFn` call**. If
`useMutation` itself retries (its `retry` option), or the user taps the button
twice, that is a new call with a new key, and the server will run the write
again. So:

- keep `useMutation`'s `retry` at its default (0) — the Bridge client already
  retries what is safe;
- for writes that must happen once per user intent (placing an order,
  paying), make one key when the intent starts and pass that string:

```ts
const [checkoutKey] = useState(() => crypto.randomUUID()); // one per checkout screen
const placeOrder = useMutation(mutationOptions(bridge, 'orders.create', { idempotencyKey: checkoutKey }));
// After success, start a new intent with a new key.
```

## Infinite lists

```ts
import { useInfiniteQuery } from '@tanstack/react-query';
import { infiniteQueryOptions } from '@atannex/bridge/query';

const products = useInfiniteQuery(infiniteQueryOptions(bridge, 'products.list', { search }));
const feed = useInfiniteQuery(infiniteQueryOptions(bridge, 'feed.list', {}, { param: 'cursor' }));
```

`param` is the input key that carries the page: `page` (the default, starting
at 1) or `cursor` (starting with none). The next and previous page parameters
come from the response's `pagination`.

Infinite queries are keyed `['bridge', scope, operation, input, 'infinite']`,
so they never share a cache entry with a plain query of the same input
(TanStack stores pages for one and the output for the other). `invalidate`
and `['bridge']` prefix filters reach both.

## Optimistic updates

Use TanStack's own pattern with the Bridge keys:

```ts
useMutation({
  ...mutationOptions(bridge, 'cart.remove'),
  onMutate: async ({ product_id }) => {
    const key = queryKey('cart.show', {}, bridge.currentTenant());
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData<Cart>(key);
    queryClient.setQueryData<Cart>(key, (cart) => cart && { ...cart, items: cart.items.filter((i) => i.product_id !== product_id) });
    return { previous };
  },
  onError: (_error, _input, context) => queryClient.setQueryData(queryKey('cart.show', {}, bridge.currentTenant()), context?.previous),
  onSettled: () => invalidate(queryClient, 'cart.show'),
});
```

Always refetch after an optimistic update: the server's answer is the truth.
