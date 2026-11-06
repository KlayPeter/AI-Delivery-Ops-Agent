import { AI_NEWS_RADAR_CAPABILITY, aiNewsRadarManifest, registerAiNewsRadarAgent } from '@/agents/native/ai-news-radar/aiNewsRadarAgent';
import { AiHotNewsProvider } from '@/agents/native/ai-news-radar/provider';
import type { FeaturePlugin, PluginHostServices } from '@/platform/plugins/contracts';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { createAiNewsIntentRouter } from '@/agents/native/ai-news-radar/intent';

export const aiNewsPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'builtin.ai-news', name: 'AI news', version: '1.1.0', description: 'AI news retrieval, plugin-owned message routing and optional dedicated Feishu bot.' },
    agents: [{ manifest: aiNewsRadarManifest, installationId: 'install-native-ai-news-radar' }],
    apply(ctx) {
        const routeIntent = createAiNewsIntentRouter();
        ctx.delivery.messageRoutes.registerBotEntry({
            id: 'builtin.ai-news', priority: 100, capability: AI_NEWS_RADAR_CAPABILITY,
            matches({ ctx: current, message }) {
                const config = current.config.ai_news;
                return config.enabled && (!config.app_id.trim() || config.app_id.trim() === current.config.feishu.app_id.trim()) && routeIntent(message);
            },
        });
        registerAiNewsRadarAgent(ctx.delivery.nativeAgents, () => {
            const config = ctx.delivery.getContext().config.ai_news;
            return new AiHotNewsProvider({ baseUrl: config.source_url, defaultLimit: config.default_limit, timeoutMs: config.request_timeout_ms });
        });
        ctx.on('delivery/restored', () => configureNewsBot(ctx.delivery));
    },
};

async function configureNewsBot(services: PluginHostServices): Promise<void> {
    const config = services.getContext().config.ai_news;
    if (!config) return;
    services.agents.upsertBinding({
        id: 'bind-native.ai-news-radar-default', botInstanceId: DEFAULT_BOT_INSTANCE_ID,
        agentInstallationId: 'install-native-ai-news-radar', enabled: config.enabled, priority: 1,
        capabilities: [AI_NEWS_RADAR_CAPABILITY], routingConfig: {}, configOverride: {},
    });
    const dedicatedAppId = config.app_id.trim();
    const defaultAppId = services.getContext().config.feishu.app_id.trim();
    if (!config.enabled || !dedicatedAppId || dedicatedAppId === defaultAppId) {
        const existing = services.bots.get(config.bot_instance_id);
        if (existing?.config.managedBy === 'ai-news-config' && existing.status !== 'disabled') {
            services.bots.upsert(await services.botCatalog.upsertBot({ ...existing, status: 'disabled' }));
        }
        return;
    }
    if (!config.bot_instance_id.trim() || config.bot_instance_id === DEFAULT_BOT_INSTANCE_ID) {
        throw new Error('AI News bot_instance_id must be a non-default BotInstance id');
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(config.app_secret_env)) {
        throw new Error('FEISHU_AI_NEWS_APP_SECRET_ENV must name an uppercase environment variable');
    }
    services.bots.upsert(await services.botCatalog.upsertBot({
        id: config.bot_instance_id, workspaceId: DEFAULT_WORKSPACE_ID, platform: 'feishu', name: config.bot_name,
        appId: dedicatedAppId, secretRef: `env://${config.app_secret_env}`, status: 'active',
        config: { managedBy: 'ai-news-config', inboundEnabled: true, receiveMode: 'p2p', entryCapability: AI_NEWS_RADAR_CAPABILITY, sendRetryCount: 3 },
    }));
    services.agents.upsertBinding(await services.botCatalog.upsertBinding({
        id: `bind-install-native-ai-news-radar-${config.bot_instance_id}`, botInstanceId: config.bot_instance_id,
        agentInstallationId: 'install-native-ai-news-radar', enabled: true, priority: 1,
        capabilities: [AI_NEWS_RADAR_CAPABILITY], routingConfig: { receiveMode: 'p2p' }, configOverride: {},
    }));
}
