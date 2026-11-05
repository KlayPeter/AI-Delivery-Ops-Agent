import { z } from 'zod';
import { publicPageUrl } from '@/knowledge/web/network';
import type { JsonSchema } from '@/platform/agents/contracts';

export function publicApiUrl(value: string): URL {
    const url = publicPageUrl(value);
    if (url.protocol !== 'https:' || url.search || new URL(value).hash) throw new Error('OpenAPI 地址必须为无凭据、查询参数或片段的公开 HTTPS 地址');
    return url;
}
export const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const inspectInput = z.object({ url: z.string().max(1024).refine(value => { try { publicApiUrl(value); return true; } catch { return false; } }, '请填写公开 HTTPS 的 JSON/YAML 规范地址'), serviceId: identifier }).strict();
const scalar = z.union([z.string().max(1024), z.number(), z.boolean()]);
const primitiveSchema = z.object({ type: z.enum(['string', 'number', 'integer', 'boolean']), enum: z.array(scalar).min(1).max(1000).optional(),
    minimum: z.number().optional(), maximum: z.number().optional(), minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), format: z.string().max(64).optional(),
}).strict().superRefine((schema, ctx) => {
    if (schema.format !== undefined && schema.type !== 'string') ctx.addIssue({ code: 'custom', message: '格式约束只支持字符串' });
    if (schema.enum?.some(value => schema.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== (schema.type === 'number' ? 'number' : schema.type))) ctx.addIssue({ code: 'custom', message: '枚举类型与参数类型不一致' });
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) ctx.addIssue({ code: 'custom', message: '数值范围反向' });
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) ctx.addIssue({ code: 'custom', message: '字符串范围反向' });
    if (schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined)) ctx.addIssue({ code: 'custom', message: '字符串约束类型不匹配' });
    if (!['number', 'integer'].includes(schema.type) && (schema.minimum !== undefined || schema.maximum !== undefined)) ctx.addIssue({ code: 'custom', message: '数值约束类型不匹配' });
});
export const valueSchema = z.union([primitiveSchema, z.object({ type: z.literal('array'), items: primitiveSchema, minItems: z.number().int().min(0).max(100).optional(), maxItems: z.number().int().min(0).max(100).default(100), uniqueItems: z.boolean().optional() }).strict().refine(value => (value.minItems || 0) <= value.maxItems, '数组范围反向')]);
export const parameterSchema = z.object({ name: z.string().min(1).max(128).refine(name => !['__proto__', 'constructor', 'prototype'].includes(name)), in: z.enum(['path', 'query']), required: z.boolean(), explode: z.boolean(), schema: valueSchema, description: z.string().max(1000) }).strict();
export type ApiParameter = z.infer<typeof parameterSchema>;
export const pathSchema = z.string().min(1).max(512).refine(value => value.startsWith('/') && !value.startsWith('//') && !/[\\?#%\s]/.test(value) && !value.split('/').some(part => ['.', '..'].includes(part)) && !/[{}]/.test(value.replace(/\{[A-Za-z_][\w.-]*\}/g, '')), '不支持的接口路径');
export const operationSchema = z.object({ key: z.string().max(520), alias: identifier, method: z.literal('GET'), path: pathSchema, summary: z.string().max(1000), parameters: z.array(parameterSchema).max(40) }).strict().superRefine((operation, ctx) => {
    if (operation.key !== `GET ${operation.path}`) ctx.addIssue({ code: 'custom', message: '接口标识与路径不匹配' });
    const names = operation.parameters.map(parameter => `${parameter.in}:${parameter.name}`);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: '参数重复' });
    const placeholders = [...operation.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    const paths = operation.parameters.filter(parameter => parameter.in === 'path');
    if (paths.some(parameter => !parameter.required || parameter.schema.type === 'array' || !placeholders.includes(parameter.name)) || placeholders.some(name => !paths.some(parameter => parameter.name === name))) ctx.addIssue({ code: 'custom', message: '路径参数契约不匹配' });
});
export const sourceSchema = z.object({ url: inspectInput.shape.url, sha256: z.string().regex(/^[a-f0-9]{64}$/), openapi: z.string().regex(/^3\.[01]\.\d+$/), title: z.string().max(200) }).strict();
export const grantedOperation = operationSchema.safeExtend({ serverUrl: inspectInput.shape.url });
export const connectorConfig = z.object({ serviceId: identifier, reviewedReadOnly: z.literal(true), source: sourceSchema, operations: z.array(grantedOperation).min(1).max(20) }).strict().superRefine((value, ctx) => {
    if (new Set(value.operations.map(operation => operation.key)).size !== value.operations.length || new Set(value.operations.map(operation => operation.alias)).size !== value.operations.length) ctx.addIssue({ code: 'custom', message: '接口或工具别名重复' });
});
export type GrantedOperation = z.infer<typeof grantedOperation>;
export function argumentsSchema(operation: z.infer<typeof operationSchema>): JsonSchema {
    const bounded = (schema: any) => schema.type === 'integer' ? { ...schema, minimum: Math.max(Number.MIN_SAFE_INTEGER, schema.minimum ?? Number.MIN_SAFE_INTEGER), maximum: Math.min(Number.MAX_SAFE_INTEGER, schema.maximum ?? Number.MAX_SAFE_INTEGER) } : schema;
    const properties = Object.fromEntries(['path', 'query'].map(location => {
        const parameters = operation.parameters.filter(parameter => parameter.in === location);
        return [location, { type: 'object', properties: Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.schema.type === 'array' ? { ...parameter.schema, items: bounded(parameter.schema.items) } : bounded(parameter.schema)])), required: parameters.filter(parameter => parameter.required).map(parameter => parameter.name), additionalProperties: false }];
    }));
    return { type: 'object', properties, required: ['path', 'query'].filter(location => operation.parameters.some(parameter => parameter.in === location && parameter.required)), additionalProperties: false };
}
export function operationUrl(operation: GrantedOperation, args: { path?: Record<string, unknown>; query?: Record<string, unknown> }): URL {
    let pathname = operation.path;
    for (const parameter of operation.parameters.filter(parameter => parameter.in === 'path')) {
        const value = String(args.path?.[parameter.name]);
        if (!/^[A-Za-z0-9._~-]+$/.test(value) || ['.', '..'].includes(value)) throw new Error('路径参数仅支持非空的字母、数字和安全标识符');
        pathname = pathname.replaceAll(`{${parameter.name}}`, encodeURIComponent(value));
    }
    const base = publicApiUrl(operation.serverUrl), url = new URL(base.href);
    url.pathname = base.pathname.replace(/\/$/, '') + pathname;
    for (const parameter of operation.parameters.filter(parameter => parameter.in === 'query')) {
        const value = args.query?.[parameter.name]; if (value === undefined) continue;
        if (Array.isArray(value)) {
            if (parameter.explode) for (const item of value) url.searchParams.append(parameter.name, String(item));
            else { if (value.some(item => String(item).includes(','))) throw new Error('逗号分隔的数组值不能包含逗号'); url.searchParams.append(parameter.name, value.map(String).join(',')); }
        } else url.searchParams.append(parameter.name, String(value));
    }
    if (url.origin !== base.origin || url.href.length > 1024) throw new Error('接口地址越界或超过 1024 字符');
    return url;
}
