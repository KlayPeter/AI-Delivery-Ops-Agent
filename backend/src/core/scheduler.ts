import { loadConfig } from './config';
import { DataRetentionService } from './dataRetention';
import { MessageHandler } from '@/services/messageHandler';
import { ScheduledJobs } from '@/services/jobs';
import { DashboardService } from '@/services/dashboard';
import { GroupMemberSyncService } from '@/services/groupMembers';
import { StandupService } from '@/services/standupService';
import { utcNowIso } from '@/models/types';
import dayjs from 'dayjs';
import { isScheduleDateEnabled } from './scheduleCalendar';
import type { ScheduledAgentDispatcher } from '@/platform/bootstrap/scheduledAgentDispatcher';
import { isRecurringTimeDue, zonedClock } from './scheduleTime';

const JOB_TO_CONFIG_KEY: Record<string, string> = {
    "standup-push": "standup_push",
    "task-standup-template": "task_standup_template",
    "standup-second-remind": "standup_second_remind",
    "standup-summary": "standup_summary",
    "standup-supplement-summary": "standup_summary",
    "overdue-scan": "overdue_scan",
    "daily-summary": "daily_summary",
    "dashboard": "dashboard",
    "weekly-report": "weekly_report",
    "ai-hot": "ai_hot",
};

export class InProcessScheduler {
    private getHandler: () => MessageHandler;
    private intervalSeconds: number;
    private timer?: ReturnType<typeof setInterval>;
    private tickInFlight?: Promise<Record<string, string>>;
    private lastMemberSyncAt = 0;
    private memberSyncIntervalMs: number;
    private agentJobs?: ScheduledAgentDispatcher;
    private jobRetryDelayMs: number;

    constructor(getHandler: () => MessageHandler, intervalSeconds: number = 30, memberSyncIntervalSeconds: number = 3600, agentJobs?: ScheduledAgentDispatcher, jobRetryDelayMs: number = 1000) {
        this.getHandler = getHandler;
        this.intervalSeconds = intervalSeconds;
        this.memberSyncIntervalMs = memberSyncIntervalSeconds * 1000;
        this.agentJobs = agentJobs;
        this.jobRetryDelayMs = Math.max(0, jobRetryDelayMs);
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.tick(new Date()).catch(() => {
                try {
                    (this.getHandler() as any).ctx.store.appendAuditLog("scheduler_error", { at: utcNowIso() });
                } catch (e) {}
            });
        }, this.intervalSeconds * 1000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    async tick(now: Date): Promise<Record<string, string>> {
        if (this.tickInFlight) return this.tickInFlight;
        const run = this.runTick(now);
        this.tickInFlight = run;
        try {
            return await run;
        } finally {
            if (this.tickInFlight === run) this.tickInFlight = undefined;
        }
    }

    private async runTick(now: Date): Promise<Record<string, string>> {
        const handler = this.getHandler();
        const ctx = (handler as any).ctx;
        await this.syncMembersIfDue(ctx, now);
        ctx.config = loadConfig(await ctx.store.getDynamicConfig());
        await this.runMaintenanceIfDue(ctx, now);
        if (this.agentJobs) await this.agentJobs.flushDeliveries();
        const results: Record<string, string> = {};
        const jobs = this.createScheduledJobs(handler);
        for (const group of ctx.config.groups) {
            const groupId = group.chat_id;
            if (!groupId) continue;

            try {
                const taskStandup = isScheduleDateEnabled(dayjs(now).format('YYYY-MM-DD'), group.schedule, true)
                    ? await jobs.taskStandupRemindDue(groupId, now)
                    : { sent: 0, failed: 0 };
                if (taskStandup.sent || taskStandup.failed) {
                    results[`task-standup-remind:${groupId}`] = taskStandup.failed ? "completed_with_warnings" : "completed";
                }
            } catch (error: any) {
                results[`task-standup-remind:${groupId}`] = "failed";
                await ctx.store.appendAuditLog("standup_commitment_reminder_failed", {
                    group_id: groupId,
                    error: error?.message || String(error),
                });
            }

            for (const [jobName, configKey] of Object.entries(JOB_TO_CONFIG_KEY)) {
                const configuredTime = (group.schedule as any)[configKey];
                const supplementSchedule = jobName === "standup-supplement-summary"
                    ? standupSupplementSchedule(configuredTime)
                    : null;
                const scheduledTime = supplementSchedule?.time || configuredTime;
                if (!this.isJobDue(jobName, scheduledTime, now, group.schedule)) continue;

                const jobEnabled = jobName === "task-standup-template"
                    ? group.schedule?.task_standup_enabled === true
                    : (group.schedule as any)[`${configKey}_enabled`] !== false;
                if (!jobEnabled) continue;

                if ((configKey.startsWith('standup_') || jobName === "task-standup-template") && group.schedule?.module_standup_enabled === false) continue;
                if (configKey === 'daily_summary' && group.schedule?.module_daily_summary_enabled === false) continue;
                if (configKey === 'dashboard' && group.schedule?.module_dashboard_enabled === false) continue;
                if (configKey === 'weekly_report' && group.schedule?.module_weekly_report_enabled === false) continue;
                if (configKey === 'weekly_report' && !StandupService.isGroupEnabled(group)) continue;
                if (configKey === 'ai_hot' && group.schedule?.module_ai_hot_enabled === false) continue;
                const overdueClock = jobName === "overdue-scan"
                    ? zonedClock(now, group.schedule.overdue_scan_timezone)
                    : null;
                const weeklyClock = jobName === "weekly-report"
                    ? zonedClock(now, group.schedule.weekly_report_timezone)
                    : null;
                const jobDay = supplementSchedule?.previousDay ? dayjs(now).subtract(1, 'day').toDate() : now;
                const workdaysOnly = group.schedule.workdays_only ?? ctx.config.schedule.workdays_only;
                const calendarDay = overdueClock?.date || weeklyClock?.date || dayjs(jobDay).format('YYYY-MM-DD');
                if (!isScheduleDateEnabled(calendarDay, { ...group.schedule, workdays_only: workdaysOnly }, jobName === "weekly-report")) continue;

                const dateIso = overdueClock?.date || weeklyClock?.date || dayjs(jobDay).format('YYYY-MM-DD');
                const executionTime = overdueClock?.time || weeklyClock?.time || scheduledTime;
                const key = `scheduled:${jobName}:${groupId}:${dateIso}:${executionTime}`;
                const usesAgentRuntime = ['daily-summary', 'weekly-report', 'dashboard', 'ai-hot'].includes(jobName) && !!this.agentJobs;
                if (!usesAgentRuntime) {
                    const claimed = await ctx.store.claimIdempotencyKey(key, {
                        status: "running", started_at: utcNowIso(), job_name: jobName, group_id: groupId,
                    });
                    if (!claimed) continue;
                }

                try {
                    const { payload, attempts } = await this.runJobWithRetry(handler, jobName, groupId, jobDay, jobs);
                    if (payload?.status === "duplicate") {
                        await ctx.store.appendAuditLog("job_duplicate_skipped", {
                            job_name: jobName,
                            group_id: groupId,
                            trigger: "scheduler",
                            attempts,
                            run_id: payload.run_id,
                        });
                        results[`${jobName}:${groupId}`] = "duplicate";
                        continue;
                    }
                    const completionStatus = payload?.status === "completed_with_warnings" ? "completed_with_warnings" : "completed";
                    if (!usesAgentRuntime) await ctx.store.setIdempotencyKey(key, { status: completionStatus, completed_at: utcNowIso(), job_name: jobName, group_id: groupId, result: payload });
                    await ctx.store.appendAuditLog(completionStatus === "completed" ? "job_completed" : "job_completed_with_warnings", { job_name: jobName, group_id: groupId, trigger: "scheduler", attempts, result: payload });
                    results[`${jobName}:${groupId}`] = completionStatus;
                } catch (exc: any) {
                    if (!usesAgentRuntime) await ctx.store.setIdempotencyKey(key, { status: "failed", failed_at: utcNowIso(), job_name: jobName, group_id: groupId, error: exc.message || String(exc) });
                    await ctx.store.appendAuditLog("job_failed", { job_name: jobName, group_id: groupId, trigger: "scheduler", attempts: exc.attempts || 2, first_error: exc.firstError, error: exc.message || String(exc) });
                    results[`${jobName}:${groupId}`] = "failed";
                }
            }
        }
        return results;
    }

    private async runMaintenanceIfDue(ctx: any, now: Date): Promise<void> {
        const config = ctx.config?.maintenance;
        if (!config?.enabled) return;
        if (typeof ctx.store.deleteAuditLogsBefore !== 'function') return;
        const clock = zonedClock(now, config.cleanup_timezone);
        if (!clock || clock.time !== config.cleanup_time) return;
        const key = `maintenance:cleanup:${clock.date}`;
        const claimed = await ctx.store.claimIdempotencyKey(key, {
            status: 'running',
            started_at: now.toISOString(),
        });
        if (!claimed) return;

        try {
            const result = await new DataRetentionService(ctx.store, config).run(now);
            await ctx.store.setIdempotencyKey(key, {
                status: 'completed',
                completed_at: new Date().toISOString(),
                result,
            });
            await ctx.store.appendAuditLog('maintenance_cleanup_completed', result);
        } catch (error: any) {
            const message = error?.message || String(error);
            await Promise.resolve(ctx.store.setIdempotencyKey(key, {
                status: 'failed',
                failed_at: new Date().toISOString(),
                error: message,
            })).catch(() => {});
            await Promise.resolve(ctx.store.appendAuditLog('maintenance_cleanup_failed', {
                at: now.toISOString(),
                error: message,
            })).catch(() => {});
        }
    }

    private async syncMembersIfDue(ctx: any, now: Date): Promise<void> {
        if (this.memberSyncIntervalMs <= 0) return;
        const nowMs = now.getTime();
        if (nowMs - this.lastMemberSyncAt < this.memberSyncIntervalMs) return;
        this.lastMemberSyncAt = nowMs;

        try {
            const syncer = new GroupMemberSyncService(ctx.store, ctx.feishu);
            const result = await syncer.syncAll("scheduler");
            if (result.changed) {
                ctx.config = loadConfig(await ctx.store.getDynamicConfig());
            }
        } catch (error: any) {
            await ctx.store.appendAuditLog("group_members_sync_failed", {
                trigger: "scheduler",
                at: utcNowIso(),
                error: error?.message || String(error),
            });
        }
    }

    private async runJobWithRetry(handler: MessageHandler, jobName: string, groupId: string, day: Date, jobs?: ScheduledJobs): Promise<{ payload: any; attempts: number }> {
        const ctx = (handler as any).ctx;
        try {
            return { payload: await this.runJob(handler, jobName, groupId, day, 0, jobs), attempts: 1 };
        } catch (firstError: any) {
            const firstMessage = firstError?.message || String(firstError);
            if (firstError?.retryable === false) {
                const finalError: any = firstError instanceof Error ? firstError : new Error(firstMessage);
                finalError.attempts = 1;
                finalError.firstError = firstMessage;
                throw finalError;
            }
            await Promise.resolve(ctx.store.appendAuditLog("job_retrying", {
                job_name: jobName,
                group_id: groupId,
                trigger: "scheduler",
                attempt: 2,
                max_attempts: 2,
                error: firstMessage,
            })).catch(() => {});
            const retryDelayMs = Number.isFinite(firstError?.retryAfterMs)
                ? Math.max(0, firstError.retryAfterMs)
                : this.jobRetryDelayMs;
            if (retryDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
            try {
                const payload = await this.runJob(handler, jobName, groupId, day, 1, jobs);
                await Promise.resolve(ctx.store.appendAuditLog("job_retry_succeeded", {
                    job_name: jobName,
                    group_id: groupId,
                    trigger: "scheduler",
                    attempts: 2,
                    first_error: firstMessage,
                })).catch(() => {});
                return { payload, attempts: 2 };
            } catch (retryError: any) {
                const finalError: any = retryError instanceof Error ? retryError : new Error(String(retryError));
                finalError.attempts = 2;
                finalError.firstError = firstMessage;
                throw finalError;
            }
        }
    }

    private createScheduledJobs(handler: MessageHandler): ScheduledJobs {
        const ctx = (handler as any).ctx;
        const llm = ctx.intentParser?.llm;
        const dashboard = new DashboardService(
            ctx.store,
            ctx.config.data_path,
            ctx.config.project.name,
            ctx.config.runtime.public_base_url
        );
        return new ScheduledJobs(ctx.config, ctx.store, ctx.feishu, dashboard, ctx.tapd, llm);
    }

    private async runJob(handler: MessageHandler, jobName: string, groupId: string, day: Date, retryAttempt: number = 0, jobs?: ScheduledJobs) {
        const scheduledJobs = jobs || this.createScheduledJobs(handler);

        switch (jobName) {
            case "standup-push": return await scheduledJobs.standupPush(groupId, day);
            case "task-standup-template": return await scheduledJobs.taskStandupTemplate(groupId, day);
            case "standup-second-remind": return await scheduledJobs.standupSecondRemind(groupId, day);
            case "standup-summary": return await scheduledJobs.standupSummary(groupId, day);
            case "standup-supplement-summary": return await scheduledJobs.standupSupplementSummary(groupId, day);
            case "overdue-scan": return await scheduledJobs.overdueScan(groupId, day);
            case "daily-summary": return this.agentJobs ? await this.agentJobs.dailySummary(groupId, day, retryAttempt) : await scheduledJobs.dailySummary(groupId, day);
            case "weekly-report": if (!this.agentJobs) throw new Error("Weekly Report Agent dispatcher is not configured"); return await this.agentJobs.weeklyReport(groupId, day, retryAttempt);
            case "dashboard": return this.agentJobs ? await this.agentJobs.dashboard(groupId, day, retryAttempt) : await scheduledJobs.dashboardGenerate(groupId, day);
            case "ai-hot": if (!this.agentJobs) throw new Error('AI Hot Agent dispatcher is not configured'); return await this.agentJobs.aiHot(groupId, day, retryAttempt);
            default: throw new Error(`Unknown job: ${jobName}`);
        }
    }

    private isDue(scheduledTime: any, now: Date): boolean {
        if (typeof scheduledTime !== 'string') return false;
        try {
            const [hourText, minuteText] = scheduledTime.split(":", 2);
            return parseInt(hourText, 10) === now.getHours() && parseInt(minuteText, 10) === now.getMinutes();
        } catch {
            return false;
        }
    }

    private isJobDue(jobName: string, scheduledTime: any, now: Date, schedule: Record<string, any>): boolean {
        if (jobName === "weekly-report") {
            const clock = zonedClock(now, schedule.weekly_report_timezone);
            return Boolean(clock && calendarDate(clock.date).getDay() === 5 && clock.time === scheduledTime);
        }
        if (jobName !== "overdue-scan") return this.isDue(scheduledTime, now);
        return isRecurringTimeDue(
            now,
            scheduledTime,
            schedule.overdue_scan_end,
            schedule.overdue_scan_interval_minutes,
            schedule.overdue_scan_timezone,
        );
    }
}

function calendarDate(dateText: string): Date {
    const [year, month, day] = dateText.split("-").map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function standupSupplementSchedule(value: any): { time: string; previousDay: boolean } | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    const nextHour = hour + 1;
    return {
        time: `${String(nextHour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        previousDay: nextHour >= 24,
    };
}
