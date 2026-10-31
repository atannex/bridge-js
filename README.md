# @atannex/bridge

A typed TypeScript client for Laravel apps that use [`atannex/bridge`](https://github.com/atannex/bridge). You register operations in Laravel, generate a contract with `php artisan bridge:generate`, and call them from browsers, React Native, Expo, Node, Bun or Deno with type-checked inputs and outputs. It handles Sanctum cookie sessions and mobile bearer tokens (with two-factor and refresh), safe retries, uploads and downloads with progress, and TanStack Query. No runtime dependencies.

## Install

```bash
npm install @atannex/bridge
```
