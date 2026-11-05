import type { SourceMessage } from '@/models/types';
import type { ContextResolver } from './ContextResolver';
import { ContextRouter } from './ContextRouter';
import type { HandlerContext } from './types';
import type { MessageSource } from './routes';

export class MessageRouter {
    static async handleGroup(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, replyContext: any): Promise<any> {
        return this.handle(ctx, resolver, message, 'group', replyContext);
    }

    static async handlePrivate(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, replyContext: any): Promise<any> {
        return this.handle(ctx, resolver, message, 'private', replyContext);
    }

    private static async handle(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: MessageSource, replyContext: any): Promise<any> {
        const work = () => this.route(ctx, resolver, message, source, replyContext);
        return ctx.messageRoutes ? ctx.messageRoutes.run(work) : work();
    }

    private static async route(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: MessageSource, replyContext: any): Promise<any> {
        const routes = ctx.messageRoutes?.list(source) || [];
        const request = { ctx, resolver, message: { ...message }, source, replyContext };
        for (const route of routes) route.prepare?.(request);
        const contextResult = await ContextRouter.maybeHandle(ctx, resolver, request.message, source, replyContext);
        if (contextResult) return contextResult;
        for (const route of routes) {
            if (route.phase === 'context' || (route.matches && !route.matches(request))) continue;
            const result = await route.handle(request);
            if (result) return result;
        }
        const help = [...new Set(routes.map(route => route.help).filter(Boolean))];
        const text = help.length
            ? `抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n${help.map(item => `- ${item}`).join('\n')}`
            : '当前没有启用可处理此消息的功能插件，请联系管理员配置。';
        if (source === 'group') await ctx.feishu.sendReplyText(message.id, text);
        else await ctx.feishu.sendPrivateText(message.sender_open_id || '', text);
        return { handled: true, action: 'unrecognized_command', reason: source === 'group' ? 'no_valid_intent_found' : 'no_private_command' };
    }
}
