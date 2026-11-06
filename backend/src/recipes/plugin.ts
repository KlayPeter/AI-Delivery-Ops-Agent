import { z } from 'zod';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { RunRecipeService } from './service';
import { readJsonInput } from '@/platform/workspace/requestBody';

export const recipeConfig = z.object({ capabilities: z.array(z.string().regex(/^[a-z][a-z0-9.-]*$/).max(160)).max(30).default([
    'knowledge.markdown.retrieve', 'knowledge.web.retrieve', 'knowledge.answer', 'personal.research', 'knowledge.page.capture', 'knowledge.impact.check', 'docs.context7.lookup', 'docs.context7.research', 'release.prepare', 'mcp.tools.run',
]) }).strict();
export const runRecipesPlugin: FeaturePlugin = {
    manifest: { apiVersion: '1.0', id: 'personal.recipes', name: '任务配方', version: '1.0.0', description: '从成功运行核对原参数和执行版本，经审查保存配方；再次确认参数后创建新运行，保留来源关联。' },
    Config: recipeConfig,
    apply(ctx, value) {
        if (!ctx.delivery.runLocal) throw new Error('任务配方需要宿主本机运行服务');
        const config = recipeConfig.parse(value);
        const service = new RunRecipeService(ctx.delivery.getContext().store, ctx.delivery.agents, config.capabilities, ctx.delivery.runLocal);
        ctx.delivery.web.register({ id: 'personal.recipes', pages: [{ path: '/recipes', label: '任务配方', section: 'workspace', view: { kind: 'builtin', id: 'run-recipes' } }],
            api: { prefix: '/api/recipes', routes: [{ method: 'GET', path: '/api/recipes' }, { method: 'POST', path: '/api/recipes' }, { method: 'GET', path: '/api/recipes/:id' }, { method: 'POST', path: '/api/recipes/:id/run' }, { method: 'GET', path: '/api/recipes/launches/:runId' }],
                async handle(request) {
                    const path = new URL(request.url).pathname;
                    try {
                        if (request.method === 'GET' && path === '/api/recipes') return Response.json({ recipes: await service.list(), capabilities: config.capabilities });
                        const read = () => readJsonInput(request, 40000);
                        if (request.method === 'POST' && path === '/api/recipes') return Response.json({ recipe: await service.create(await read()) });
                        const receipt = /^\/api\/recipes\/launches\/([^/]+)$/.exec(path);
                        if (receipt && request.method === 'GET') return Response.json({ receipt: await service.receipt(receipt[1]!) });
                        const target = /^\/api\/recipes\/([^/]+)(\/run)?$/.exec(path);
                        if (target && request.method === 'GET' && !target[2]) return Response.json({ recipe: await service.get(target[1]!) });
                        if (target?.[2] && request.method === 'POST') return Response.json(await service.launch(target[1]!, await read()));
                        return Response.json({ error: '当前插件未提供此接口' }, { status: 404 });
                    } catch (error) { return Response.json({ error: error instanceof z.ZodError ? '配方参数格式不正确' : error instanceof Error ? error.message : '配方操作失败' }, { status: (error as { status?: number }).status || 400 }); }
                },
            },
        });
    },
};
export default runRecipesPlugin;
