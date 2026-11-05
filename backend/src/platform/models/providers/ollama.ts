// The explicit package entry avoids Bun's bare undici shim, which delegates to fetch.
import { Client } from 'undici/index.js';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelProviderDefinition } from '../registry';

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const MAX_BYTES = 4 * 1024 * 1024;
export function localModelEndpoint(base: string): URL {
    const url = new URL(base || OLLAMA_BASE_URL);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || /[?#]/.test(base)) throw new Error('Ollama 仅支持无凭据、查询和片段的本机回环地址');
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const path = url.pathname.replace(/\/+$/, '');
    if (path && path !== '/v1') throw new Error('请使用 Ollama 的 /v1 兼容地址');
    url.pathname = '/v1'; return url;
}
function localFetch(base: URL) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const source = new Request(input, init), url = new URL(source.url);
        if (url.origin !== base.origin || url.pathname !== '/v1/chat/completions' || url.search || url.hash || source.method !== 'POST') throw new Error('Local model request escaped its fixed endpoint');
        source.signal.throwIfAborted();
        const body = Buffer.from(await source.arrayBuffer());
        if (body.byteLength > MAX_BYTES) throw new Error('Local model request exceeds 4 MiB');
        source.signal.throwIfAborted();
        const client = new Client(base.origin, { maxResponseSize: MAX_BYTES });
        try {
            const response = await client.request({ path: url.pathname, method: 'POST', body, signal: source.signal,
                headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' } });
            if (response.statusCode >= 300 && response.statusCode < 400) throw new Error('Local model redirects are not allowed');
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Compressed local model responses are not supported');
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const chunk of response.body) {
                source.signal.throwIfAborted(); bytes += chunk.length;
                if (bytes > MAX_BYTES) throw new Error('Local model response exceeds 4 MiB');
                chunks.push(Buffer.from(chunk));
            }
            source.signal.throwIfAborted();
            return new Response(Buffer.concat(chunks), { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] || '') } });
        } finally { await client.destroy(); }
    };
}
export const ollamaProvider: ModelProviderDefinition = {
    id: 'ollama', name: 'Ollama 本机模型',
    isConfigured(config) { if (!config.model?.trim()) return false; localModelEndpoint(config.api_base); return true; },
    create(config) {
        const base = localModelEndpoint(config.api_base);
        return createOpenAI({ apiKey: 'ollama', baseURL: base.href.replace(/\/$/, ''), fetch: localFetch(base) as typeof fetch }).chat(config.model);
    },
};
