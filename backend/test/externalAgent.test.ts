import { describe, expect, test } from 'bun:test';
import { AI_HOT_CAPABILITY, createAiHotAgentManifest, installAiHotAgent } from '@/agents/external/aiHotAgent';
import { HttpAgentAdapter } from '@/platform/agents/httpAdapter';
import { AgentRegistry } from '@/platform/agents/registry';
import type { AgentRequest, ResolvedAgent } from '@/platform/agents/contracts';
import { MapSecretResolver } from '@/platform/secrets/resolver';
import { PersistentAgentCatalog } from '@/platform/agents/catalog';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createAiHotAgentPackage } from '@/agents/external/aiHotAgent';

function fixture(fetchImpl: any, requirements: { secrets: string[]; networkHosts: string[] } = { secrets: ['apiToken'], networkHosts: ['agent.example.com'] }) {
    const manifest = { ...createAiHotAgentManifest('https://agent.example.com/v1/run', true), requirements: { tools: [] as string[], ...requirements } };
    const resolved: ResolvedAgent = {
        manifest,
        installation: { id: 'install-ai-hot', workspaceId: 'workspace-default', agentId: manifest.id, version: manifest.version, status: 'active', config: { secretHeaders: { apiToken: 'Authorization' } }, secretRefs: { apiToken: 'secret://ai-hot' } },
        binding: { id: 'bind-ai-hot', botInstanceId: 'bot-default', agentInstallationId: 'install-ai-hot', enabled: true, priority: 1, capabilities: [AI_HOT_CAPABILITY], routingConfig: {}, configOverride: {} },
    };
    const request: AgentRequest = {
        runId: 'run-1', capability: AI_HOT_CAPABILITY, input: { date: '2026-07-14', limit: 5 }, deadlineAt: '2026-07-14T01:00:00Z', traceContext: { correlationId: 'run-1' },
        scope: { workspaceId: 'workspace-default', botInstanceId: 'bot-default', agentInstallationId: 'install-ai-hot', triggerType: 'schedule', triggerId: 'daily-ai-hot', locale: 'zh-CN', timezone: 'Asia/Shanghai', correlationId: 'run-1' },
    };
    return { adapter: new HttpAgentAdapter(new MapSecretResolver({ 'secret://ai-hot': 'Bearer token-value' }), { fetch: fetchImpl }), request, resolved };
}

describe('HTTP external Agent adapter', () => {
    test('sends the protocol envelope and resolved header without exposing secret references', async () => {
        let captured: RequestInit | undefined;
        const { adapter, request, resolved } = fixture(async (_url: URL, init: RequestInit) => {
            captured = init;
            return new Response(JSON.stringify({
                status: 'succeeded', data: { articles: [{ title: 'Agent patterns', url: 'https://example.com/article' }] },
                artifacts: [{ type: 'article_list', mediaType: 'application/json', schemaVersion: '1.0', content: [] }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const result = await adapter.execute(request, resolved, new AbortController().signal);
        expect(result.status).toBe('succeeded');
        expect((captured?.headers as Record<string, string>).Authorization).toBe('Bearer token-value');
        expect(String(captured?.body)).toContain('protocolVersion');
        expect(String(captured?.body)).not.toContain('secret://ai-hot');
        expect(String(captured?.body)).not.toContain('token-value');
    });

    test('blocks endpoints outside the manifest allowlist before making a request', async () => {
        let called = false;
        const { adapter, request, resolved } = fixture(async () => { called = true; return new Response('{}'); }, { secrets: ['apiToken'], networkHosts: ['different.example.com'] });
        await expect(adapter.execute(request, resolved, new AbortController().signal)).rejects.toMatchObject({ code: 'NETWORK_HOST_NOT_ALLOWED', retryable: false });
        expect(called).toBe(false);
    });

    test('classifies upstream overload as retryable', async () => {
        const { adapter, request, resolved } = fixture(async () => new Response('busy', { status: 503 }));
        await expect(adapter.execute(request, resolved, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_503', retryable: true });
    });

    test('rejects oversized responses before parsing', async () => {
        const { adapter, request, resolved } = fixture(async () => new Response('{}', { status: 200, headers: { 'content-length': String(1024 * 1024) } }));
        await expect(adapter.execute(request, resolved, new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE', retryable: false });
    });
});

describe('AIHot external Agent package', () => {
    test('installs and binds as a replaceable capability', () => {
        const registry = new AgentRegistry();
        installAiHotAgent(registry, { endpoint: 'https://agent.example.com/v1/run', workspaceId: 'workspace-default', botInstanceId: 'bot-default', apiTokenRef: 'env://AIHOT_AGENT_TOKEN' });
        const resolved = registry.resolve('workspace-default', 'bot-default', AI_HOT_CAPABILITY);
        expect(resolved.manifest.runtime).toEqual({ type: 'http', entrypoint: 'https://agent.example.com/v1/run' });
        expect(resolved.installation.secretRefs).toEqual({ apiToken: 'env://AIHOT_AGENT_TOKEN' });
        expect(resolved.manifest.delivery.directDelivery).toBe(false);
    });

    test('isolates installed definitions from later caller mutation', () => {
        const registry = new AgentRegistry(); const manifest = createAiHotAgentManifest('https://agent.example.com/v1/run');
        registry.register(manifest);
        registry.install({ id: 'install', workspaceId: 'workspace-default', agentId: manifest.id, version: manifest.version, status: 'active', config: {}, secretRefs: {} });
        registry.bind({ id: 'binding', botInstanceId: 'bot-default', agentInstallationId: 'install', enabled: true, priority: 1, capabilities: [AI_HOT_CAPABILITY], routingConfig: {}, configOverride: {} });
        (manifest.capabilities as string[]).splice(0, 1);
        expect(registry.resolve('workspace-default', 'bot-default', AI_HOT_CAPABILITY).manifest.capabilities).toEqual([AI_HOT_CAPABILITY]);
    });

    test('persists the package and reloads it after a host restart', async () => {
        const database = new InMemoryPersistentKeyValueStore(); const catalog = new PersistentAgentCatalog(database);
        await catalog.upsert(createAiHotAgentPackage({ endpoint: 'https://agent.example.com/v1/run', workspaceId: 'workspace-default', botInstanceId: 'bot-default' }));
        const registryAfterRestart = new AgentRegistry(); await new PersistentAgentCatalog(database).loadInto(registryAfterRestart);
        expect(registryAfterRestart.resolve('workspace-default', 'bot-default', AI_HOT_CAPABILITY).installation.status).toBe('active');
        expect(await catalog.list()).toHaveLength(1);
    });

    test('rejects raw or unsupported secret references at install time', () => {
        expect(() => createAiHotAgentPackage({ endpoint: 'https://agent.example.com/v1/run', workspaceId: 'workspace-default', botInstanceId: 'bot-default', apiTokenRef: 'plain-secret' })).toThrow('Unsupported secret reference');
    });
});
