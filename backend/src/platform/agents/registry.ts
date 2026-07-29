import type { BotAgentBinding } from '@/platform/bots/contracts';
import type { AgentInstallation, AgentManifest, ResolvedAgent } from './contracts';

const definitionKey = (id: string, version: string) => `${id}@${version}`;
const clone = <T>(value: T): T => structuredClone(value);

export class AgentRegistry {
    private readonly definitions = new Map<string, AgentManifest>();
    private readonly installations = new Map<string, AgentInstallation>();
    private readonly bindings = new Map<string, BotAgentBinding>();

    register(manifest: AgentManifest): void {
        if (!manifest.id || !manifest.version || manifest.capabilities.length === 0) throw new Error('Agent manifest identity and capabilities are required');
        if (manifest.delivery.directDelivery !== false) throw new Error('Direct delivery is not allowed');
        const key = definitionKey(manifest.id, manifest.version);
        if (this.definitions.has(key)) throw new Error(`Agent already registered: ${key}`);
        this.definitions.set(key, clone(manifest));
    }

    registerOrVerify(manifest: AgentManifest): void {
        const key = definitionKey(manifest.id, manifest.version);
        const existing = this.definitions.get(key);
        if (!existing) {
            this.register(manifest);
            return;
        }
        if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
            throw new Error(`Conflicting Agent definition: ${key}`);
        }
    }

    install(installation: AgentInstallation): void {
        if (!this.definitions.has(definitionKey(installation.agentId, installation.version))) throw new Error('Agent definition is not registered');
        if (this.installations.has(installation.id)) throw new Error(`Agent installation already exists: ${installation.id}`);
        this.installations.set(installation.id, clone(installation));
    }

    upsertInstallation(installation: AgentInstallation): void {
        if (!this.definitions.has(definitionKey(installation.agentId, installation.version))) throw new Error('Agent definition is not registered');
        this.installations.set(installation.id, clone(installation));
    }

    bind(binding: BotAgentBinding): void {
        if (!this.installations.has(binding.agentInstallationId)) throw new Error('Agent installation does not exist');
        if (this.bindings.has(binding.id)) throw new Error(`Agent binding already exists: ${binding.id}`);
        this.bindings.set(binding.id, clone(binding));
    }

    upsertBinding(binding: BotAgentBinding): void {
        if (!this.installations.has(binding.agentInstallationId)) throw new Error('Agent installation does not exist');
        this.bindings.set(binding.id, clone(binding));
    }

    getInstallation(id: string): AgentInstallation | null {
        const installation = this.installations.get(id);
        return installation ? clone(installation) : null;
    }

    getManifestForInstallation(id: string): AgentManifest | null {
        const installation = this.installations.get(id);
        if (!installation) return null;
        const manifest = this.definitions.get(definitionKey(installation.agentId, installation.version));
        return manifest ? clone(manifest) : null;
    }

    listBindings(botInstanceId?: string): BotAgentBinding[] {
        return Array.from(this.bindings.values())
            .filter(binding => !botInstanceId || binding.botInstanceId === botInstanceId)
            .map(clone);
    }

    resolve(workspaceId: string, botInstanceId: string, capability: string): ResolvedAgent {
        const candidates = Array.from(this.bindings.values())
            .filter(binding => binding.enabled && binding.botInstanceId === botInstanceId && binding.capabilities.includes(capability))
            .sort((left, right) => left.priority - right.priority);
        for (const binding of candidates) {
            const installation = this.installations.get(binding.agentInstallationId)!;
            if (installation.workspaceId !== workspaceId || installation.status !== 'active') continue;
            const manifest = this.definitions.get(definitionKey(installation.agentId, installation.version))!;
            if (manifest.capabilities.includes(capability)) return { manifest: clone(manifest), installation: clone(installation), binding: clone(binding) };
        }
        throw new Error(`No active Agent binding for capability: ${capability}`);
    }

    resolveInstallation(workspaceId: string, botInstanceId: string, installationId: string, capability: string): ResolvedAgent {
        const binding = Array.from(this.bindings.values()).find(candidate =>
            candidate.enabled &&
            candidate.botInstanceId === botInstanceId &&
            candidate.agentInstallationId === installationId &&
            candidate.capabilities.includes(capability)
        );
        if (!binding) throw new Error(`No active Agent binding for installation: ${installationId}`);
        const installation = this.installations.get(installationId);
        if (!installation || installation.workspaceId !== workspaceId || installation.status !== 'active') throw new Error(`Agent installation is not active: ${installationId}`);
        const manifest = this.definitions.get(definitionKey(installation.agentId, installation.version));
        if (!manifest || !manifest.capabilities.includes(capability)) throw new Error(`Agent capability is unavailable: ${capability}`);
        return { manifest: clone(manifest), installation: clone(installation), binding: clone(binding) };
    }
}
