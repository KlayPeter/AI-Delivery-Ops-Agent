import type { AgentRegistry } from '@/platform/agents/registry';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { BotAgentBinding, BotInstance } from './contracts';
import type { BotRegistry } from './registry';

const BOT_PREFIX = 'bot:catalog:';
const BINDING_PREFIX = 'agent:binding:catalog:';

export class PersistentBotControlCatalog {
    constructor(private readonly store: PersistentKeyValueStore) {}

    async upsertBot(bot: BotInstance): Promise<BotInstance> {
        const saved = structuredClone(bot);
        await this.store.setIdempotencyKey(`${BOT_PREFIX}${encodeURIComponent(bot.id)}`, saved);
        return structuredClone(saved);
    }

    async listBots(): Promise<BotInstance[]> {
        return (await this.store.listIdempotencyEntries<BotInstance>(BOT_PREFIX)).map(entry => structuredClone(entry.value));
    }

    async upsertBinding(binding: BotAgentBinding): Promise<BotAgentBinding> {
        const saved = structuredClone(binding);
        await this.store.setIdempotencyKey(`${BINDING_PREFIX}${encodeURIComponent(binding.id)}`, saved);
        return structuredClone(saved);
    }

    async listBindings(): Promise<BotAgentBinding[]> {
        return (await this.store.listIdempotencyEntries<BotAgentBinding>(BINDING_PREFIX)).map(entry => structuredClone(entry.value));
    }

    async loadInto(bots: BotRegistry, agents: AgentRegistry): Promise<void> {
        for (const bot of await this.listBots()) bots.upsert(bot);
        for (const binding of await this.listBindings()) {
            if (agents.getInstallation(binding.agentInstallationId)) agents.upsertBinding(binding);
        }
    }
}
