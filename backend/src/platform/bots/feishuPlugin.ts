import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { DEFAULT_BOT_INSTANCE_ID } from '@/platform/runtime/scope';
import { EnvironmentSecretResolver } from '@/platform/secrets/resolver';
import { RoutedFeishuDeliveryAdapter } from '@/platform/delivery/routedFeishuAdapter';
import { MessageHandler } from '@/services/messageHandler';
import { FeishuBotMessageIngress } from './feishuBotMessageIngress';
import { FeishuBotConnectionManager, type ConnectionManagerDependencies } from './feishuBotConnectionManager';

export function createFeishuTransportPlugin(dependencies: ConnectionManagerDependencies = {}): FeaturePlugin {
    return {
        manifest: { apiVersion: '1.0', id: 'channel.feishu', name: '飞书通道', version: '1.0.0', description: '飞书入站、多机器人投递及连接就绪状态。' },
        apply(ctx) {
            const services = ctx.delivery, getContext = services.getContext;
            if (!services.transports || !services.dispatchBotMessage) throw new Error('Host transport and Bot dispatch ports are required');
            const secrets = new EnvironmentSecretResolver(), incoming = new Set<Promise<unknown>>();
            let accepting = false;
            const ingress = new FeishuBotMessageIngress(
                { dispatchBotMessage: input => services.dispatchBotMessage!(input) },
                () => new MessageHandler(getContext()), getContext().store, DEFAULT_BOT_INSTANCE_ID,
                message => getContext().messageRoutes?.resolveBotEntry(getContext(), message, capability => services.canDispatch?.(capability) === true) || null,
            );
            const manager = new FeishuBotConnectionManager(
                services.bots, DEFAULT_BOT_INSTANCE_ID,
                () => Object.assign({ app_id: '', app_secret: '', bot_name: '', bot_open_id: '', send_retry_count: 1 }, getContext().config.feishu),
                secrets, getContext().store,
                async (bot, adapter, data) => {
                    if (!accepting) return { handled: false, reason: 'transport_stopping' };
                    const pending = ingress.handle(bot, adapter, data); incoming.add(pending);
                    try { return await pending; } finally { incoming.delete(pending); }
                }, dependencies,
            );
            const delivery = new RoutedFeishuDeliveryAdapter(services.bots, DEFAULT_BOT_INSTANCE_ID, () => getContext().feishu, secrets, undefined,
                (bot, action, payload) => { getContext().store.appendAuditLog(action, { ...payload, bot_instance_id: bot.id }).catch(() => {}); });
            services.transports.register({
                id: 'channel.feishu', delivery,
                async start() { accepting = true; try { await manager.start(); } catch (error) { accepting = false; throw error; } },
                async stopIngress() { accepting = false; await manager.stop(); },
                async stop() { while (incoming.size) await Promise.allSettled(incoming); await manager.stop(); },
                health: () => ({ requiredBotInstanceIds: manager.requiredBots().map(bot => bot.id), connections: manager.health() }),
            });
        },
    };
}

export const feishuTransportPlugin = createFeishuTransportPlugin();
export default feishuTransportPlugin;
