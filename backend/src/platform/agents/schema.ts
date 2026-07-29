import type { JsonSchema } from './contracts';

export function validateSchema(value: unknown, schema: JsonSchema, path: string = '$'): string[] {
    const errors: string[] = [];
    if (schema.enum && !schema.enum.some(item => Object.is(item, value))) errors.push(`${path} is not an allowed value`);
    if (!schema.type) return errors;
    if (schema.type === 'null') { if (value !== null) errors.push(`${path} must be null`); return errors; }
    if (schema.type === 'array') {
        if (!Array.isArray(value)) return [...errors, `${path} must be an array`];
        if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items!, `${path}[${index}]`)));
        return errors;
    }
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [...errors, `${path} must be an object`];
        const record = value as Record<string, unknown>;
        for (const field of schema.required || []) if (!(field in record)) errors.push(`${path}.${field} is required`);
        for (const [field, child] of Object.entries(schema.properties || {})) if (field in record) errors.push(...validateSchema(record[field], child, `${path}.${field}`));
        return errors;
    }
    const actual = typeof value;
    if (schema.type === 'integer') { if (actual !== 'number' || !Number.isInteger(value)) errors.push(`${path} must be an integer`); }
    else if (actual !== schema.type) errors.push(`${path} must be a ${schema.type}`);
    return errors;
}
