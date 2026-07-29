import type { AgentManifest } from '@/platform/agents/contracts';
import type { AgentRegistry } from '@/platform/agents/registry';
import { createExternalAgentPackage, installExternalAgent, type ExternalAgentPackage } from '@/platform/agents/externalInstaller';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';

export const AI_HOT_AGENT_ID = 'external.ai-hot';
export const AI_HOT_CAPABILITY = 'knowledge.ai.hot.fetch';

interface AiHotInstallOptions {
    endpoint: string;
    workspaceId: string;
    botInstanceId: string;
    apiTokenRef?: string;
    priority?: number;
    installationId?: string;
    bindingId?: string;
}

function resolveIds(options: AiHotInstallOptions): { installationId: string; bindingId: string } {
    const isDefaultTarget = options.workspaceId === DEFAULT_WORKSPACE_ID && options.botInstanceId === DEFAULT_BOT_INSTANCE_ID;
    const installationId = options.installationId || (isDefaultTarget
        ? `install-${AI_HOT_AGENT_ID}`
        : `install-${AI_HOT_AGENT_ID}-${options.workspaceId}-${options.botInstanceId}`);
    return {
        installationId,
        bindingId: options.bindingId || `bind-${installationId}-${options.botInstanceId}`,
    };
}

export function createAiHotAgentManifest(endpoint: string, requiresApiToken: boolean = false): AgentManifest {
    const url = new URL(endpoint);
    return {
        schemaVersion: '1.0', id: AI_HOT_AGENT_ID, name: 'AI Hot Knowledge Agent', version: '1.0.0',
        description: 'Fetches and summarizes daily popular AI knowledge articles.',
        runtime: { type: 'http', entrypoint: url.toString() }, capabilities: [AI_HOT_CAPABILITY], triggers: ['schedule', 'manual', 'message'],
        inputSchema: { type: 'object', required: ['date'], properties: { date: { type: 'string' }, limit: { type: 'integer' }, language: { type: 'string' } } },
        outputSchema: {
            type: 'object', required: ['articles'], properties: {
                articles: {
                    type: 'array', items: {
                        type: 'object', required: ['title', 'url'], properties: {
                            title: { type: 'string' }, url: { type: 'string' }, summary: { type: 'string' },
                        },
                    },
                },
            },
        },
        requirements: { tools: [], secrets: requiresApiToken ? ['apiToken'] : [], networkHosts: [url.hostname] },
        limits: { timeoutSeconds: 60, maxSteps: 10, maxToolCalls: 20, maxAgentCalls: 1, maxOutputBytes: 512 * 1024 },
        delivery: { allowedArtifactTypes: ['article_list', 'markdown'], directDelivery: false },
    };
}

export function installAiHotAgent(registry: AgentRegistry, options: AiHotInstallOptions): void {
    const manifest = createAiHotAgentManifest(options.endpoint, !!options.apiTokenRef);
    const ids = resolveIds(options);
    installExternalAgent(registry, manifest, {
        workspaceId: options.workspaceId, botInstanceId: options.botInstanceId,
        ...ids,
        secretRefs: options.apiTokenRef ? { apiToken: options.apiTokenRef } : {},
        config: options.apiTokenRef ? { secretHeaders: { apiToken: 'Authorization' } } : {}, priority: options.priority,
    });
}

export function createAiHotAgentPackage(options: AiHotInstallOptions): ExternalAgentPackage {
    const manifest = createAiHotAgentManifest(options.endpoint, !!options.apiTokenRef);
    const ids = resolveIds(options);
    return createExternalAgentPackage(manifest, {
        workspaceId: options.workspaceId, botInstanceId: options.botInstanceId,
        ...ids,
        secretRefs: options.apiTokenRef ? { apiToken: options.apiTokenRef } : {},
        config: options.apiTokenRef ? { secretHeaders: { apiToken: 'Authorization' } } : {}, priority: options.priority,
    });
}
