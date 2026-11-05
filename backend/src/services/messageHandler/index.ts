import { HandlerContext, WORKING_REACTION_MIN_SECONDS } from './types';
import { SourceMessage } from '@/models/types';
import { ContextResolver } from './ContextResolver';
import { MessageRouter } from './MessageRouter';
import { isSystemNoise } from './utils';
import { EmailAdapter } from '@/adapters/email';

export class MessageHandler {
    private ctx: HandlerContext;
    private resolver: ContextResolver;
    private email: EmailAdapter;

    constructor(ctx: HandlerContext) {
        this.ctx = ctx;
        this.resolver = new ContextResolver(ctx);
        this.email = ctx.config.email && ctx.config.email.enabled ? new EmailAdapter(ctx.config.email) : new EmailAdapter({ enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from_address: '', to_addresses: [] }, true);
    }

    async handleEvent(payload: any): Promise<any> {
        const message = this.ctx.feishu.parseEvent(payload);
        if (!message) return { handled: false, reason: "not_message_event" };

        const isGroup = message.chat_type === "group";
        const botMentioned = this.isBotMentioned(message);
        const replyContext = await this.resolver.resolveReplyContext(message);

        const acceptsReply = isGroup && !botMentioned && this.ctx.messageRoutes?.list('group').some(route => route.acceptsUnmentionedReply?.(replyContext));
        if (isGroup && !botMentioned && !acceptsReply) {
            return { handled: false, reason: "not_directed_at_bot" };
        }

        const startedAt = Date.now();
        let reactionId: string | undefined = undefined;

        reactionId = await this.addWorkingReaction(message);

        try {
            await this.ctx.store.saveSourceMessage(message);
            await this.ctx.store.appendAuditLog("source_message_received", {
                message_id: message.id,
                chat_id: message.chat_id,
                chat_type: message.chat_type,
                sent_at: message.sent_at,
                sender: message.sender_name,
                sender_open_id: message.sender_open_id,
                mentions: message.mentions,
                text: (message.text || "").substring(0, 200)
            });

            if (isSystemNoise(message.text || "")) {
                return { handled: false, reason: "system_noise" };
            }

            if (isGroup) {
                return await this.handleGroupMessage(message, replyContext);
            }
            return await this.handlePrivateMessage(message, replyContext);
        } catch (error: any) {
            console.error("Error processing message (possible deployment/restart):", error);
            const errStr = String(error.message || error);
            const errorCategory = classifyMessageError(errStr);
            try {
                await this.ctx.store.appendAuditLog("message_processing_failed", {
                    message_id: message.id,
                    chat_id: message.chat_id,
                    chat_type: message.chat_type,
                    category: errorCategory,
                    error: errStr.slice(0, 500),
                });
            } catch (auditError) {
                console.error("Failed to audit message processing failure:", auditError);
            }
            let fallbackMsg = "⚠️ 机器人系统可能正在发布升级中，或者遇到了内部异常，操作已被终止。\n请稍后再试（建议等 5 分钟后重试）。";
            if (errorCategory === "ai_rate_limited") {
                fallbackMsg = "⚠️ AI 服务当前限流，暂时无法处理需要 AI 理解的请求，请稍后再试。";
            } else if (errStr.includes("LLM API") || errStr.includes("TAPD API") || errStr.includes("timeout") || errStr.includes("Network") || errStr.includes("ECONNRESET")) {
                fallbackMsg = "⚠️ 请求超时或网络异常，当前操作未成功，请稍后再试。";
            }
            try {
                if (isGroup) {
                    await this.ctx.feishu.sendReplyText(message.id, fallbackMsg);
                } else if (message.sender_open_id) {
                    await this.ctx.feishu.sendPrivateText(message.sender_open_id, fallbackMsg);
                }
            } catch (replyErr) {
                console.error("Failed to send fallback reply:", replyErr);
            }
            return { handled: true, action: "error_fallback", error: error.message || String(error) };
        } finally {
            if (reactionId) {
                if (!this.ctx.feishu.dryRun) {
                    const elapsed = (Date.now() - startedAt) / 1000.0;
                    if (elapsed < WORKING_REACTION_MIN_SECONDS) {
                        await new Promise(resolve => setTimeout(resolve, (WORKING_REACTION_MIN_SECONDS - elapsed) * 1000));
                    }
                }
                await this.ctx.feishu.removeReaction(message.id, reactionId);
            }
        }
    }

    private async handleGroupMessage(message: SourceMessage, replyContext: any): Promise<any> {
        return MessageRouter.handleGroup(this.ctx, this.resolver, message, replyContext);
    }

    private async handlePrivateMessage(message: SourceMessage, replyContext: any): Promise<any> {
        if (this.ctx.messageRoutes?.list('private').some(route => route.requiresProjectMember)) {
            const { resolvePrivateSender } = require('./utils');
            const sender = await resolvePrivateSender(message, this.ctx);
            if (sender) {
                message.sender_open_id = sender.open_id;
                message.sender_name = sender.name;
                await this.ctx.store.saveSourceMessage(message);
            } else if (message.sender_open_id) {
                const fetchedName = await this.ctx.feishu.getUserName(message.sender_open_id);
                const nameDisplay = fetchedName ? `姓名：${fetchedName}，` : "";
                await this.ctx.feishu.sendPrivateText(message.sender_open_id, `无法识别您的身份（${nameDisplay}OpenID: ${message.sender_open_id}）。请联系管理员在系统中台将该 ID 绑定到对应项目成员中。`);
                await this.ctx.store.appendAuditLog("unknown_user", { open_id: message.sender_open_id, chat_id: message.chat_id, fetched_name: fetchedName });
                return { handled: true, action: "unknown_user" };
            }
        }

        return MessageRouter.handlePrivate(this.ctx, this.resolver, message, replyContext);
    }

    private async addWorkingReaction(message: SourceMessage): Promise<string | undefined> {
        const types = ["Typing", "OK"];
        const errors = [];
        for (const type of types) {
            const reactionId = await this.ctx.feishu.addReaction(message.id, type);
            if (reactionId) return reactionId;
            if (this.ctx.feishu.lastReactionError) errors.push({ emoji_type: type, error: this.ctx.feishu.lastReactionError });
        }
        if (errors.length && !this.ctx.feishu.dryRun) {
            this.ctx.store.appendAuditLog("working_reaction_failed", { message_id: message.id, errors });
        }
        return undefined;
    }

    private isBotMentioned(message: SourceMessage): boolean {
        const botOpenId = this.ctx.config.feishu.bot_open_id;
        const botName = this.ctx.config.feishu.bot_name;
        const mentions = message.mentions || [];

        if (botOpenId && mentions.some(m => m.open_id === botOpenId)) return true;
        if (botName && mentions.some(m => m.name === botName || m.name?.includes(botName))) return true;
        return !!botName && (message.text || "").includes(`@${botName}`);
    }
}

function classifyMessageError(errorText: string): string {
    if (/LLM API/i.test(errorText) && /too many requests|rate limit|quota|\b429\b/i.test(errorText)) {
        return "ai_rate_limited";
    }
    if (/LLM API/i.test(errorText)) return "ai_unavailable";
    if (/TAPD API/i.test(errorText)) return "tapd_unavailable";
    if (/timeout|ECONNRESET|Network/i.test(errorText)) return "network_or_timeout";
    return "internal_error";
}
