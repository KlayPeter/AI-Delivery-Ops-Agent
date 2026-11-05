import { expect, test } from 'bun:test';
import { mcpArguments } from './mcpInput.ts';

test('MCP arguments preserve nested JSON objects and reject non-object, invalid and oversized input', () => {
  expect(mcpArguments('{"query":"资料","options":{"limit":2}}')).toEqual({ query: '资料', options: { limit: 2 } });
  expect(mcpArguments('{}')).toEqual({});
  for (const value of ['', '{', 'null', '42', '"text"', '[]', '{"query":"' + '资'.repeat(11000) + '"}']) expect(() => mcpArguments(value)).toThrow();
});
