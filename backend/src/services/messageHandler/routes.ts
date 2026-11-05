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
    help?: string;
    requiresProjectMember?: boolean;
    acceptsUnmentionedReply?: (replyContext: any) => boolean;
}

export class MessageRouteRegistry {
    private readonly routes = new Map<string, MessageRoute>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private stopped = false;

    register(route: MessageRoute): () => void {
        if (!/^[a-z][a-z0-9._-]*$/.test(route.id) || !Number.isFinite(route.priority)
            || !Array.isArray(route.sources) || !route.sources.length
            || route.sources.some(source => source !== 'group' && source !== 'private')
            || typeof route.handle !== 'function'
            || (route.phase !== undefined && route.phase !== 'context' && route.phase !== 'message')
            || (route.phase === 'context' && typeof route.matches !== 'function')) {
            throw new Error(`Invalid message route: ${route.id}`);
        }
        for (const field of ['matches', 'prepare', 'acceptsUnmentionedReply'] as const) {
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
