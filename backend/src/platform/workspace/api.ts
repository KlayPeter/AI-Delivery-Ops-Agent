import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { z } from 'zod';
import type { AgentHost } from '@/platform/bootstrap/agentHost';
import type { AppConfig } from '@/core/config';
import { isLocalWorkspaceRequest, type LocalConnections } from './connections';

const runInput = z.object({ capability: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 32768), triggerId: z.string().uuid().optional() }).strict();
const startInput = runInput.extend({ triggerId: z.string().uuid() });
const resumeInput = runInput.omit({ capability: true });
const actionInput = z.object({ triggerId: z.string().uuid().optional() }).strict();

export function createPluginApi(host: AgentHost, applicationRoutes: readonly { path: string }[] = []) {
    const api = new Elysia({ name: 'plugin-web-api' });
    const namespace = (path: string) => /^\/api\/[^/:*]+/.exec(path)?.[0];
    const occupied = new Set(applicationRoutes.map(route => namespace(route.path)).filter(Boolean));
    for (const route of host.web.routes()) {
        if (occupied.has(namespace(route.path))) throw new Error(`Plugin API overlaps an existing application namespace: ${namespace(route.path)}`);
        api.route(route.method, route.path, ({ request }) => host.handlePluginRequest(request), { parse: 'none' });
    }
    return api.all('/api/*', ({ request }) => host.handlePluginRequest(request), { parse: 'none' });
}

export function createWorkspaceApi(host: AgentHost, connections: LocalConnections, _getConfig: () => AppConfig) {
    return new Elysia({ prefix: '/api/workspace', name: 'local-agent-workspace' })
        .onBeforeHandle(({ request, set }) => {
            if (!isLocalWorkspaceRequest(request)) {
                set.status = 403;
                return { error: '工作台仅接受本机页面请求' };
            }
        })
        .onError(({ error, set }) => {
            const code = (error as any)?.code;
            set.status = code === 'RUN_CAPACITY' ? 429 : ['TRIGGER_INPUT_CHANGED', 'RUN_START_PENDING'].includes(code) ? 409 : 400;
            return { error: error instanceof z.ZodError ? '输入格式不正确，请检查必填项' : error instanceof Error ? error.message : '操作失败' };
        })
        .get('/state', async () => {
            const [agents, runs] = await Promise.all([host.listAgents(), host.listLocalRuns()]);
            const plugins = host.listPlugins();
            const managedByPluginFile = Boolean(process.env.AGENT_PLUGINS_FILE);
            const knowledgeKind = plugins.some(plugin => plugin.id === 'knowledge.mixed') ? 'mixed' : plugins.some(plugin => plugin.id === 'knowledge.web') ? 'web'
                : plugins.some(plugin => plugin.id === 'knowledge.markdown') ? (managedByPluginFile ? 'markdown' : process.env.KNOWLEDGE_KIND || 'sample') : 'none';
            return { agents, runs, plugins, pages: host.web.pages(), manualJobs: host.web.manualJobs(), health: host.health(), modelConfigured: host.isModelAvailable(), modelProviders: host.modelProviders.list(), knowledgeKind, managedByPluginFile };
        })
        .get('/connections', () => connections.snapshot())
        .put('/connections', async ({ body }) => connections.save(body, host.modelProviders.list().map(provider => provider.id)))
        .post('/runs', async ({ body }) => {
            const input = runInput.parse(body);
            const result = await host.runLocal(input.capability, input.input, input.triggerId || randomUUID());
            return { runId: result.execution?.run.id || result.claim.runId, status: result.execution?.run.status || result.status };
        })
        .post('/runs/start', async ({ body, set }) => {
            const input = startInput.parse(body);
            const result = await host.startLocal(input.capability, input.input, input.triggerId);
            set.status = 202; return result;
        })
        .post('/runs/:runId/cancel', async ({ params, body, set }) => {
            z.object({}).strict().parse(body);
            const result = await host.cancelLocal(z.string().uuid().parse(params.runId));
            if (!result) { set.status = 404; return { error: '未找到可控制的本机手动根运行；旧记录和子任务不能单独停止' }; }
            return result;
        })
        .get('/runs/:runId', async ({ params, set }) => {
            const details = await host.getLocalRunDetails(params.runId);
            if (!details) { set.status = 404; return { error: '未找到运行记录' }; }
            return details;
        })
        .get('/runs/:runId/actions', async ({ params, set }) => {
            const actions = await host.getLocalRunActions(params.runId);
            if (!actions) { set.status = 404; return { error: '未找到运行记录' }; }
            return { actions };
        })
        .post('/runs/:runId/actions/:actionId', async ({ params, body }) => {
            const input = actionInput.parse(body);
            const result = await host.runLocalAction(params.runId, params.actionId, input.triggerId || randomUUID());
            return { runId: result.execution?.run.id || result.claim.runId, status: result.execution?.run.status || result.status };
        })
        .post('/runs/:runId/resume', async ({ params, body }) => {
            const input = resumeInput.parse(body);
            const result = await host.resumeLocal(params.runId, input.input, input.triggerId || randomUUID());
            return { runId: result.execution?.run.id || result.claim.runId, status: result.execution?.run.status || result.status };
        });
}
