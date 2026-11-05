import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicPageUrl(value: string): URL {
    if (value.length > 1024) throw new Error('Knowledge URL exceeds 1024 characters');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Use a public HTTP(S) URL without credentials or a nonstandard port');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host.endsWith('.') || /(^|\.)(localhost|local|internal|invalid|test|onion|home|arpa)$/.test(host) || (isIP(host) && !isPublicAddress(host))) throw new Error('Knowledge URL must target a public network address');
    url.hash = '';
    if (url.href.length > 1024) throw new Error('Knowledge URL exceeds 1024 characters');
    return url;
}

export interface PublicPage { url: string; body: Buffer; contentType: string }
interface PageResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
export interface WebTransport {
    resolve(host: string): Promise<Array<{ address: string; family: number }>>;
    request(url: URL, address: string, maxBytes: number, signal: AbortSignal): Promise<PageResponse>;
}

export const publicWebTransport: WebTransport = {
    resolve: host => lookup(host, { all: true, verbatim: true }),
    request(url, address, maxBytes, signal) {
        return new Promise((resolve, reject) => {
            const request = (url.protocol === 'https:' ? https : http).request({
                protocol: url.protocol, hostname: address, port: url.port || (url.protocol === 'https:' ? 443 : 80),
                // Pin the vetted IP; preserve the original hostname for TLS identity and HTTP routing.
                servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
                method: 'GET', path: `${url.pathname}${url.search}`, agent: false, signal, maxHeaderSize: 16 * 1024,
                headers: { host: url.host, accept: 'text/html, text/markdown, text/plain', 'accept-encoding': 'identity', 'user-agent': 'DeliveryOpsKnowledge/1.0' },
            }, response => {
                void (async () => {
                    const status = response.statusCode || 0;
                    if ([301, 302, 303, 307, 308].includes(status)) { response.destroy(); resolve({ status, headers: response.headers, body: Buffer.alloc(0) }); return; }
                    if (status < 200 || status >= 300) throw new Error(`Knowledge page returned HTTP ${status}`);
                    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Compressed knowledge responses are unsupported');
                    if (Number(response.headers['content-length'] || 0) > maxBytes) throw new Error('Knowledge page exceeds byte budget');
                    const parts: Buffer[] = [];
                    let bytes = 0;
                    for await (const part of response) {
                        signal.throwIfAborted();
                        const buffer = Buffer.from(part);
                        if ((bytes += buffer.length) > maxBytes) throw new Error('Knowledge page exceeds byte budget');
                        parts.push(buffer);
                    }
                    resolve({ status, headers: response.headers, body: Buffer.concat(parts) });
                })().catch(error => { response.destroy(); reject(error); });
            });
            request.on('error', reject);
            request.end();
        });
    },
};

async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    try {
        return await Promise.race([pending, new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        })]);
    } finally { signal.removeEventListener('abort', abort); }
}

export async function fetchPublicPage(value: string, maxBytes: number, timeoutMs: number, signal?: AbortSignal, transport: WebTransport = publicWebTransport): Promise<PublicPage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Knowledge page timed out')), timeoutMs);
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
        let url = publicPageUrl(value);
        for (let redirects = 0; redirects <= 3; redirects++) {
            active.throwIfAborted();
            const host = url.hostname.replace(/^\[|\]$/g, '');
            const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await untilAborted(transport.resolve(host), active);
            if (!addresses.length || addresses.length > 32 || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Knowledge DNS target is not exclusively public');
            active.throwIfAborted();
            const response = await untilAborted(transport.request(url, addresses[0]!.address, maxBytes, active), active);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (redirects === 3 || !response.headers.location) throw new Error('Knowledge page redirect limit or missing Location');
                const next = publicPageUrl(new URL(response.headers.location, url).href);
                if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Knowledge page HTTPS downgrade is not allowed');
                url = next;
                continue;
            }
            if (response.status < 200 || response.status >= 300) throw new Error(`Knowledge page returned HTTP ${response.status}`);
            if (response.body.length > maxBytes) throw new Error('Knowledge page exceeds byte budget');
            return { url: url.href, body: response.body, contentType: response.headers['content-type'] || '' };
        }
        throw new Error('Knowledge page redirect limit');
    } finally { clearTimeout(timer); }
}
