import type { SourceMessage } from '@/models/types';
import type { ContextResolver } from './ContextResolver';
import type { HandlerContext } from './types';

export type MessageSource = 'group' | 'private';

export interface MessageRouteRequest {
    ctx: HandlerContext;
    resolver: ContextResolver;
    message: SourceMessage;
    source: MessageSource;
    replyContext: any;
}

export interface MessageRoute {
    id: string;
    priority: number;
    sources: readonly MessageSource[];
    phase?: 'context' | 'message';
    matches?: (request: MessageRouteRequest) => boolean;
    handle: (request: MessageRouteRequest) => Promise<any>;
    prepare?: (request: MessageRouteRequest) => void;
    lookupContext?: (ctx: HandlerContext, messageId: string) => Promise<any>;
    help?: string;
    requiresProjectMember?: boolean;
    acceptsUnmentionedReply?: (replyContext: any) => boolean;
}

export interface BotMessageEntry {
    id: string;
    priority: number;
    capability: string;
    matches: (request: Pick<MessageRouteRequest, 'ctx' | 'message'>) => boolean;
}

export class MessageRouteRegistry {
    private readonly routes = new Map<string, MessageRoute>();
    private readonly botEntries = new Map<string, BotMessageEntry>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private stopped = false;

    register(route: MessageRoute): () => void {
        if (!/^[a-z][a-z0-9._-]*$/.test(route.id) || !Number.isFinite(route.priority)
            || !Array.isArray(route.sources) || !route.sources.length
            || route.sources.some(source => source !== 'group' && source !== 'private')
            || typeof route.handle !== 'function'
            || (route.phase !== undefined && route.phase !== 'context' && route.phase !== 'message')
            || (route.phase === 'context' && typeof route.matches !== 'function')
            || (route.lookupContext !== undefined && route.phase !== 'context')) {
            throw new Error(`Invalid message route: ${route.id}`);
        }
        for (const field of ['matches', 'prepare', 'acceptsUnmentionedReply', 'lookupContext'] as const) {
            if (route[field] !== undefined && typeof route[field] !== 'function') throw new Error(`Invalid message route ${field}: ${route.id}`);
        }
        if (route.help !== undefined && (typeof route.help !== 'string' || !route.help.trim())) throw new Error(`Invalid message route help: ${route.id}`);
        if (route.requiresProjectMember !== undefined && typeof route.requiresProjectMember !== 'boolean') throw new Error(`Invalid message route membership: ${route.id}`);
        if (this.routes.has(route.id)) throw new Error(`Duplicate message route: ${route.id}`);
        const phase = route.phase || 'message';
        if ([...this.routes.values()].some(existing => existing.phase === phase && existing.priority === route.priority)) {
            throw new Error(`Duplicate message route priority in ${phase}: ${route.priority}`);
        }
        const registered = Object.freeze({ ...route, phase, sources: Object.freeze([...route.sources]) });
        this.routes.set(route.id, registered);
        return () => { if (this.routes.get(route.id) === registered) this.routes.delete(route.id); };
    }

    list(source?: MessageSource, phase?: MessageRoute['phase']): MessageRoute[] {
        return [...this.routes.values()]
            .filter(route => (!source || route.sources.includes(source)) && (!phase || route.phase === phase))
            .sort((left, right) => right.priority - left.priority);
    }

    registerBotEntry(entry: BotMessageEntry): () => void {
        if (!/^[a-z][a-z0-9._-]*$/.test(entry.id) || !Number.isFinite(entry.priority)
            || typeof entry.capability !== 'string' || !entry.capability.trim() || entry.capability.length > 200 || typeof entry.matches !== 'function') {
            throw new Error('Invalid bot message entry');
        }
        if (this.botEntries.has(entry.id)) throw new Error(`Duplicate bot message entry: ${entry.id}`);
        if ([...this.botEntries.values()].some(existing => existing.priority === entry.priority)) throw new Error(`Duplicate bot entry priority: ${entry.priority}`);
        const registered = Object.freeze({ ...entry });
        this.botEntries.set(entry.id, registered);
        return () => { if (this.botEntries.get(entry.id) === registered) this.botEntries.delete(entry.id); };
    }

    resolveBotEntry(ctx: HandlerContext, message: SourceMessage, canDispatch: (capability: string) => boolean): { capability: string } | null {
        if (this.stopped || message.chat_type !== 'p2p' || message.message_type !== 'text' || !message.sender_open_id) return null;
        for (const entry of [...this.botEntries.values()].sort((left, right) => right.priority - left.priority)) {
            if (canDispatch(entry.capability) && entry.matches({ ctx, message })) return { capability: entry.capability };
        }
        return null;
    }

    run<T>(work: () => Promise<T>): Promise<T> {
        if (this.stopped) return Promise.reject(new Error('Message routing is stopped'));
        const pending = Promise.resolve().then(work);
        this.inFlight.add(pending);
        return pending.finally(() => { this.inFlight.delete(pending); });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await Promise.allSettled(this.inFlight);
    }
}
