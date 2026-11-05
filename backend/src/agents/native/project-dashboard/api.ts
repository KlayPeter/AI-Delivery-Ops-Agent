import { Elysia } from 'elysia';
import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { TaskService } from '@/services/taskService';
import type { HandlerContext } from '@/services/messageHandler/types';
import { readWorkspaceArtifact } from '@/platform/workspace/artifactFiles';

const htmlName = (name: string) => name.length <= 255 && !/[\\/\p{Cc}]/u.test(name) && name.endsWith('.html');
const querySchema = z.object({
    from: z.iso.date().optional(), to: z.iso.date().optional(),
    includeImplemented: z.enum(['true', 'false']).optional(), sync: z.enum(['true', 'false']).optional(),
}).strict().refine(input => !input.from || !input.to || input.from <= input.to);
const personSchema = z.object({
    employee_open_id: z.string().trim().min(1).max(256),
    role: z.enum(['product_requirement', 'development', 'testing', 'product_acceptance', 'creator']),
});
const planSchema = personSchema.extend({ start: z.string().max(13), end: z.string().max(13) }).strict();

export function createDashboardApi(getContext: () => HandlerContext) {
    return new Elysia({ prefix: '/api/dashboards', name: 'project-dashboard-files' })
        .onError(({ set, code }) => {
            set.status = code === 'NOT_FOUND' ? 404 : 500;
            return { error: set.status === 404 ? '未找到看板' : '看板读取失败' };
        })
        .get('', async () => {
            const dir = path.join(getContext().config.data_path, 'dashboards');
            try {
                const files = await readdir(dir, { withFileTypes: true });
                return { dashboards: files.filter(file => file.isFile() && htmlName(file.name)).map(file => file.name).sort().reverse() };
            } catch (error: any) {
                if (error.code === 'ENOENT') return { dashboards: [] };
                throw error;
            }
        })
        .get('/:filename', async ({ params: { filename }, set }) => {
            if (!htmlName(filename)) { set.status = 404; return { error: 'not_found' }; }
            const root = path.join(getContext().config.data_path, 'dashboards');
            const content = await readWorkspaceArtifact(root, path.join(root, filename), '.html');
            if (content === null) { set.status = 404; return { error: 'not_found' }; }
            set.headers['Content-Type'] = 'text/html; charset=utf-8';
            return content;
        });
}

export function createHumanGanttApi(getContext: () => HandlerContext) {
    return new Elysia({ prefix: '/api/human-gantt', name: 'human-gantt' })
        .onError(({ error, code, set }) => {
            const message = error instanceof Error ? error.message : '';
            const invalid = error instanceof z.ZodError || code === 'PARSE' || /不存在|不是任务参与人|无效|必须/.test(message);
            set.status = code === 'NOT_FOUND' ? 404 : invalid ? 400 : 500;
            return { error: set.status === 404 ? '未找到甘特图接口' : invalid ? error instanceof z.ZodError || code === 'PARSE' ? '甘特图参数无效' : message : '人力甘特图操作失败' };
        })
        .get('', async ({ query }) => {
            const input = querySchema.parse(query), ctx = getContext();
            const sync = input.sync === 'false' ? null : await TaskService.syncProjectScope(ctx);
            const data = await TaskService.humanGantt(ctx.store, ctx.config, { from: input.from, to: input.to, includeImplemented: input.includeImplemented === 'true' });
            return { ...data, sync };
        })
        .post('/tasks/:taskId/plan', async ({ params: { taskId }, body }) => ({ ok: true, plan: await TaskService.updateGanttPlan(getContext().store, taskId, planSchema.parse(body)) }))
        .delete('/tasks/:taskId/plan', async ({ params: { taskId }, body }) => ({ ok: true, plan: await TaskService.deleteGanttPlan(getContext().store, taskId, personSchema.strict().parse(body)) }));
}
