import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isAuthenticationError } from '@atannex/bridge';
import { infiniteQueryOptions, invalidate, mutationOptions } from '@atannex/bridge/query';
import { bridge } from './bridge.js';

export function ProductList({ search }: { search: string }) {
  const queryClient = useQueryClient();
  const products = useInfiniteQuery(infiniteQueryOptions(bridge, 'products.list', { search }));
  const addToCart = useMutation({
    // A fresh idempotency key per click; safe to retry on a flaky network.
    ...mutationOptions(bridge, 'cart.add', { idempotencyKey: true }),
    onSuccess: () => invalidate(queryClient, 'cart.show'),
  });

  if (products.isPending) return <p>Loading…</p>;
  if (products.isError) return <p role="alert">{products.error.message}</p>;

  return (
    <>
      <ul>
        {products.data.pages
          .flatMap((page) => page.items)
          .map((product) => (
            <li key={product.id}>
              {product.name} — {product.price}
              <button
                disabled={addToCart.isPending}
                onClick={() => addToCart.mutate({ product_id: product.id, quantity: 1 })}
              >
                Add to cart
              </button>
            </li>
          ))}
      </ul>
      {addToCart.error && isAuthenticationError(addToCart.error) && <p>Sign in to add items.</p>}
      {products.hasNextPage && (
        <button onClick={() => void products.fetchNextPage()} disabled={products.isFetchingNextPage}>
          More
        </button>
      )}
    </>
  );
}
