import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'docs/',
      'coverage/',
      'examples/astro/**/*.astro',
      'tests/integration/contract.generated.ts',
      // Plain JavaScript run unchanged by Node, Bun, Deno and a browser; not type-checked.
      'tests/smoke/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-invalid-void-type': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Abort reasons are rejected as-is so callers can tell them apart.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingAny: true }],
      '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: true }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'src must run in browsers and React Native.' }] },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', 'require', '__dirname', '__filename'],
      'no-console': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'examples/**/*.ts', 'examples/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
);
