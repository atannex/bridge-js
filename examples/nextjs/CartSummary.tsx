'use client';

// A client component in the Next.js App Router. It runs in the browser, so it
// can use the cookie session like any SPA.
//
// Server components and route handlers run on your Next.js server, which has
// no access to the visitor's browser cookies for the Laravel domain. Call
// Laravel from there only with credentials the server holds itself (for
// example a bearer token for a service account, kept in an environment
// variable), never by forwarding the visitor's session cookie to another host.

import { useQuery } from '@tanstack/react-query';
import { queryOptions } from '@atannex/bridge/query';
import { createBridge, sanctumSession } from '@atannex/bridge';
import { operations, type AppBridge } from '../generated/bridge.js';

const bridge = createBridge<AppBridge>({
  baseURL: 'https://api.example.com',
  operations,
  auth: sanctumSession(),
});

export default function CartSummary() {
  const cart = useQuery(queryOptions(bridge, 'cart.show'));
  if (cart.isPending) return <span>…</span>;
  if (cart.isError) return <span>Cart unavailable</span>;
  return (
    <span>
      {cart.data.items.length} items · {cart.data.total}
    </span>
  );
}
