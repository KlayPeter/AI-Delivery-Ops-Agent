import { Elysia } from 'elysia';
import dayjs from 'dayjs';
import { isWorkday } from 'chinese-days';
import type { AgentHost } from '@/platform/bootstrap/agentHost';
import type { HandlerContext } from '@/services/messageHandler/types';
import { executeManualJob, MANUAL_JOB_NAMES, parseManualJobDay, UnsupportedJobPreviewError, type ManualJobRunner } from '@/services/jobExecution';
import { isLocalWorkspaceRequest } from './connections';

export function createManualJobsApi(host: AgentHost, getContext: () => Pick<HandlerContext, 'config' | 'store'>, createJobs: (sendToGroup: boolean) => ManualJobRunner) {
    return new Elysia({ name: 'plugin-manual-jobs' })
        .onBeforeHandle(({ request, set }) => {
            if (!isLocalWorkspaceRequest(request)) { set.status = 403; return { error: '手动任务仅接受本机页面请求' }; }
        })
        .post('/api/jobs/:jobName', async ({ params: { jobName }, body, set }) => {
            if (!MANUAL_JOB_NAMES.has(jobName)) { set.status = 400; return { error: '无效的任务名称' }; }
            try {
                return await host.executePluginJob(jobName, async () => {
                    const { config, store } = getContext(), payload: any = body || {};
                    const groupId = payload.groupId || '', group = config.groups.find(group => group.chat_id === groupId);
                    if (!groupId || !group) { set.status = 400; return { error: '无效的群聊 ID' }; }
                    const dryRun = payload.dryRun === true, sendToGroup = payload.sendToGroup === true;
                    let day: Date;
                    try { day = parseManualJobDay(payload.day ?? payload.date); }
                    catch (error: any) { set.status = 400; return { error: error.message || String(error) }; }
                    if (group.schedule.workdays_only && !isWorkday(day)) {
                        store.appendAuditLog('job_skipped_holiday', { job_name: jobName, date: dayjs(day).format('YYYY-MM-DD') }).catch(console.error);
                        return { ok: true, skipped: true, reason: 'holiday_or_weekend' };
                    }
                    try {
                        const result = await executeManualJob(createJobs(sendToGroup), jobName, groupId, day, dryRun);
                        store.appendAuditLog(dryRun ? 'job_preview_completed' : 'job_completed', {
                            job_name: jobName, trigger: 'manual', date: dayjs(day).format('YYYY-MM-DD'), send_to_group: sendToGroup, result,
                        }).catch(console.error);
                        return { ok: true, dryRun, sendToGroup, result };
                    } catch (error: any) {
                        set.status = error instanceof UnsupportedJobPreviewError ? 400 : 500;
                        return { error: `任务 ${jobName} 执行失败`, stderr: error.message || String(error) };
                    }
                });
            } catch (error: any) {
                set.status = error.code === 'PLUGIN_JOB_DISABLED' ? 404 : 503;
                return { error: error.code === 'PLUGIN_JOB_DISABLED' ? '当前插件未启用此手动任务' : 'Agent Host 暂不可用' };
            }
        });
}
