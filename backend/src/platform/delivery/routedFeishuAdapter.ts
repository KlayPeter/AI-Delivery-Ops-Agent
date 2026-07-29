import { FeishuAdapter } from '@/adapters/feishu';
import type { BotInstance } from '@/platform/bots/contracts';
import type { BotRegistry } from '@/platform/bots/registry';
import type { SecretResolver } from '@/platform/secrets/resolver';
import type { DeliveryAdapter, DeliveryRecord } from './contracts';
import { FeishuDeliveryAdapter } from './feishuAdapter';

type AdapterAudit = (bot: BotInstance, action: string, payload: Readonly<Record<string, unknown>>) => void;
type AdapterAuditEmitter = (action: string, payload: Readonly<Record<string, unknown>>) => void;
type AdapterFactory = (bot: BotInstance, appSecret: string, audit: AdapterAuditEmitter) => DeliveryAdapter;

export class RoutedFeishuDeliveryAdapter implements DeliveryAdapter {
    private readonly adapters = new Map<string, { fingerprint: string; adapter: DeliveryAdapter }>();
    private readonly factory: AdapterFactory;

    constructor(
        private readonly bots: BotRegistry,
        private readonly defaultBotId: string,
        private readonly getDefaultAdapter: () => FeishuAdapter,
        private readonly secrets: SecretResolver,
        factory?: AdapterFactory,
        private readonly audit?: AdapterAudit,
    ) {
        this.factory = factory || ((bot, appSecret, audit) => {
            const feishu = new FeishuAdapter({
                app_id: bot.appId,
                app_secret: appSecret,
                bot_open_id: bot.botOpenId || '',
                bot_name: bot.name,
                send_retry_count: Number(bot.config.sendRetryCount || 3),
            });
            feishu.setAuditCallback(audit);
            return new FeishuDeliveryAdapter(feishu);
        });
    }

    async deliver(record: DeliveryRecord, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
        const bot = this.bots.requireActive(record.target.botInstanceId);
        if (bot.id === this.defaultBotId) return new FeishuDeliveryAdapter(this.getDefaultAdapter).deliver(record, signal);
        const fingerprint = JSON.stringify([bot.appId, bot.secretRef, bot.botOpenId, bot.name, bot.config]);
        let cached = this.adapters.get(bot.id);
        if (!cached || cached.fingerprint !== fingerprint) {
            cached = {
                fingerprint,
                adapter: this.factory(
                    bot,
                    await this.secrets.resolve(bot.secretRef),
                    (action, payload) => this.audit?.(bot, action, payload),
                ),
            };
            this.adapters.set(bot.id, cached);
        }
        return cached.adapter.deliver(record, signal);
    }
}
