import { Elysia } from 'elysia';
import { z } from 'zod';
import dayjs from 'dayjs';
import { parseManualJobDay } from '@/services/jobExecution';
import { StandupService } from '@/services/standupService';
import type { HandlerContext } from '@/services/messageHandler/types';

const querySchema = z.object({ date: z.string().optional().transform((value, context) => {
    try { return dayjs(parseManualJobDay(value)).format('YYYY-MM-DD'); }
    catch { context.addIssue({ code: 'custom', message: '日期无效' }); return z.NEVER; }
}), groupId: z.string().max(256).optional(), type: z.enum(['normal', 'task']).optional() }).strict();
export function createStandupApi(getContext: () => HandlerContext) {
    return new Elysia({ prefix: '/api/standups', name: 'standup-statistics' })
        .onError(({ error, code, set }) => {
            set.status = code === 'NOT_FOUND' ? 404 : error instanceof z.ZodError ? 400 : 500;
            return { error: set.status === 404 ? '未找到站会接口' : set.status === 400 ? '站会查询参数无效' : '站会查询失败' };
        })
        .get('', async ({ query, set }) => {
            const input = querySchema.parse(query), ctx = getContext();
            if (input.groupId && !ctx.config.groups.some(group => group.chat_id === input.groupId)) { set.status = 404; return { error: '未找到已配置的群组' }; }
            return StandupService.statistics(ctx.config, ctx.store, input.date, input.groupId, input.type);
        })
        .get('/summary', async ({ query, set }) => {
            const input = querySchema.parse(query), ctx = getContext();
            if (!input.groupId) { set.status = 400; return { error: 'groupId is required' }; }
            if (!ctx.config.groups.some(group => group.chat_id === input.groupId)) { set.status = 404; return { error: '未找到已配置的群组' }; }
            return { summary: await StandupService.latestSummary(ctx.store, input.date, input.groupId) };
        });
}
