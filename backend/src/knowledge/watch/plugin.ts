import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { readSmallJsonBody } from '@/platform/workspace/request';
import { KnowledgeWatchService, WatchError } from './service';

export const knowledgeWatchPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'knowledge.watch', name: '知识定期复核', version: '1.1.0',
        description: '为所选历史结果定期检查实际引用的资料版本，保留独立复核记录和原结果；无需模型。', requires: ['knowledge.impact'] },
    Config: z.object({}).strict(),
    apply(ctx) {
        if (!ctx.delivery.runScheduledLocal) throw new Error('定期复核需要宿主本机调度服务');
        const service = new KnowledgeWatchService(ctx.delivery.getContext().store, ctx.delivery.agents, ctx.delivery.runScheduledLocal);
        ctx.effect(() => {
            const timer = setInterval(() => { void service.tick().catch(() => {
                void Promise.resolve(ctx.delivery.getContext().store.appendAuditLog('knowledge_watch_tick_failed', { message: '定期复核状态读写失败，请检查本机存储' })).catch(() => {});
            }); }, 30_000);
            return async () => { clearInterval(timer); await service.stop(); };
        });
        ctx.delivery.web.register({ id: 'knowledge.watch', api: { prefix: '/api/knowledge-watch', routes: [
            { method: 'GET', path: '/api/knowledge-watch' }, { method: 'POST', path: '/api/knowledge-watch' }, { method: 'POST', path: '/api/knowledge-watch/pause' }, { method: 'GET', path: '/api/knowledge-watch/runs/:runId' },
        ], async handle(request) {
            const path = new URL(request.url).pathname;
            let input: unknown;
            if (request.method === 'POST') {
                try { input = await readSmallJsonBody(request); }
                catch { return Response.json({ error: '请提交有效的有界 JSON 计划' }, { status: 400 }); }
            }
            try {
                if (request.method === 'GET' && path === '/api/knowledge-watch') return Response.json(await service.status());
                const receipt = /^\/api\/knowledge-watch\/runs\/([^/]+)$/.exec(path);
                if (request.method === 'GET' && receipt) return Response.json({ receipt: await service.receipt(receipt[1]!) });
                if (request.method === 'POST' && path === '/api/knowledge-watch') return Response.json({ plan: await service.configure(input) });
                if (request.method === 'POST' && path === '/api/knowledge-watch/pause') { z.object({}).strict().parse(input); return Response.json({ plan: await service.pause() }); }
                return Response.json({ error: '当前插件未提供此接口' }, { status: 404 });
            } catch (error) { return Response.json({ error: error instanceof WatchError ? error.message : error instanceof z.ZodError ? '请选择最多 20 条不同结果和有效复核频率' : '定期复核状态暂不可用，请检查本机存储' }, { status: error instanceof WatchError ? error.status : error instanceof z.ZodError ? 400 : 500 }); }
        } } });
    },
};
export default knowledgeWatchPlugin;
