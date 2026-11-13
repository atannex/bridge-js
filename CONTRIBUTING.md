# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are all welcome. For a new feature or an API
change, please open an issue first so the design can be agreed before you write code.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setup

Node 22 or later (the test tooling needs Node 20+; the published package also supports older runtimes).

```bash
npm ci
npm run build
npm test
```

## Before you open a pull request

Run the same checks CI runs:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage   # fails below the coverage thresholds in vitest.config.ts
npm run test:types
npm run check:exports
npm run api:check       # fails when the public API changed
npm run size            # fails over the size budgets in .size-limit.json
```

- **Every bug fix needs a test** that fails without the fix.
- **Public API changes** show up as a diff in `api/`. If the change is intended, run `npm run api:update`, commit
  `api/`, and say in the pull request whether it is a patch, minor or major change under semver. Removing or
  narrowing anything public is a major change.
- **Size budgets** in `.size-limit.json` are raised only with a reason in the pull request.
- **`src/` runs everywhere**: browsers, React Native, Node, Bun and Deno. No `node:` imports, no Node globals, no
  runtime dependencies (ESLint enforces the first two).
- Add a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Match the existing style: comments explain why, not what.

## Integration tests

`npm run test:integration` runs against a real Laravel app with `atannex/bridge`. Set `BRIDGE_TEST_URL` to it; see
[docs/testing.md](docs/testing.md).

## Releasing (maintainers)

1. Move the `## Unreleased` changelog entries under `## x.y.z — YYYY-MM-DD`.
2. `npm version x.y.z` (updates `package.json` and tags `vx.y.z`).
3. `git push --follow-tags`. The Release workflow checks the tag, runs every check and publishes to npm with
   provenance.
