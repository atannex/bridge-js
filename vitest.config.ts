import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// Tests import the package by its public name, resolved to the sources.
const alias = [
  { find: /^@atannex\/bridge$/, replacement: src('index.ts') },
  { find: /^@atannex\/bridge\/(xhr|query|realtime|expo|react-native)$/, replacement: src('$1/index.ts') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'types',
          include: ['tests/types/**/*.test-d.ts'],
          typecheck: {
            enabled: true,
            only: true,
            include: ['tests/types/**/*.test-d.ts'],
            tsconfig: './tsconfig.json',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
        },
      },
    ],
  },
});
