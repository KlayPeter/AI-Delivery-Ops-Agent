import { Elysia } from 'elysia';
import { z } from 'zod';
import path from 'node:path';
import { isWeeklyReportPathAllowed } from './renderer';
import { readWorkspaceArtifact } from '@/platform/workspace/artifactFiles';
import type { HandlerContext } from '@/services/messageHandler/types';

const querySchema = z.object({ groupId: z.string().max(256).optional() }).strict();
export function createWeeklyReportApi(getContext: () => HandlerContext) {
    return new Elysia({ prefix: '/api/weekly-reports', name: 'weekly-report-history' })
        .onError(({ error, code, set }) => {
            set.status = code === 'NOT_FOUND' ? 404 : error instanceof z.ZodError ? 400 : 500;
            return { error: set.status === 404 ? '未找到周报' : set.status === 400 ? '周报查询参数无效' : '周报读取失败' };
        })
        .get('', async ({ query }) => {
            const { groupId } = querySchema.parse(query);
            const reports = await getContext().store.listWeeklyReports(groupId || undefined);
            return { reports: reports.filter(report => report.status === 'succeeded').map(report => ({
                id: report.id, group_id: report.group_id, group_name: report.facts?.group?.name || report.group_id,
                period_start: report.period_start, period_end: report.period_end, cutoff_at: report.cutoff_at,
                version: report.version, generated_at: report.generated_at, trigger_type: report.trigger_type,
            })) };
        })
        .get('/:id', async ({ params: { id }, set }) => {
            const ctx = getContext(), report = await ctx.store.getWeeklyReport(id);
            const html = report?.status === 'succeeded' && isWeeklyReportPathAllowed(ctx.config.data_path, report.html_path)
                ? await readWorkspaceArtifact(path.join(ctx.config.data_path, 'weekly-reports'), report.html_path, '.html') : null;
            if (html === null) { set.status = 404; return { error: 'not_found' }; }
            set.headers['Content-Type'] = 'text/html; charset=utf-8';
            set.headers['Cache-Control'] = 'private, max-age=60';
            return html;
        });
}
