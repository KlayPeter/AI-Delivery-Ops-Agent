import type { FeishuAdapter } from '@/adapters/feishu';
import type { SourceMessage } from '@/models/types';
import type { BotInstance } from './contracts';

interface AgentMessageDispatcher {
    dispatchBotMessage(input: {
        workspaceId: string;
        botInstanceId: string;
        capability: string;
        message: SourceMessage;
        targetOpenId: string;
    }): Promise<unknown>;
}

interface DefaultMessageHandler {
    handleEvent(payload: unknown): Promise<unknown>;
}

interface AuditStore {
    appendAuditLog(action: string, payload: unknown): Promise<unknown>;
}

interface DefaultBotRoute {
    capability: string;
}

export class FeishuBotMessageIngress {
    constructor(
        private readonly agentHost: AgentMessageDispatcher,
        private readonly getDefaultHandler: () => DefaultMessageHandler,
        private readonly store: AuditStore,
        private readonly defaultBotId: string,
        private readonly resolveDefaultBotRoute: (message: SourceMessage) => DefaultBotRoute | null = () => null,
    ) {}

    async handle(bot: BotInstance, feishu: FeishuAdapter, data: any): Promise<unknown> {
        const event = data?.event?.message ? data.event : data;
        const message = feishu.parseEvent({ event });
        if (bot.id === this.defaultBotId) {
            const route = message ? this.resolveDefaultBotRoute(message) : null;
            if (!route) return this.getDefaultHandler().handleEvent({ event });
            if (message!.chat_type !== 'p2p' || message!.message_type !== 'text' || !message!.sender_open_id) {
                return this.getDefaultHandler().handleEvent({ event });
            }
            return this.dispatchCapability(bot, feishu, message!, route.capability);
        }

        if (!message) return { handled: false, reason: 'not_message_event' };
        const receiveMode = String(bot.config.receiveMode || 'p2p');
        if (receiveMode === 'p2p' && message.chat_type === 'group') {
            await this.audit('bot_message_ignored', {
                bot_instance_id: bot.id,
                message_id: message.id,
                chat_type: message.chat_type,
                reason: 'p2p_only',
            });
            return { handled: false, reason: 'p2p_only' };
        }
        if (!message.sender_open_id) {
            await this.audit('bot_message_ignored', {
                bot_instance_id: bot.id,
                message_id: message.id,
                reason: 'missing_sender_open_id',
            });
            return { handled: false, reason: 'missing_sender_open_id' };
        }
        if (message.message_type !== 'text') {
            await feishu.sendPrivateText(message.sender_open_id, '请发送文字，例如“今天 AI 圈有什么热点”。');
            return { handled: true, action: 'unsupported_message_type' };
        }
        const capability = String(bot.config.entryCapability || '').trim();
        if (!capability) {
            await this.audit('bot_message_ignored', {
                bot_instance_id: bot.id,
                message_id: message.id,
                reason: 'entry_capability_missing',
            });
            return { handled: false, reason: 'entry_capability_missing' };
        }

        return this.dispatchCapability(bot, feishu, message, capability);
    }

    private async dispatchCapability(
        bot: BotInstance,
        feishu: FeishuAdapter,
        message: SourceMessage,
        capability: string,
    ): Promise<unknown> {
        await this.audit('source_message_received', {
            workspace_id: bot.workspaceId,
            bot_instance_id: bot.id,
            message_id: message.id,
            chat_id: message.chat_id,
            chat_type: message.chat_type,
            sender_open_id: message.sender_open_id,
        });
        try {
            const result = await this.agentHost.dispatchBotMessage({
                workspaceId: bot.workspaceId,
                botInstanceId: bot.id,
                capability,
                message,
                targetOpenId: message.sender_open_id,
            });
            return { handled: true, action: 'agent_dispatched', result };
        } catch (cause: any) {
            await this.audit('bot_agent_dispatch_failed', {
                workspace_id: bot.workspaceId,
                bot_instance_id: bot.id,
                message_id: message.id,
                capability,
                error: cause?.message || String(cause),
            });
            await feishu.sendPrivateText(message.sender_open_id, '⚠️ AI 新闻暂时获取失败，请稍后再试。');
            return { handled: true, action: 'agent_failed', error: cause?.message || String(cause) };
        }
    }

    private async audit(action: string, payload: unknown): Promise<void> {
        await this.store.appendAuditLog(action, payload).catch(() => {});
    }
}
