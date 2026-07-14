// Unit tests for the tool-result helpers, focused on structuredResult: it validates through the
// given schema, attaches the parsed value as structuredContent, and defaults the text block to
// pretty JSON of the parsed data (a custom toText receives that parsed data, never the raw input).
import { expect, test } from 'bun:test';
import { structuredResult } from '../src/index.js';

// The helper only needs `{ parse }`; a hand-rolled stand-in exercises its contract without a Zod dep.
const okSchema = { parse: (d: unknown) => d as { a: number } };
const rejectingSchema = {
  parse: (_d: unknown): { a: number } => {
    throw new Error('bad shape');
  },
};

test('structuredResult attaches parsed structuredContent and stringifies text by default', () => {
  const r = structuredResult(okSchema, { a: 1 });
  expect(r.structuredContent).toEqual({ a: 1 });
  expect(r.content).toEqual([{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }]);
  expect(r.isError).toBeUndefined();
});

test('structuredResult passes the parsed data to a custom toText', () => {
  const r = structuredResult(okSchema, { a: 2 }, (p) => `a=${p.a}`);
  expect(r.content).toEqual([{ type: 'text', text: 'a=2' }]);
  expect(r.structuredContent).toEqual({ a: 2 });
});

test('structuredResult surfaces (does not swallow) a schema validation failure', () => {
  expect(() => structuredResult(rejectingSchema, { a: 3 })).toThrow(/bad shape/);
});
