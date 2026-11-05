import { expect, test } from 'bun:test';
import { validateSchema } from '@/platform/agents/schema';

test('validates standard JSON Schema constraints and nullable fields used by external tools', () => {
    const schema = { type: 'object' as const, required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string' as const, minLength: 2 }, count: { type: ['integer', 'null'] as const, minimum: 1 } },
    };
    expect(validateSchema({ name: 'ok', count: null }, schema)).toEqual([]);
    for (const value of [{ name: 'x' }, { name: 'ok', count: 0 }, { name: 'ok', extra: true }]) expect(validateSchema(value, schema).length).toBeGreaterThan(0);
});

test('validates local schema references, alternatives and nested arrays', () => {
    const schema = { type: 'object' as const, $defs: { path: { type: 'string' as const, pattern: '^notes/' } },
        properties: { paths: { type: 'array' as const, minItems: 1, items: { $ref: '#/$defs/path' } },
            mode: { oneOf: [{ const: 'all' }, { type: 'integer' as const, minimum: 1 }] } }, required: ['paths', 'mode'],
    };
    expect(validateSchema({ paths: ['notes/example.md'], mode: 2 }, schema)).toEqual([]);
    expect(validateSchema({ paths: [], mode: 'other' }, schema).length).toBeGreaterThan(0);
    expect(validateSchema({ paths: ['outside/file'], mode: 'all' }, schema).length).toBeGreaterThan(0);
});

test('does not reuse another contract with the same schema id and fails closed on invalid schemas', () => {
    expect(validateSchema('hello', { $id: 'https://example.invalid/shared', type: 'string' })).toEqual([]);
    expect(validateSchema('hello', { $id: 'https://example.invalid/shared', type: 'integer' }).length).toBeGreaterThan(0);
    expect(validateSchema({}, { $ref: 'https://example.invalid/not-loaded' })).toEqual(['$: invalid or unsupported JSON Schema']);
    expect(validateSchema({ value: 1 }, { properties: { value: false } }).length).toBeGreaterThan(0);
});
