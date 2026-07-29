import type { AgentRequest, AgentResult, AgentRuntimeAdapter, ResolvedAgent } from './contracts';
import type { SecretResolver } from '@/platform/secrets/resolver';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpAgentAdapterOptions {
    fetch?: FetchLike;
    allowInsecureHttpHosts?: readonly string[];
}

export class HttpAgentAdapter implements AgentRuntimeAdapter {
    readonly type = 'http' as const;
    private readonly fetch: FetchLike;
    private readonly allowInsecureHttpHosts: ReadonlySet<string>;

    constructor(private readonly secrets: SecretResolver, options: HttpAgentAdapterOptions = {}) {
        this.fetch = options.fetch || fetch;
        this.allowInsecureHttpHosts = new Set(options.allowInsecureHttpHosts || []);
    }

    async execute(request: AgentRequest, resolved: ResolvedAgent, signal: AbortSignal): Promise<AgentResult> {
        const endpoint = this.validateEndpoint(resolved);
        const headers = await this.buildHeaders(resolved);
        const response = await this.fetch(endpoint, {
            method: 'POST', redirect: 'error', signal, headers,
            body: JSON.stringify({
                protocolVersion: '1.0',
                request: { ...request, trustedContext: undefined },
                installation: { id: resolved.installation.id, config: resolved.installation.config },
            }),
        });
        if (!response.ok) {
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            throw Object.assign(new Error(`External Agent returned HTTP ${response.status}`), { code: `HTTP_${response.status}`, retryable });
        }
        const body = await this.readBoundedBody(response, resolved.manifest.limits.maxOutputBytes, signal);
        try {
            const parsed = JSON.parse(body);
            if (!parsed || !['succeeded', 'failed', 'needs_human'].includes(parsed.status) || !Array.isArray(parsed.artifacts)) {
                throw new Error('Response does not match AgentResult envelope');
            }
            return parsed as AgentResult;
        } catch (cause: any) {
            throw Object.assign(new Error(`Invalid external Agent response: ${cause?.message || String(cause)}`), { code: 'INVALID_AGENT_RESPONSE', retryable: false });
        }
    }

    private validateEndpoint(resolved: ResolvedAgent): URL {
        if (!resolved.manifest.runtime.entrypoint) throw Object.assign(new Error('External Agent entrypoint is required'), { code: 'ENTRYPOINT_REQUIRED', retryable: false });
        const endpoint = new URL(resolved.manifest.runtime.entrypoint);
        if (endpoint.username || endpoint.password) throw Object.assign(new Error('Credentials in Agent entrypoint are not allowed'), { code: 'ENTRYPOINT_CREDENTIALS_NOT_ALLOWED', retryable: false });
        if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && this.allowInsecureHttpHosts.has(endpoint.hostname))) {
            throw Object.assign(new Error('External Agent entrypoint must use HTTPS'), { code: 'INSECURE_AGENT_ENDPOINT', retryable: false });
        }
        if (!resolved.manifest.requirements.networkHosts.some(pattern => this.hostMatches(endpoint.hostname, pattern))) {
            throw Object.assign(new Error(`External Agent host is not allowlisted: ${endpoint.hostname}`), { code: 'NETWORK_HOST_NOT_ALLOWED', retryable: false });
        }
        return endpoint;
    }

    private async buildHeaders(resolved: ResolvedAgent): Promise<Record<string, string>> {
        const headers: Record<string, string> = { 'content-type': 'application/json', 'accept': 'application/json' };
        const configuredHeaders = resolved.installation.config.secretHeaders;
        const secretHeaders = configuredHeaders && typeof configuredHeaders === 'object' && !Array.isArray(configuredHeaders)
            ? configuredHeaders as Record<string, unknown> : {};
        for (const secretName of resolved.manifest.requirements.secrets) {
            const reference = resolved.installation.secretRefs[secretName];
            if (!reference) throw Object.assign(new Error(`Missing secret reference: ${secretName}`), { code: 'SECRET_REF_MISSING', retryable: false });
            const headerName = secretHeaders[secretName];
            if (typeof headerName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(headerName) || ['host', 'content-length'].includes(headerName.toLowerCase())) {
                throw Object.assign(new Error(`Invalid secret header mapping: ${secretName}`), { code: 'SECRET_HEADER_INVALID', retryable: false });
            }
            headers[headerName] = await this.secrets.resolve(reference);
        }
        return headers;
    }

    private async readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > maxBytes) throw Object.assign(new Error('External Agent response exceeds maxOutputBytes'), { code: 'OUTPUT_TOO_LARGE', retryable: false });
        if (!response.body) return '';
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
        while (true) {
            if (signal.aborted) throw Object.assign(new Error('External Agent request cancelled'), { code: 'CANCELLED', retryable: true });
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) { await reader.cancel(); throw Object.assign(new Error('External Agent response exceeds maxOutputBytes'), { code: 'OUTPUT_TOO_LARGE', retryable: false }); }
            chunks.push(value);
        }
        return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
    }

    private hostMatches(hostname: string, pattern: string): boolean {
        const normalized = pattern.toLowerCase(); const host = hostname.toLowerCase();
        return normalized.startsWith('*.') ? host.endsWith(normalized.slice(1)) && host !== normalized.slice(2) : host === normalized;
    }
}
