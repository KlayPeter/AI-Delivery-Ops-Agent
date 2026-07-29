import type { BotInstance } from './contracts';

function cloneBot(bot: BotInstance): BotInstance {
    return {
        ...bot,
        config: { ...bot.config },
    };
}

export class BotRegistry {
    private readonly bots = new Map<string, BotInstance>();

    constructor(instances: readonly BotInstance[] = []) {
        for (const instance of instances) this.register(instance);
    }

    register(instance: BotInstance): void {
        if (!instance.id.trim()) throw new Error('BotInstance id is required');
        if (!instance.workspaceId.trim()) throw new Error('BotInstance workspaceId is required');
        if (this.bots.has(instance.id)) throw new Error(`BotInstance already registered: ${instance.id}`);
        this.bots.set(instance.id, cloneBot(instance));
    }

    upsert(instance: BotInstance): void {
        if (!instance.id.trim()) throw new Error('BotInstance id is required');
        if (!instance.workspaceId.trim()) throw new Error('BotInstance workspaceId is required');
        this.bots.set(instance.id, cloneBot(instance));
    }

    get(id: string): BotInstance | null {
        const bot = this.bots.get(id);
        return bot ? cloneBot(bot) : null;
    }

    requireActive(id: string): BotInstance {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`BotInstance not found: ${id}`);
        if (bot.status !== 'active') throw new Error(`BotInstance is not active: ${id}`);
        return cloneBot(bot);
    }

    list(workspaceId?: string): BotInstance[] {
        return Array.from(this.bots.values())
            .filter(bot => !workspaceId || bot.workspaceId === workspaceId)
            .map(cloneBot);
    }
}
