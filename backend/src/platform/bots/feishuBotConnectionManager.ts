import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuAdapter } from '@/adapters/feishu';
import type { FeishuConfig } from '@/core/config';
import type { SecretResolver } from '@/platform/secrets/resolver';
import type { BotInstance } from './contracts';
import type { BotRegistry } from './registry';

interface WsClientLike {
    start(options: { eventDispatcher: any }): Promise<void>;
    close(options?: { force?: boolean }): void;
    getConnectionStatus?: () => { state: string; reconnectAttempts: number };
}

interface ConnectionManagerDependencies {
    createClient?: (input: { appId: string; appSecret: string }) => WsClientLike;
    createDispatcher?: (handler: (data: any) => Promise<void>) => any;
    createAdapter?: (config: FeishuConfig) => FeishuAdapter;
}

interface AuditStore {
    appendAuditLog(action: string, payload: unknown): Promise<unknown>;
    claimIdempotencyKey?(key: string, value: unknown): Promise<boolean>;
}

export class FeishuBotConnectionManager {
    private readonly clients = new Map<string, WsClientLike>();
    private readonly adapters = new Map<string, FeishuAdapter>();
    private readonly processedEvents = new Map<string, number>();
    private readonly createClient: (input: { appId: string; appSecret: string }) => WsClientLike;
    private readonly createDispatcher: (handler: (data: any) => Promise<void>) => any;
    private readonly createAdapter: (config: FeishuConfig) => FeishuAdapter;

    constructor(
        private readonly bots: BotRegistry,
        private readonly defaultBotId: string,
        private readonly getDefaultConfig: () => FeishuConfig,
        private readonly secrets: SecretResolver,
        private readonly store: AuditStore,
        private readonly onMessage: (bot: BotInstance, adapter: FeishuAdapter, data: any) => Promise<unknown>,
        dependencies: ConnectionManagerDependencies = {},
    ) {
        this.createClient = dependencies.createClient || (input => new Lark.WSClient(input));
        this.createDispatcher = dependencies.createDispatcher || (handler =>
            new Lark.EventDispatcher({}).register({ 'im.message.receive_v1': handler }));
        this.createAdapter = dependencies.createAdapter || (config => new FeishuAdapter(config));
    }

    async start(): Promise<void> {
        if (this.clients.size) return;
        const activeBots = this.bots.list().filter(bot => bot.status === 'active' && bot.config.inboundEnabled !== false);
        try {
            for (const bot of activeBots) await this.startBot(bot);
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        for (const client of this.clients.values()) client.close({ force: true });
        this.clients.clear();
        this.adapters.clear();
    }

    health(): Array<{ botInstanceId: string; state: string; reconnectAttempts: number }> {
        return Array.from(this.clients.entries()).map(([botInstanceId, client]) => {
            const status = client.getConnectionStatus?.();
            return {
                botInstanceId,
                state: status?.state || 'started',
                reconnectAttempts: status?.reconnectAttempts || 0,
            };
        });
    }

    private async startBot(bot: BotInstance): Promise<void> {
        const config = await this.feishuConfig(bot);
        if (!/^cli_[0-9a-fA-F]{16}$/.test(config.app_id)) throw new Error(`Invalid Feishu App ID for BotInstance: ${bot.id}`);
        const adapter = this.createAdapter(config);
        adapter.setAuditCallback((action, payload) => {
            this.store.appendAuditLog(action, { ...payload, bot_instance_id: bot.id }).catch(() => {});
        });
        const client = this.createClient({ appId: config.app_id, appSecret: config.app_secret });
        const dispatcher = this.createDispatcher(async data => {
            const headerAppId = String(data?.header?.app_id || '');
            if (headerAppId && headerAppId !== bot.appId) {
                await this.audit('feishu_bot_event_rejected', {
                    bot_instance_id: bot.id,
                    reason: 'app_id_mismatch',
                });
                return;
            }
            const messageId = String(data?.event?.message?.message_id || data?.message?.message_id || '');
            if (messageId && await this.isDuplicate(bot, messageId)) return;
            Promise.resolve(this.onMessage(bot, adapter, data)).catch(error => {
                this.audit('feishu_bot_handler_failed', {
                    bot_instance_id: bot.id,
                    message_id: messageId,
                    error: error instanceof Error ? error.message : String(error),
                }).catch(() => {});
            });
        });
        this.clients.set(bot.id, client);
        this.adapters.set(bot.id, adapter);
        try {
            await client.start({ eventDispatcher: dispatcher });
            await this.audit('feishu_bot_connection_started', {
                workspace_id: bot.workspaceId,
                bot_instance_id: bot.id,
                receive_mode: String(bot.config.receiveMode || 'default'),
            });
        } catch (error) {
            this.clients.delete(bot.id);
            this.adapters.delete(bot.id);
            throw error;
        }
    }

    private async feishuConfig(bot: BotInstance): Promise<FeishuConfig> {
        if (bot.id === this.defaultBotId) return this.getDefaultConfig();
        return {
            app_id: bot.appId,
            app_secret: await this.secrets.resolve(bot.secretRef),
            bot_open_id: bot.botOpenId || '',
            bot_name: bot.name,
            send_retry_count: Number(bot.config.sendRetryCount || 3),
        };
    }

    private async isDuplicate(bot: BotInstance, messageId: string): Promise<boolean> {
        const key = `${bot.id}:${messageId}`;
        if (this.processedEvents.has(key)) return true;
        if (this.store.claimIdempotencyKey) {
            const persistentKey = `feishu:event:${encodeURIComponent(bot.workspaceId)}:${encodeURIComponent(bot.id)}:${encodeURIComponent(messageId)}`;
            const claimed = await this.store.claimIdempotencyKey(persistentKey, {
                received_at: new Date().toISOString(),
                workspace_id: bot.workspaceId,
                bot_instance_id: bot.id,
                message_id: messageId,
            });
            if (!claimed) return true;
        }
        this.processedEvents.set(key, Date.now());
        if (this.processedEvents.size > 1000) {
            const cutoff = Date.now() - 3600_000;
            for (const [eventKey, receivedAt] of this.processedEvents) {
                if (receivedAt < cutoff) this.processedEvents.delete(eventKey);
            }
            while (this.processedEvents.size > 1000) {
                const oldestKey = this.processedEvents.keys().next().value;
                if (!oldestKey) break;
                this.processedEvents.delete(oldestKey);
            }
        }
        return false;
    }

    private async audit(action: string, payload: unknown): Promise<void> {
        await this.store.appendAuditLog(action, payload).catch(() => {});
    }
}
