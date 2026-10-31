# Examples

Small, type-checked snippets showing `@atannex/bridge` in each framework. They
are not runnable apps; `npm run typecheck` compiles them against the package
sources, React's and Vue's types and TanStack Query, so they stay correct.

`generated/bridge.ts` stands in for the file `php artisan bridge:generate`
writes into your app.

| Folder   | Shows                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| `react`  | Cookie-session login (Sanctum SPA) and a product list with TanStack Query      |
| `nextjs` | A client component; why server components should not share the browser session |
| `vue`    | A composable around `bridge.call`, with validation errors                      |
| `astro`  | A plain `<script>` island, no framework                                        |

The `.astro` file is not type-checked (that needs Astro's compiler); the
script it imports is.

For React Native and Expo, see the example app in the `atannex/bridge`
workspace (`bridge-workspace/expo-app`).
