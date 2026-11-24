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
    // Every source cast states its invariant in a SAFETY comment instead. The kit's casts sit where
    // untrusted input enters (JWTs, the token-store file, form bodies) and are each followed by
    // runtime checks, so a comment beside them documents the boundary better than a ban would.
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'typescript/no-unsafe-type-assertion': 'off',
    // The kit is generic over tool payloads: MCP's structuredContent is a string-keyed record of
    // unknown values, and the audit logger summarizes arbitrary arguments. These rules ask for
    // domain types that the kit's callers own, not the kit.
    'quality/no-unsafe-dictionary-type': 'off',
    'quality/no-known-value-widening': 'off',
    'quality/no-unknown-returns': 'off',
    // Conditional spreads are how the kit leaves optional fields absent rather than undefined.
    'quality/no-conditional-empty-object-spread': 'off',
    // Helpers stay beside the factory that uses them.
    'unicorn/consistent-function-scoping': 'off',
    // Only registerLogged's schema-agnostic registerTool call, which carries a SAFETY comment.
    'typescript/no-unsafe-call': 'off',
  },
  overrides: [
    ...cloudflare.overrides,
    {
      // Tests build fixtures with casts whose invariant is the test itself, and read JSON
      // responses as any.
      files: ['test/**'],
      rules: {
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    {
      // bun-types declares `expect(promise).rejects` matchers as returning void, but Bun returns a
      // promise that must be awaited for the assertion to run.
      files: ['test/**'],
      rules: { 'typescript/await-thenable': 'off' },
    },
  ],
});
