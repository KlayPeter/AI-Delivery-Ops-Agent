import type { AgentInstallation, AgentManifest } from './contracts';
import type { BotAgentBinding } from '@/platform/bots/contracts';
import type { AgentRegistry } from './registry';

export interface ExternalAgentInstallOptions {
    workspaceId: string;
    botInstanceId: string;
    installationId: string;
    bindingId: string;
    config?: Readonly<Record<string, unknown>>;
    secretRefs?: Readonly<Record<string, string>>;
    priority?: number;
}

export interface ExternalAgentPackage {
    manifest: AgentManifest;
    installation: AgentInstallation;
    binding: BotAgentBinding;
}

export function createExternalAgentPackage(manifest: AgentManifest, options: ExternalAgentInstallOptions): ExternalAgentPackage {
    if (manifest.runtime.type === 'native') throw new Error('External installer cannot install a native Agent');
    if (!manifest.id || !manifest.version || !manifest.capabilities.length) throw new Error('External Agent identity and capabilities are required');
    if (manifest.id.startsWith('native.')) throw new Error('External Agent cannot use the reserved native namespace');
    if (manifest.delivery.directDelivery !== false) throw new Error('Direct delivery is not allowed');
    if (!manifest.runtime.entrypoint) throw new Error('External Agent entrypoint is required');
    if (['http', 'a2a'].includes(manifest.runtime.type)) {
        const endpoint = new URL(manifest.runtime.entrypoint);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('External Agent entrypoint must be credential-free HTTPS');
        const hostname = endpoint.hostname;
        if (!manifest.requirements.networkHosts.includes(hostname)) throw new Error('External Agent entrypoint host must be explicitly allowlisted');
    }
    const secretRefs = options.secretRefs || {};
    for (const required of manifest.requirements.secrets) {
        if (!secretRefs[required]) throw new Error(`Missing required secret reference: ${required}`);
        if (!/^env:\/\/[A-Z][A-Z0-9_]*$/.test(secretRefs[required])) throw new Error(`Unsupported secret reference: ${required}`);
    }
    return structuredClone({ manifest, installation: {
        id: options.installationId, workspaceId: options.workspaceId, agentId: manifest.id, version: manifest.version,
        status: 'active', config: options.config || {}, secretRefs,
    }, binding: {
        id: options.bindingId, botInstanceId: options.botInstanceId, agentInstallationId: options.installationId,
        enabled: true, priority: options.priority || 100, capabilities: manifest.capabilities, routingConfig: {}, configOverride: {},
    } });
}

export function installExternalAgent(registry: AgentRegistry, manifest: AgentManifest, options: ExternalAgentInstallOptions): void {
    const agentPackage = createExternalAgentPackage(manifest, options);
    registry.register(agentPackage.manifest);
    registry.install(agentPackage.installation);
    registry.bind(agentPackage.binding);
}
