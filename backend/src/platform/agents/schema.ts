import type { JsonSchema } from './contracts';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

export function validateSchema(value: unknown, schema: JsonSchema, path: string = '$'): string[] {
    try {
        // Keep contracts with the same $id isolated instead of reusing another schema.
        const result = new AjvJsonSchemaValidator().getValidator(schema)(value);
        return result.valid ? [] : [`${path}: ${result.errorMessage}`];
    } catch {
        return [`${path}: invalid or unsupported JSON Schema`];
    }
}
