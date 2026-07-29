import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { AgentRegistry } from './registry';
import type { ExternalAgentPackage } from './externalInstaller';

const PREFIX = 'agent:catalog:';

export interface CatalogAgentPackage extends ExternalAgentPackage {
    installedAt: string;
    updatedAt: string;
}

export class PersistentAgentCatalog {
    constructor(private readonly store: PersistentKeyValueStore) {}

    async upsert(agentPackage: ExternalAgentPackage, now: Date = new Date()): Promise<CatalogAgentPackage> {
        const key = this.key(agentPackage.installation.id);
        const existing = await this.store.getIdempotencyValue<CatalogAgentPackage>(key);
        const record: CatalogAgentPackage = {
            ...structuredClone(agentPackage), installedAt: existing?.installedAt || now.toISOString(), updatedAt: now.toISOString(),
        };
        await this.store.setIdempotencyKey(key, record);
        return structuredClone(record);
    }

    async list(): Promise<CatalogAgentPackage[]> {
        return (await this.store.listIdempotencyEntries<CatalogAgentPackage>(PREFIX)).map(entry => structuredClone(entry.value));
    }

    async loadInto(registry: AgentRegistry): Promise<void> {
        const definitions = new Map<string, string>();
        for (const agentPackage of await this.list()) {
            const definition = `${agentPackage.manifest.id}@${agentPackage.manifest.version}`;
            const serialized = JSON.stringify(agentPackage.manifest);
            const existing = definitions.get(definition);
            if (existing && existing !== serialized) throw new Error(`Conflicting Agent definitions in catalog: ${definition}`);
            if (!existing) { registry.register(agentPackage.manifest); definitions.set(definition, serialized); }
            registry.install(agentPackage.installation);
            registry.bind(agentPackage.binding);
        }
    }

    private key(installationId: string): string { return `${PREFIX}${encodeURIComponent(installationId)}`; }
}
