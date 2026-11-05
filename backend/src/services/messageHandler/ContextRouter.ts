import type { SourceMessage } from '@/models/types';
import type { ContextResolver } from './ContextResolver';
import type { HandlerContext } from './types';
import type { MessageSource } from './routes';

export class ContextRouter {
    static async maybeHandle(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: MessageSource, replyContext: any): Promise<any> {
        if (!replyContext?.context_type) return null;
        const request = { ctx, resolver, message, source, replyContext };
        const route = ctx.messageRoutes?.list(source, 'context').find(route => route.matches!(request));
        // A matching context owns this phase even when its handler declines the message.
        return route ? route.handle(request) : null;
    }
}
