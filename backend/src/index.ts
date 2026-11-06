import { createDeliveryOpsHost } from './agents/host';
import { DELIVERY_OPS_CAPABILITY } from './agents/orchestrator/deliveryOpsAgent';
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { AppConfig, loadConfig } from './core/config';
import { PrismaStore } from './core/storage';
import { FeishuAdapter } from './adapters/feishu';
import { TapdAdapter } from './adapters/tapd';
import { LLMAdapter } from './adapters/llm';
import { EmailAdapter } from './adapters/email';
import { DashboardService } from './services/dashboard';
import { ProjectDashboardService } from './services/projectDashboard';
import { DashboardImageService } from './services/dashboardImage';
import { MessageIntentParser } from './services/messageIntent';
import { MessageHandler } from './services/messageHandler';
import { MessageRouteRegistry } from './services/messageHandler/routes';
import { ScheduleRegistry } from './platform/scheduling/registry';
import { InProcessScheduler } from './core/scheduler';
import { ScheduledAgentDispatcher } from './agents/dispatcher';
import { AgentHost } from './platform/bootstrap/agentHost';
import { ScheduledJobs } from './services/jobs';
import dayjs from 'dayjs';
import * as path from 'path';
import { normalizeLogQuery } from './core/logQuery';
import { livenessReport, readinessReport } from './core/health';
import { externalApiHealthSnapshot } from './platform/observability/externalApiHealth';
import { createApiDocumentation } from './platform/observability/apiDocumentation';
import { FeishuBotConnectionManager } from './platform/bots/feishuBotConnectionManager';
import { FeishuBotMessageIngress } from './platform/bots/feishuBotMessageIngress';
import { EnvironmentSecretResolver } from './platform/secrets/resolver';
import { DEFAULT_BOT_INSTANCE_ID } from './platform/runtime/scope';
import { isLocalWorkspaceRequest, LocalConnections } from './platform/workspace/connections';
import { loadWorkspacePlugins } from './platform/workspace/composition';
import { createWorkspaceApi, createPluginApi } from './platform/workspace/api';
import { createManualJobsApi } from './platform/workspace/jobsApi';

const localConnections = new LocalConnections(path.join(loadConfig().data_path, 'connections.json'));
await localConnections.initialize();
let config = loadConfig();
let store = new PrismaStore(config.data_path);
let feishu: FeishuAdapter;
let dashboard: DashboardService;
let emailAdapter: EmailAdapter | null;
let handler: MessageHandler;
let agentHost: AgentHost | undefined;
let scheduledAgents: ScheduledAgentDispatcher | undefined;
let botConnections: FeishuBotConnectionManager | undefined;
const messageRoutes = new MessageRouteRegistry();
const schedules = new ScheduleRegistry();

function knownNamesFromConfig(current: AppConfig): Record<string, string> {
    const knownNames: Record<string, string> = {};
    for (const g of current.groups) {
        for (const m of g.members) {
            knownNames[m.open_id] = m.name;
        }
    }
    return knownNames;
}

async function reloadConfig(): Promise<void> {
    config = loadConfig(await store.getDynamicConfig());
    feishu = new FeishuAdapter(config.feishu, false, knownNamesFromConfig(config));
    feishu.setAuditCallback((action, payload) => { store.appendAuditLog(action, payload).catch(console.error); });
    dashboard = new DashboardService(store, config.data_path, config.project.name, config.runtime.public_base_url);
    const projectDashboard = new ProjectDashboardService({ config, store, tapd, dashboard, renderer: new DashboardImageService() });
    emailAdapter = config.email && config.email.enabled ? new EmailAdapter(config.email, false) : null;
    handler = new MessageHandler({
        config,
        store,
        feishu,
        tapd,
        email: emailAdapter,
        dashboard,
        projectDashboard,
        messageRoutes,
        schedules,
        intentParser,
        agentOrchestrator: {
            isAvailable: () => agentHost?.isModelAvailable() === true && agentHost.canDispatch(DELIVERY_OPS_CAPABILITY),
            handle: (message, source, replyContext) => agentHost!.handleMessage(message, source, replyContext),
            resume: (runId, message, source) => agentHost!.resumeMessage(runId, message, source),
        },
        agentDispatcher: {
            isAvailable: () => Boolean(scheduledAgents),
            runManual: (capability, groupId, input, triggerId) =>
                scheduledAgents!.runManual(capability, groupId, input, triggerId),
        },
    });
    agentHost?.refreshBot();
}
let tapd = new TapdAdapter(config.tapd);
let llm = new LLMAdapter(config.ai);
let intentParser = new MessageIntentParser(llm);

await reloadConfig();

const pluginSelection = await loadWorkspacePlugins(config.data_path);
agentHost = createDeliveryOpsHost(() => (handler as any).ctx, 1000, undefined, [], {
    messageRoutes,
    schedules,
    plugins: pluginSelection.plugins,
    pluginConfig: pluginSelection.config,
    reloadConfiguration: reloadConfig,
});
await agentHost.initialize();
await agentHost.start();

const botIngress = new FeishuBotMessageIngress(
    agentHost,
    () => handler,
    store,
    DEFAULT_BOT_INSTANCE_ID,
    message => messageRoutes.resolveBotEntry((handler as any).ctx, message, capability => agentHost!.canDispatch(capability)),
);
botConnections = new FeishuBotConnectionManager(
    agentHost.bots,
    DEFAULT_BOT_INSTANCE_ID,
    () => config.feishu,
    new EnvironmentSecretResolver(),
    store,
    (bot, adapter, data) => botIngress.handle(bot, adapter, data),
);
await botConnections.start();

scheduledAgents = new ScheduledAgentDispatcher(agentHost);
const globalPollIntervalSeconds = 6 * 60 * 60;
const scheduler = new InProcessScheduler(() => handler, 30, globalPollIntervalSeconds, scheduledAgents);
scheduler.start();

const app = new Elysia()
    .use(createApiDocumentation())
    .use(cors())
    .onBeforeHandle(({ request, set }) => {
        if (new URL(request.url).pathname.startsWith('/api/') && !isLocalWorkspaceRequest(request)) {
            set.status = 403;
            return { error: '本地管理 API 仅接受本机页面请求' };
        }
    })
    .use(createWorkspaceApi(agentHost, localConnections, () => config, pluginSelection.base, process.env.LOCAL_DEV_SESSION ? () => {
        void shutdown().then(() => process.exit(75), error => { console.error('本地配置应用失败：', error); process.exit(1); });
    } : undefined, pluginSelection.composition))
    .get('/healthz', () => livenessReport())
    .get('/readyz', async ({ set }) => {
        const report = await readinessReport({
            checkDatabase: async () => {
                await store.prisma.$queryRawUnsafe('SELECT 1');
            },
            getAgentHostHealth: () => agentHost?.health(),
            getBotConnections: () => botConnections?.health() || [],
            requiredBotInstanceIds: botConnections?.requiredBots().map(bot => bot.id) || [],
        });
        if (!report.ok) set.status = 503;
        return report;
    })
    .get('/api/agent-host/health', () => ({
        ok: true,
        host: agentHost!.health(),
        botConnections: botConnections?.health() || [],
    }))
    .get('/api/health/external-api-usage', () => ({
        ok: true,
        ...externalApiHealthSnapshot(),
    }))
    .get('/api/agents', async () => ({ ok: true, agents: await scheduledAgents!.listAgents() }))
    .get('/api/bots', async () => ({ ok: true, bots: await scheduledAgents!.listBots() }))
    .post('/api/bots', async ({ body }) => {
        const input = body as any;
        if (!input.id || !input.name || !input.appId || !input.secretRef) throw new Error('id, name, appId and secretRef are required');
        return { ok: true, bot: await scheduledAgents!.registerBot({
            id: String(input.id),
            workspaceId: String(input.workspaceId || 'workspace-default'),
            platform: 'feishu',
            name: String(input.name),
            appId: String(input.appId),
            secretRef: String(input.secretRef),
            botOpenId: input.botOpenId ? String(input.botOpenId) : undefined,
            status: input.status === 'disabled' ? 'disabled' : 'active',
            config: input.config && typeof input.config === 'object' ? input.config : {},
        }) };
    })
    .get('/api/agent-bindings', async ({ query }) => ({ ok: true, bindings: await scheduledAgents!.listBindings(query.botInstanceId ? String(query.botInstanceId) : undefined) }))
    .post('/api/agent-bindings', async ({ body }) => {
        const input = body as any;
        if (!input.botInstanceId || !input.agentInstallationId) throw new Error('botInstanceId and agentInstallationId are required');
        return { ok: true, binding: await scheduledAgents!.bindAgent({
            id: input.id ? String(input.id) : undefined,
            botInstanceId: String(input.botInstanceId),
            agentInstallationId: String(input.agentInstallationId),
            capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String) : undefined,
            priority: input.priority ? Number(input.priority) : undefined,
            enabled: input.enabled !== false,
            routingConfig: input.routingConfig || {},
            configOverride: input.configOverride || {},
        }) };
    })
    .get('/api/skills', async ({ query }) => ({ ok: true, skills: await agentHost!.listSkills(query.agentId ? String(query.agentId) : undefined) }))
    .post('/api/agents/install', async ({ body }) => {
        const input = body as any; const manifest = input.manifest;
        if (!manifest?.id || !manifest?.version) throw new Error('Agent manifest id and version are required');
        return { ok: true, agent: await scheduledAgents!.installExternal(manifest, {
            installationId: input.installationId ? String(input.installationId) : undefined,
            bindingId: input.bindingId ? String(input.bindingId) : undefined,
            config: input.config || {}, secretRefs: input.secretRefs || {}, priority: input.priority ? Number(input.priority) : undefined,
            workspaceId: input.workspaceId ? String(input.workspaceId) : undefined,
            botInstanceId: input.botInstanceId ? String(input.botInstanceId) : undefined,
        }) };
    })
    .post('/api/agents/run', async ({ body }) => {
        const input = body as any;
        if (!input.capability || !input.groupId) throw new Error('capability and groupId are required');
        const workspaceId = String(input.workspaceId || 'workspace-default');
        const botInstanceId = String(input.botInstanceId || 'bot-default');
        return { ok: true, run: botInstanceId === 'bot-default' && workspaceId === 'workspace-default'
            ? await scheduledAgents!.runManual(String(input.capability), String(input.groupId), input.input || {}, input.triggerId ? String(input.triggerId) : undefined)
            : await scheduledAgents!.runManualForBot(String(input.capability), String(input.groupId), input.input || {}, { workspaceId, botInstanceId, triggerId: input.triggerId ? String(input.triggerId) : undefined }) };
    })
    .get('/api/agent-runs/:runId', async ({ params: { runId }, set }) => {
        const details = await agentHost!.getRunDetails(runId);
        if (!details) {
            set.status = 404;
            return { error: 'AgentRun not found' };
        }
        return { ok: true, ...details };
    })
    .post('/api/agent-runs/:runId/resume', async ({ params: { runId }, body }) => {
        const input = body as any;
        if (!input.groupId) throw new Error('groupId is required');
        return {
            ok: true,
            run: await scheduledAgents!.resumeManual(
                runId,
                String(input.groupId),
                input.input ?? input.message ?? {},
                input.triggerId ? String(input.triggerId) : undefined,
                { workspaceId: String(input.workspaceId || 'workspace-default'), botInstanceId: String(input.botInstanceId || 'bot-default') },
            ),
        };
    })
    .get('/api/logs', async ({ query, set }) => {
        let normalized;
        try {
            normalized = normalizeLogQuery(query, 20);
        } catch (error: any) {
            set.status = 400;
            return { error: error?.message || "Invalid log query" };
        }
        const { page, pageSize, startAt, endBefore } = normalized;
        const eventType = query.eventType as string || '';
        const groupId = query.groupId as string || '';

        let whereClause: any = {};

        if (eventType) {
            if (eventType === 'ai_*') {
                whereClause.event_type = { startsWith: 'ai_' };
            } else {
                whereClause.event_type = eventType;
            }
        }

        if (startAt || endBefore) {
            whereClause.timestamp = {};
            if (startAt) whereClause.timestamp.gte = startAt;
            if (endBefore) whereClause.timestamp.lt = endBefore;
        }

        if (groupId) {
            whereClause.payload = { contains: groupId };
        }

        const total = await store.prisma.auditLog.count({ where: whereClause });
        const records = await store.prisma.auditLog.findMany({
            where: whereClause,
            orderBy: { id: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize
        });

        const logs = records.map(r => {
            let payload = {};
            try { payload = JSON.parse(r.payload); } catch (e) {}
            return {
                timestamp: r.timestamp,
                event_type: r.event_type,
                action: r.event_type,
                payload
            };
        });

        return {
            logs,
            total,
            page,
            pageSize
        };
    })
    .get('/api/contexts', async ({ query, set }) => {
        let normalized;
        try {
            normalized = normalizeLogQuery(query, 15);
        } catch (error: any) {
            set.status = 400;
            return { error: error?.message || "Invalid context query" };
        }
        const { page, pageSize, startAt, endBefore } = normalized;
        const contextType = query.contextType as string || '';
        const chatType = query.chatType as string || '';
        const targetOpenId = query.targetOpenId as string || '';
        const groupId = query.groupId as string || '';

        const allContexts = await store.listBotMessageContexts();
        allContexts.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

        const filtered = [];
        for (const ctx of allContexts) {
            if (contextType && ctx.context_type !== contextType) continue;
            const ts = ctx.created_at || '';
            if (startAt && ts < startAt) continue;
            if (endBefore && ts >= endBefore) continue;
            if (targetOpenId && ctx.target_open_id !== targetOpenId) continue;
            if (groupId) {
                if (ctx.chat_id !== groupId && ctx.metadata?.group_id !== groupId) continue;
            }

            const savedChatType = ctx.chat_type || '';
            const isGroup = savedChatType ? savedChatType === 'group' : !!config.groups.find(g => g.chat_id === ctx.chat_id);
            (ctx as any).is_group = isGroup;

            if (chatType === 'private' && isGroup) continue;
            if (chatType === 'group' && !isGroup) continue;

            const targetId = ctx.target_open_id;
            if (targetId) {
                const member = config.groups.flatMap(g => g.members).find(m => m.open_id === targetId);
                if (member) (ctx as any).target_name = member.name;
            }

            const chatGroup = config.groups.find(g => g.chat_id === ctx.chat_id);
            if (chatGroup) {
                (ctx as any).chat_name = chatGroup.name;
            } else if (isGroup) {
                (ctx as any).chat_name = "其他群聊";
            }

            try {
                const meta = typeof ctx.metadata === 'string' ? JSON.parse(ctx.metadata) : (ctx.metadata || {});
                if (meta.group_id) {
                    const srcGrp = config.groups.find(g => g.chat_id === meta.group_id);
                    if (srcGrp) (ctx as any).source_group_name = srcGrp.name;
                }
            } catch (e) {}

            filtered.push(ctx);
        }

        const startIdx = (page - 1) * pageSize;
        const endIdx = startIdx + pageSize;
        return {
            contexts: filtered.slice(startIdx, endIdx),
            total: filtered.length,
            page,
            pageSize
        };
    })
    .use(createManualJobsApi(agentHost!, () => ({ config, store }), sendToGroup => new ScheduledJobs(config, store, feishu, dashboard, tapd, llm, { sendToGroup })));

app.use(createPluginApi(agentHost!, app.routes))
    .listen({
        hostname: process.env.HOST || '127.0.0.1',
        port: process.env.PORT ? parseInt(process.env.PORT) : 8090,
    });

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
console.log(`Loaded config for project: ${config.project.name}`);
console.log(`Data path: ${config.data_path}`);
if (process.env.LOCAL_DEV_SESSION) console.log(JSON.stringify({
    event: 'local-dev-ready', session: process.env.LOCAL_DEV_SESSION,
    hostname: app.server?.hostname, port: app.server?.port,
}));

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
    return shutdownPromise ??= (async () => {
        await scheduler.stop();
        await botConnections?.stop();
        await agentHost?.stop();
        await app.stop();
    })();
}

process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
