# Pagination

A paginated operation returns `Paginated<T>`:

```ts
interface Paginated<T> {
  items: T[];
  pagination: LengthAwarePagination | SimplePagination | CursorPagination;
}
```

`pagination.type` says which Laravel paginator produced it:

| `type` | From | Fields |
|--------|------|--------|
| `length_aware` | `paginate()` | `per_page`, `current_page`, `has_more`, `total`, `last_page` |
| `simple` | `simplePaginate()` | `per_page`, `current_page`, `has_more` |
| `cursor` | `cursorPaginate()` | `per_page`, `has_more`, `next_cursor`, `prev_cursor` |

Narrow on `type` before reading the fields only one kind has:

```ts
const page = await bridge.call('products.list', { page: 2 });
if (page.pagination.type === 'length_aware') {
  showPager(page.pagination.current_page, page.pagination.last_page);
}
```

How the page is requested is up to the operation's input: by convention a
`page` integer for page-number paginators and a `cursor` string for cursor
paginators.

For "load more" lists, use `infiniteQueryOptions` from
[`@atannex/bridge/query`](tanstack-query.md#infinite-lists), or the
`getNextPageParam` / `getPreviousPageParam` helpers with any other library.
