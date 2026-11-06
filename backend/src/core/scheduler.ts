import { loadConfig } from './config';
import { MessageHandler } from '@/services/messageHandler';
import { utcNowIso } from '@/models/types';
import type { ScheduledAgentDispatcher } from '@/platform/bootstrap/scheduledAgentDispatcher';
import type { GroupSchedule, GroupScheduleContext } from '@/platform/scheduling/registry';

export class InProcessScheduler {
    private getHandler: () => MessageHandler;
    private intervalSeconds: number;
    private stopped = false;
    private timer?: ReturnType<typeof setInterval>;
    private tickInFlight?: Promise<Record<string, string>>;
    private readonly lastGlobalPollAt = new Map<string, number>();
    private globalPollIntervalMs: number;
    private agentJobs?: ScheduledAgentDispatcher;
    private jobRetryDelayMs: number;

    constructor(getHandler: () => MessageHandler, intervalSeconds: number = 30, globalPollIntervalSeconds: number = 3600, agentJobs?: ScheduledAgentDispatcher, jobRetryDelayMs: number = 1000) {
        this.getHandler = getHandler;
        this.intervalSeconds = intervalSeconds;
        this.globalPollIntervalMs = globalPollIntervalSeconds * 1000;
        this.agentJobs = agentJobs;
        this.jobRetryDelayMs = Math.max(0, jobRetryDelayMs);
    }

    start() {
        if (this.stopped) throw new Error('Scheduler is stopped; create a new instance');
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.tick(new Date()).catch(() => {
                try {
                    (this.getHandler() as any).ctx.store.appendAuditLog("scheduler_error", { at: utcNowIso() });
                } catch (e) {}
            });
        }, this.intervalSeconds * 1000);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.tickInFlight?.catch(() => {});
    }

    async tick(now: Date): Promise<Record<string, string>> {
        if (this.stopped) throw new Error('Scheduler is stopped');
        if (this.tickInFlight) return this.tickInFlight;
        const registry = (this.getHandler() as any).ctx.schedules;
        const run = registry ? registry.run(() => this.runTick(now)) : this.runTick(now);
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
        ctx.config = loadConfig(await ctx.store.getDynamicConfig());
        const results: Record<string, string> = {};
        const resources = new Map<unknown, unknown>();
        const entries: GroupSchedule[] = ctx.schedules?.list() || [];
        const globalEntries = [...entries.filter(entry => entry.kind === 'global-poll'), ...entries.filter(entry => entry.kind === 'global-tick')];
        for (const entry of globalEntries) {
            if (entry.kind === 'global-poll') {
                if (this.globalPollIntervalMs <= 0 || now.getTime() - (this.lastGlobalPollAt.get(entry.id) || 0) < this.globalPollIntervalMs) continue;
                this.lastGlobalPollAt.set(entry.id, now.getTime());
            }
            try { Object.assign(results, await entry.run({ ctx, now, resources, agents: this.agentJobs })); }
            catch (error: any) {
                results[entry.id] = 'failed';
                await ctx.store.appendAuditLog('scheduler_poll_failed', { job_name: entry.id, error: error?.message || String(error) });
            }
        }
        if (this.agentJobs) await this.agentJobs.flushDeliveries();
        for (const group of ctx.config.groups) {
            const groupId = group.chat_id;
            if (!groupId) continue;
            const context: GroupScheduleContext = { ctx, group, now, resources, agents: this.agentJobs };
            for (const entry of entries) {
                if (entry.kind === 'global-poll' || entry.kind === 'global-tick') continue;
                const jobName = entry.id;
                if (entry.kind === 'poll') {
                    try { Object.assign(results, await entry.run(context)); }
                    catch (error: any) {
                        results[`${jobName}:${groupId}`] = 'failed';
                        await ctx.store.appendAuditLog('scheduler_poll_failed', { job_name: jobName, group_id: groupId, error: error?.message || String(error) });
                    }
                    continue;
                }
                let plan;
                try {
                    plan = entry.plan(context);
                    if (!plan) continue;
                    if (!(plan.day instanceof Date) || !Number.isFinite(plan.day.getTime())
                        || !/^\d{4}-\d{2}-\d{2}$/.test(plan.date) || !/^\d{1,2}:\d{2}$/.test(plan.time)) {
                        throw new Error(`Invalid schedule plan: ${jobName}`);
                    }
                } catch (error: any) {
                    results[`${jobName}:${groupId}`] = 'failed';
                    await ctx.store.appendAuditLog('job_plan_failed', { job_name: jobName, group_id: groupId, error: error?.message || String(error) });
                    continue;
                }
                const key = `scheduled:${jobName}:${groupId}:${plan.date}:${plan.time}`;
                const usesAgentRuntime = entry.agent === true && !!this.agentJobs;
                if (!usesAgentRuntime) {
                    const claimed = await ctx.store.claimIdempotencyKey(key, {
                        status: "running", started_at: utcNowIso(), job_name: jobName, group_id: groupId,
                    });
                    if (!claimed) continue;
                }

                try {
                    const { payload, attempts } = await this.runJobWithRetry(handler, jobName, groupId, plan.day, context);
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

    private async runJobWithRetry(handler: MessageHandler, jobName: string, groupId: string, day: Date, context: GroupScheduleContext): Promise<{ payload: any; attempts: number }> {
        const ctx = (handler as any).ctx;
        try {
            return { payload: await this.runJob(handler, jobName, groupId, day, 0, context), attempts: 1 };
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
                const payload = await this.runJob(handler, jobName, groupId, day, 1, context);
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

    private async runJob(handler: MessageHandler, jobName: string, _groupId: string, day: Date, retryAttempt: number, context: GroupScheduleContext) {
        const entry = (handler as any).ctx.schedules?.get(jobName);
        if (!entry || entry.kind !== 'timed') throw Object.assign(new Error(`Scheduled plugin job is unavailable: ${jobName}`), { retryable: false });
        return entry.run({ ...context, day, retryAttempt });
    }
}
