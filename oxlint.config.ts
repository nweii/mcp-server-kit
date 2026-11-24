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
    // The kit reports startup and token-store failures on stderr; console is its operator log.
    'no-console': 'off',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    // Deferred: each finding in existing code needs a per-site decision, mostly about type assertions
    // and loose types at the SDK and Express boundaries. Enable one rule per change.
    'typescript/no-unsafe-type-assertion': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'quality/no-conditional-empty-object-spread': 'off',
    'quality/no-known-value-widening': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'typescript/no-unsafe-return': 'off',
    'quality/no-unknown-returns': 'off',
    'typescript/no-unsafe-call': 'off',
    'anti-slop/require-safety-comment-for-type-assertion': 'off',
  },
  overrides: [
    ...cloudflare.overrides,
    {
      // Tests build fixtures with casts whose invariant is the test itself.
      files: ['test/**'],
      rules: { 'anti-slop/require-safety-comment-for-type-assertion': 'off' },
    },
    {
      // bun-types declares `expect(promise).rejects` matchers as returning void, but Bun returns a
      // promise that must be awaited for the assertion to run.
      files: ['test/**'],
      rules: { 'typescript/await-thenable': 'off' },
    },
  ],
});
