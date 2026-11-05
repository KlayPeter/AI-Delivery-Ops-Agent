import { lookup } from 'node:dns/promises';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Transform, pipeline } from 'node:stream';
import { isIP } from 'node:net';
import { isPublicAddress, publicPageUrl } from '@/knowledge/web/network';

export function mcpHttpEndpoint(value: string): URL {
    const url = publicPageUrl(value);
    if (url.protocol !== 'https:' || url.search || new URL(value).hash) throw new Error('MCP endpoint requires public HTTPS without query credentials or a fragment');
    return url;
}

export interface McpHttpNetwork {
    resolve(host: string): Promise<Array<{ address: string; family: number }>>;
    request(options: https.RequestOptions, response: (message: IncomingMessage) => void): ClientRequest;
}
const network: McpHttpNetwork = { resolve: host => lookup(host, { all: true, verbatim: true }), request: https.request };
const maxFrameBytes = 2 * 1024 * 1024;

export function createMcpHttpFetch(endpoint: string, timeoutMs: number, connection: McpHttpNetwork = network) {
    const target = mcpHttpEndpoint(endpoint);
    return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(input), method = (init.method || 'GET').toUpperCase();
        if (url.href !== target.href || !['GET', 'POST', 'DELETE'].includes(method)) throw new Error('MCP request must use the fixed endpoint and protocol methods');
        if (init.body != null && (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 64 * 1024)) throw new Error('MCP request exceeds the protocol body budget');
        const controller = new AbortController();
        const active = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
        const timer = setTimeout(() => controller.abort(new Error('MCP HTTP request timed out')), timeoutMs);
        const cleanup = () => { clearTimeout(timer); active.removeEventListener('abort', abortDns); };
        let abortDns = (): void => {};
        try {
            active.throwIfAborted();
            const hostname = url.hostname.replace(/^\[|\]$/g, '');
            const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([connection.resolve(hostname), new Promise<never>((_, reject) => {
                abortDns = () => reject(active.reason);
                active.addEventListener('abort', abortDns, { once: true });
                if (active.aborted) abortDns();
            })]);
            active.throwIfAborted();
            active.removeEventListener('abort', abortDns);
            if (!addresses.length || addresses.length > 32 || addresses.some(item => !isPublicAddress(item.address))) throw new Error('MCP DNS target must be exclusively public');
            const headers = new Headers(init.headers);
            headers.set('host', url.host); headers.set('accept-encoding', 'identity');
            return await new Promise<Response>((resolve, reject) => {
                const request = connection.request({ protocol: 'https:', hostname: addresses[0]!.address, servername: isIP(hostname) ? undefined : hostname,
                    port: 443, path: url.pathname, method, headers: Object.fromEntries(headers), signal: active,
                    agent: false, maxHeaderSize: 16 * 1024,
                }, response => {
                    try {
                        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) throw new Error('MCP redirects are not allowed');
                        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Compressed MCP responses are unsupported');
                        if (Number(response.headers['content-length'] || 0) > maxFrameBytes) throw new Error('MCP HTTP response exceeds 2 MiB');
                        const resultHeaders = new Headers();
                        for (const [name, value] of Object.entries(response.headers)) {
                            if (value !== undefined) for (const entry of Array.isArray(value) ? value : [value]) resultHeaders.append(name, entry);
                        }
                        let bytes = 0;
                        const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                            bytes += chunk.length;
                            callback(bytes > maxFrameBytes ? new Error('MCP HTTP response exceeds 2 MiB') : null, chunk);
                        } });
                        pipeline(response, bounded, cleanup);
                        const status = response.statusCode || 500;
                        if (status === 204 || status === 205) { bounded.resume(); resolve(new Response(null, { status, headers: resultHeaders })); }
                        else {
                            const chunks = bounded[Symbol.asyncIterator]();
                            const body = new ReadableStream<Uint8Array>({
                                async pull(controller) {
                                    const next = await chunks.next();
                                    if (next.done) controller.close(); else controller.enqueue(next.value);
                                },
                                async cancel() { bounded.destroy(); await chunks.return?.(); },
                            });
                            resolve(new Response(body, { status, headers: resultHeaders }));
                        }
                    } catch (error) { response.destroy(); cleanup(); reject(error); }
                });
                request.on('error', error => { cleanup(); reject(error); });
                request.end(init.body || undefined);
            });
        } catch (error) { cleanup(); throw error; }
    };
}
