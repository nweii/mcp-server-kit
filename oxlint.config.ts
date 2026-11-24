// ABOUTME: Oxlint config: Cloudflare's preset plus the vendored anti-slop rules it doesn't cover.
import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [...cloudflare.ignorePatterns, 'tools/oxlint/anti-slop/**'],
  jsPlugins: [
    ...cloudflare.jsPlugins,
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
  ],
  rules: {
    ...cloudflare.rules,
    // Single-line guard clauses stay brace-less; multi-line bodies need braces.
    curly: ['error', 'multi-line'],
    'typescript/no-unsafe-type-assertion': 'off', // Temporary during migration
    'quality/no-unsafe-dictionary-type': 'off', // Temporary during migration
    'quality/no-conditional-empty-object-spread': 'off', // Temporary during migration
    'quality/no-known-value-widening': 'off', // Temporary during migration
    'no-console': 'off', // Temporary during migration
    'unicorn/consistent-function-scoping': 'off', // Temporary during migration
    'typescript/no-non-null-assertion': 'off', // Temporary during migration
    'no-promise-executor-return': 'off', // Temporary during migration
    'unicorn/prefer-string-replace-all': 'off', // Temporary during migration
    'unicorn/catch-error-name': 'off', // Temporary during migration
    'typescript/no-unsafe-return': 'off', // Temporary during migration
    'quality/no-unknown-returns': 'off', // Temporary during migration
    'typescript/no-misused-promises': 'off', // Temporary during migration
    'quality/no-array-filter-map': 'off', // Temporary during migration
    'unicorn/prefer-number-properties': 'off', // Temporary during migration
    'unicorn/numeric-separators-style': 'off', // Temporary during migration
    'typescript/no-unsafe-call': 'off', // Temporary during migration
    'typescript/no-floating-promises': 'off', // Temporary during migration
    'typescript/await-thenable': 'off', // Temporary during migration
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'off', // Temporary during migration
  },
  overrides: [
    ...cloudflare.overrides,
    {
      // Tests build fixtures with casts whose invariant is the test itself.
      files: ['test/**'],
      rules: { 'anti-slop/require-safety-comment-for-type-assertion': 'off' },
    },
    {
      files: ['**/*.ts'],
      rules: { '@typescript-eslint/no-floating-promises': 'off' }, // Temporary during migration
    },
  ],
});
