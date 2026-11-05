import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { fetchPublicPage, publicWebTransport, type WebTransport } from '@/knowledge/web/network';
import { argumentsSchema, inspectInput, operationSchema, parameterSchema, pathSchema, publicApiUrl, sourceSchema, valueSchema } from './contracts';

const object = (value: unknown): Record<string, any> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenAPI 文档节点不是对象'); return value as Record<string, any>; };
export async function fetchApiData(value: string, signal: AbortSignal, network: WebTransport = publicWebTransport) {
    const url = new URL(value); publicApiUrl(url.origin + url.pathname); if (url.hash) throw new Error('OpenAPI 请求不接受片段');
    return fetchPublicPage(value, 1024 * 1024, 15_000, signal, { resolve: host => network.resolve(host), async request(url, address, maxBytes, active) {
        const response = await network.request(url, address, maxBytes, active, 'application/json, application/yaml, text/yaml, text/plain');
        if (response.status >= 300 && response.status < 400) throw new Error('OpenAPI 不跟随重定向');
        return response;
    } });
}
export function readCatalog(text: string, url: string, serviceId: string) {
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('OpenAPI 规范超过 1 MiB');
    inspectInput.parse({ url, serviceId });
    const document = object(parse(text, { maxAliasCount: 0, uniqueKeys: true }));
    const source = sourceSchema.parse({ url, sha256: createHash('sha256').update(text).digest('hex'), openapi: document.openapi, title: String(document.info?.title || 'OpenAPI').slice(0, 200) });
    const resolve = (value: unknown) => {
        let node = object(value); const seen = new Set<string>();
        while (node.$ref) {
            const ref = node.$ref;
            if (typeof ref !== 'string' || !/^#\/components\/(schemas|parameters|responses)\//.test(ref) || seen.has(ref) || seen.size >= 16 || Object.keys(node).some(key => key !== '$ref')) throw new Error('仅支持有界的本文件组件引用');
            seen.add(ref); let current: unknown = document;
            for (const encoded of ref.slice(2).split('/')) {
                const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
                if (['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(object(current), key)) throw new Error('组件引用不存在');
                current = object(current)[key];
            }
            node = object(current);
        }
        return node;
    };
    const normalizeSchema = (value: unknown): ReturnType<typeof valueSchema.parse> => {
        const raw = resolve(value);
        if (raw.nullable === true) throw new Error('暂不支持可空参数');
        const annotations = new Set(['description', 'title', 'example', 'examples', 'default', 'deprecated', 'nullable', 'readOnly', 'writeOnly', 'xml', 'externalDocs']);
        const schema = Object.fromEntries(Object.entries(raw).filter(([key]) => !annotations.has(key)));
        if (['int32', 'int64', 'float', 'double'].includes(schema.format as string)) {
            if (schema.type !== (String(schema.format).startsWith('int') ? 'integer' : 'number')) throw new Error('数值格式与类型不一致');
            if (schema.format === 'int32') {
                if (['minimum', 'maximum'].some(key => schema[key] !== undefined && typeof schema[key] !== 'number')) throw new Error('数值范围必须为数字');
                schema.minimum = Math.max(-2147483648, Number(schema.minimum ?? -2147483648));
                schema.maximum = Math.min(2147483647, Number(schema.maximum ?? 2147483647));
            }
            delete schema.format;
        }
        if (schema.type === 'array') {
            if (resolve(schema.items).type === 'array' || (schema.maxItems !== undefined && typeof schema.maxItems !== 'number')) throw new Error('不支持嵌套数组或无效数组限制');
            schema.items = normalizeSchema(schema.items); schema.maxItems = Math.min(Number(schema.maxItems ?? 100), 100);
        }
        return valueSchema.parse(schema);
    };
    const entries = Object.entries(object(document.paths));
    if (entries.length > 200) throw new Error('OpenAPI 路径超过 200 条');
    const aliases = new Set<string>();
    const operations: Array<Record<string, any>> = [];
    for (const [path, rawPath] of entries) {
        const item = object(rawPath);
        for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
            if (!item[method]) continue;
            if (operations.length >= 200) throw new Error('OpenAPI 接口超过 200 条');
            const raw = object(item[method]), key = `${method.toUpperCase()} ${path}`;
            let alias = `${method}-${String(raw.operationId || path)}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+$/g, '').slice(0, 58);
            const base = alias; for (let suffix = 2; aliases.has(alias); suffix++) alias = `${base}-${suffix}`;
            aliases.add(alias);
            const summary = String(raw.summary || raw.description || key).slice(0, 1000);
            const entry: Record<string, any> = { key, alias, method: method.toUpperCase(), path: path.slice(0, 512), summary, servers: [], parameters: [] };
            try {
                if (method !== 'get') throw new Error('当前仅支持经审查的 GET 读取');
                pathSchema.parse(path);
                if (item.$ref || raw.requestBody || raw.callbacks) throw new Error('暂不支持路径引用、请求正文或回调');
                const security = Object.hasOwn(raw, 'security') ? raw.security : document.security;
                if (security !== undefined && (!Array.isArray(security) || (security.length && !security.some(requirement => Object.keys(object(requirement)).length === 0)))) throw new Error('当前不支持需要认证的接口');
                const servers = raw.servers ?? item.servers ?? document.servers ?? [{ url: '/' }];
                if (!Array.isArray(servers) || servers.length > 8 || !servers.length) throw new Error('服务地址数量无效');
                for (const server of servers) {
                    try { if (typeof server.url !== 'string' || /[{}]/.test(server.url)) throw new Error(); entry.servers.push(publicApiUrl(new URL(server.url, url).href).href); }
                    catch { entry.serverWarning = '已排除不支持的服务器地址'; }
                }
                entry.servers = [...new Set(entry.servers)];
                if (!entry.servers.length) throw new Error('没有可用的公开 HTTPS 服务地址');
                const parameters = new Map<string, any>();
                for (const group of [item.parameters || [], raw.parameters || []]) {
                    if (!Array.isArray(group) || group.length > 40) throw new Error('参数目录无效或过大');
                    const seen = new Set<string>();
                    for (const value of group) {
                        const parameter = resolve(value), id = `${parameter.in}:${parameter.name}`;
                        if (seen.has(id)) throw new Error('同层参数重复'); seen.add(id); parameters.set(id, parameter);
                    }
                }
                entry.parameters = [...parameters.values()].map(parameter => {
                    if ((parameter.required !== undefined && typeof parameter.required !== 'boolean') || (parameter.explode !== undefined && typeof parameter.explode !== 'boolean')) throw new Error('参数的 required/explode 必须为布尔值');
                    if (parameter.content || parameter.allowReserved || !['path', 'query'].includes(parameter.in) || (parameter.style && parameter.style !== (parameter.in === 'path' ? 'simple' : 'form'))) throw new Error('仅支持 path/simple 和 query/form 参数');
                    if (/^(apikey|accesstoken|authorization|password|secret)$/.test(String(parameter.name).replace(/[-_]/g, '').toLowerCase())) {
                        if (parameter.required) throw new Error('不支持必填凭据参数');
                        (entry.warnings ||= []).push(`匿名模式不提供可选凭据参数：${String(parameter.name).slice(0, 128)}`); return undefined;
                    }
                    return parameterSchema.parse({ name: parameter.name, in: parameter.in, required: parameter.required === true, explode: parameter.explode !== false, description: String(parameter.description || '').slice(0, 1000), schema: normalizeSchema(parameter.schema) });
                }).filter(Boolean);
                const operation = operationSchema.parse({ key, alias, method: 'GET', path, summary, parameters: entry.parameters });
                new AjvJsonSchemaValidator().getValidator(argumentsSchema(operation));
                const responses = object(raw.responses);
                if (!Object.entries(responses).some(([status, value]) => (/^2\d\d$|^2XX$|^default$/.test(status)) && Object.keys(resolve(value).content || {}).some(type => /^application\/(?:[\w.+-]*\+)?json$/.test(type)))) throw new Error('接口未声明成功的 JSON 响应');
            } catch (error) { entry.issue = error instanceof Error && !(error.name === 'ZodError') ? error.message.slice(0, 200) : '参数或路径契约不在支持范围内'; entry.parameters = []; }
            operations.push(entry);
        }
    }
    if (Buffer.byteLength(JSON.stringify(operations)) > 512 * 1024) throw new Error('OpenAPI 目录超过 512 KiB');
    return { serviceId, source, checkedAt: new Date().toISOString(), operations };
}
export async function inspectOpenApi(input: unknown, signal: AbortSignal, network?: WebTransport) {
    const selected = inspectInput.parse(input); signal.throwIfAborted();
    const page = await fetchApiData(selected.url, signal, network);
    const catalog = readCatalog(new TextDecoder('utf-8', { fatal: true }).decode(page.body), selected.url, selected.serviceId);
    catalog.source.sha256 = createHash('sha256').update(page.body).digest('hex');
    return catalog;
}
