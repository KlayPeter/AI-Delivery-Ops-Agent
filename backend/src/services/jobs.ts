import { AppConfig } from '@/core/config';
import { PrismaStore } from '@/core/storage';
import { FeishuAdapter, isPermanentFeishuSendFailure } from '@/adapters/feishu';
import { LLMAdapter } from '@/adapters/llm';
import { DashboardService } from './dashboard';
import { buildDailySummary, renderDailySummary } from './summaries';
import { StandupService } from './standupService';
import { TaskService } from './taskService';
import { Task, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';
import { ProjectDashboardService } from './projectDashboard';
import { DashboardImageService } from './dashboardImage';
import type { ArtifactInput } from '@/platform/agents/contracts';
import { dueReminderSlot, DueReminderScenario, overduePolicy } from '@/domains/task/overduePolicy';
import { zonedClock } from '@/core/scheduleTime';
import { taskReminderGroupId } from '@/services/taskScope';
import { WeeklyReportService } from '@/domains/weeklyReport/service';
import type { WeeklyPeriodKind } from '@/domains/weeklyReport/types';
import { randomUUID } from 'node:crypto';

export interface GeneratedDailySummary {
    summaryIds: string[];
    artifacts: ArtifactInput[];
}

export interface GeneratedDashboard {
    result: Record<string, unknown>;
    artifacts: ArtifactInput[];
    subscribers: any[];
}

export interface GeneratedWeeklyReport {
    result: Record<string, unknown>;
    artifacts: ArtifactInput[];
}

type ReminderDeliveryOutcome = "sent" | "duplicate" | "skipped" | "failed" | "rejected";

interface OverdueDeliverySummary {
    sent: number;
    duplicate: number;
    skipped: number;
    failed: number;
    rejected: number;
}

export class ScheduledJobs {
    config: AppConfig;
    store: PrismaStore;
    feishu: FeishuAdapter;
    private dashboard: DashboardService;
    private projectDashboard: ProjectDashboardService;
    private llm?: LLMAdapter;
    private tapd: any;
    private projectTaskSync?: ReturnType<typeof TaskService.syncProjectScope>;

    constructor(config: AppConfig, store: PrismaStore, feishu: FeishuAdapter, dashboard: DashboardService, tapd: any, llm?: LLMAdapter) {
        this.config = config;
        this.store = store;
        this.feishu = feishu;
        this.dashboard = dashboard;
        this.tapd = tapd;
        this.llm = llm;
        this.projectDashboard = new ProjectDashboardService({ config, store, tapd, dashboard, renderer: new DashboardImageService() });
    }

    async standupPush(groupId: string, day: Date = new Date()): Promise<{ sent: number, failed: number }> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        let count = 0;
        const failures: any[] = [];

        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            for (const member of group.members) {
                if (!member.is_active) continue;

                const prompt = `【${group.name || group.chat_id}】每日站会（${dateText}）\n\n${member.name}，请回复以下内容：\n\n【昨日完成】\n1.\n\n【今日计划】\n1.\n\n【阻塞/需要帮助】\n无\n\n【风险/可能延期】\n无\n\n【需要决策】\n无`;
                const delivery = await this.sendStandupPromptWithRetry(member.open_id, prompt);
                const result = delivery.result;
                if (!result.ok) {
                    failures.push({
                        open_id: member.open_id,
                        name: member.name,
                        attempts: delivery.attempts,
                        first_error: delivery.firstError,
                        error: result.error || result.raw,
                    });
                    continue;
                }

                if (delivery.attempts > 1) {
                    await this.store.appendAuditLog("standup_push_retry_succeeded", {
                        group_id: group.chat_id,
                        date: dateText,
                        open_id: member.open_id,
                        name: member.name,
                        first_error: delivery.firstError,
                    });
                }

                if (result.chat_id) await this.store.updateChatId(member.open_id, result.chat_id);
                if (result.message_id) {
                    await this.store.saveBotMessageContext({
                        message_id: result.message_id,
                        context_type: "standup_prompt",
                        created_at: utcNowIso(),
                        chat_id: result.chat_id || "",
                        chat_type: "p2p",
                        target_open_id: member.open_id,
                        metadata: { date: dateText, group_id: group.chat_id }
                    });
                }
                count++;
            }
        }
        if (failures.length) {
            await this.store.appendAuditLog("standup_push_failed", { group_id: groupId, date: dateText, sent: count, failed: failures.length, failures });
            throw new Error(`站会模板发送失败 ${failures.length} 人，已发送 ${count} 人`);
        }
        return { sent: count, failed: 0 };
    }

    private async sendStandupPromptWithRetry(openId: string, prompt: string): Promise<{ result: any, attempts: number, firstError?: any }> {
        const send = async () => {
            try {
                return await this.feishu.sendPrivateText(openId, prompt);
            } catch (error: any) {
                return { ok: false, error: error?.message || String(error) };
            }
        };

        const first = await send();
        if (first.ok) return { result: first, attempts: 1 };

        const retry = await send();
        return {
            result: retry,
            attempts: 2,
            firstError: first.error || ("raw" in first ? first.raw : undefined),
        };
    }

    async standupRemind(groupId: string, day: Date = new Date()): Promise<any> {
        return this._standupRemind(groupId, day, "first");
    }

    async standupSecondRemind(groupId: string, day: Date = new Date()): Promise<any> {
        return this._standupRemind(groupId, day, "second");
    }

    private async _standupRemind(groupId: string, day: Date = new Date(), stage: string = "first"): Promise<any> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const missing = await this.missingStandupMembers(groupId, day);
        let count = 0;

        const group = this.config.groups.find(g => g.chat_id === groupId);
        const groupName = group ? group.name : groupId;
        const stageText = stage === "second" ? `你在【${groupName}】的（${dateText}）站会仍未提交，如有阻塞也可以直接简要回复，我会帮你记录。` : `你在【${groupName}】的（${dateText}）站会还未提交，请方便时补充一下。`;

        for (const member of missing) {
            const sendRes = await this.feishu.sendPrivateText(member.open_id, `${member.name}，${stageText}`);
            if (!sendRes.ok) {
                await this.store.appendAuditLog("standup_reminder_failed", { group_id: groupId, date: dateText, stage, open_id: member.open_id, name: member.name, error: sendRes.error || sendRes.raw });
                continue;
            }
            if (sendRes && sendRes.message_id) {
                await this.store.saveBotMessageContext({
                    message_id: sendRes.message_id,
                    context_type: "standup_prompt",
                    created_at: utcNowIso(),
                    chat_id: sendRes.chat_id || "",
                    chat_type: "p2p",
                    target_open_id: member.open_id,
                    metadata: { date: dateText, group_id: groupId, stage }
                });
            }
            count++;
        }

        await this.store.appendAuditLog("standup_reminder_sent", {
            date: dateText,
            stage,
            reminded: count,
            missing_open_ids: missing.map(m => m.open_id),
            missing_names: missing.map(m => m.name),
        });
        return { reminded: count, stage };
    }
    async standupSummary(groupId: string, day: Date = new Date()): Promise<any> {
        const { buildStandupSummaryWithLLM, buildFallbackStandupSummary } = require('./standupLLM');
        const dateText = dayjs(day).format('YYYY-MM-DD');
        let totalSubmitted = 0;
        let totalMissing = 0;

        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            const standups = await this.listStandupsForGroup(dateText, group);
            const submitted = new Set(standups.map((s: any) => s.open_id));
            const missingMembers = group.members.filter(m => m.is_active && !submitted.has(m.open_id));
            const missingNames = missingMembers.map(m => m.name);
            const missingMentions = missingMembers.map(m => `<at user_id="${m.open_id}">${m.name}</at>`);

            const title = `【站会汇总｜${dateText}】`;

            if (standups.length === 0) {
                let missingText = "**👻 七、未提交情况**\n";
                if (missingMembers.length === 0) {
                    missingText += "本次站会已经全部提交👏";
                } else {
                    missingText += `- 未提交人数：${missingMembers.length}`;
                    if (group.schedule?.public_missing_standups) {
                        missingText += `\n${missingMentions.join(' ')}`;
                    }
                }
                await this.feishu.sendGroupMarkdown(`暂无站会提交。\n\n${missingText}`, group.chat_id, title);
                totalMissing += missingMembers.length;
                continue;
            }

            let missingText = "";
            if (missingMembers.length === 0) {
                missingText = "本次站会已经全部提交👏";
            } else {
                missingText = `- 未提交人数：${missingMembers.length}`;
                if (group.schedule?.public_missing_standups) {
                    missingText += `\n${missingMentions.join(' ')}`;
                }
            }

            let sentAi = false;
            if (this.llm) {
                const res = await buildStandupSummaryWithLLM(this.llm, standups, dateText, missingText);
                if (res.ok && res.text) {
                    await this.feishu.sendGroupMarkdown(res.text, group.chat_id, title);
                    totalSubmitted += standups.length;
                    totalMissing += missingMembers.length;
                    sentAi = true;
                    await this.store.appendAuditLog("ai_standup_summary_generated", {
                        date: dateText,
                        group_id: group.chat_id,
                        summary: res.text,
                        submitted: standups.length,
                        missing: missingMembers.length,
                    });
                } else {
                    await this.store.appendAuditLog("ai_standup_summary_failed", {
                        date: dateText,
                        reason: res.error || "empty_response",
                        submitted: standups.length,
                    });
                }
            }

            if (!sentAi) {
                const fallbackText = buildFallbackStandupSummary(standups, dateText, missingText);
                await this.feishu.sendGroupMarkdown(fallbackText, group.chat_id, title);
                totalSubmitted += standups.length;
                totalMissing += missingMembers.length;
            }
        }
        return { submitted: totalSubmitted, missing: totalMissing };
    }

    async standupSupplementSummary(groupId: string, day: Date = new Date()): Promise<{ supplemented: number }> {
        const { buildStandupSummaryWithLLM, buildFallbackStandupSummary } = require('./standupLLM');
        const dateText = dayjs(day).format('YYYY-MM-DD');
        let supplemented = 0;

        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            const summaryAt = this.standupSummaryTime(group, day);
            if (!summaryAt) continue;

            const standups = await StandupService.listLateGroupSubmissions(this.config, this.store, dateText, group, summaryAt.toDate());
            if (!standups.length) {
                await this.store.appendAuditLog("standup_supplement_summary_skipped", {
                    date: dateText,
                    group_id: group.chat_id,
                    reason: "no_late_submissions",
                    summary_at: summaryAt.toISOString(),
                });
                continue;
            }

            const title = `【站会补充｜${dateText}】`;
            const note = `本次仅汇总主站会汇总（${summaryAt.format('HH:mm')}）后补交的 ${standups.length} 人，不重复展示已在主汇总中出现的内容。`;
            let text = "";
            if (this.llm) {
                const res = await buildStandupSummaryWithLLM(this.llm, standups, dateText, note);
                if (res.ok && res.text) text = res.text;
                else await this.store.appendAuditLog("ai_standup_supplement_summary_failed", { date: dateText, group_id: group.chat_id, reason: res.error || "empty_response", submitted: standups.length });
            }
            if (!text) text = buildFallbackStandupSummary(standups, dateText, note);

            const sent = await this.feishu.sendGroupMarkdown(`**本次为站会补充**\n${note}\n\n${text}`, group.chat_id, title);
            if (!sent.ok) throw new Error(`站会补充发送失败：${sent.error || 'unknown Feishu error'}`);

            supplemented += standups.length;
            await this.store.appendAuditLog("standup_supplement_summary_generated", {
                date: dateText,
                group_id: group.chat_id,
                summary_at: summaryAt.toISOString(),
                submitted: standups.length,
            });
        }
        return { supplemented };
    }

    async dailySummary(groupId: string, day: Date = new Date()): Promise<any> {
        const generated = await this.generateDailySummary(groupId, day);
        for (const artifact of generated.artifacts) {
            const sent = await this.feishu.sendGroupMarkdown(
                String(artifact.content || ''),
                String(artifact.metadata?.targetId || groupId),
                typeof artifact.metadata?.title === 'string' ? artifact.metadata.title : undefined,
            );
            if (!sent.ok) throw new Error(`日报投递失败：${sent.error || 'unknown Feishu error'}`);
        }
        return { summary_ids: generated.summaryIds.join(',') };
    }

    async generateDailySummary(groupId: string, day: Date = new Date()): Promise<GeneratedDailySummary> {
        const sync = await TaskService.syncProjectScope({ config: this.config, tapd: this.tapd, store: this.store });
        if (!sync.ok) {
            await this.store.appendAuditLog("daily_summary_task_sync_failed", { group_id: groupId, error: sync.error });
            throw new Error(`日报生成前 TAPD 全量校验失败：${sync.error}`);
        }
        const summaryIds: string[] = [];
        const artifacts: ArtifactInput[] = [];
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            const period = group.daily_summary_period || "00:00-23:59";
            await this.backfillGroupMessagesForSummary(group.chat_id, day, period);
            const summary = await buildDailySummary(this.store, group.chat_id, day, this.llm, period);
            await this.store.saveDailySummary(summary);
            const text = renderDailySummary(summary);
            const title = `【${group.name || "研发群聊"}总结 | ${dayjs(day).format('YYYY-MM-DD')}】`;
            summaryIds.push(summary.id);
            artifacts.push({
                type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: text,
                metadata: { title, targetId: group.chat_id, summaryId: summary.id },
            });
        }
        return { summaryIds, artifacts };
    }

    async generateWeeklyReport(groupId: string, input: {
        period: WeeklyPeriodKind;
        cutoffAt?: string;
        triggerType: "manual" | "schedule" | "agent";
        sourceMessageId?: string;
    }): Promise<GeneratedWeeklyReport> {
        const report = await new WeeklyReportService(this.config, this.store, this.tapd, this.llm).generate({
            group_id: groupId,
            period: input.period,
            cutoff_at: input.cutoffAt,
            trigger_type: input.triggerType,
            source_message_id: input.sourceMessageId,
        });
        return {
            result: {
                reportId: report.id,
                publicUrl: report.public_url || "",
                version: report.version,
            },
            artifacts: [{
                type: "markdown",
                mediaType: "text/markdown",
                schemaVersion: "1.0",
                content: WeeklyReportService.deliveryMarkdown(report),
                metadata: {
                    title: `【${report.facts?.group?.name || "项目"}周报】`,
                    targetId: groupId,
                    reportId: report.id,
                },
            }],
        };
    }

    async dashboardGenerate(groupId: string, day: Date = new Date()): Promise<any> {
        const generated = await this.generateDashboard(groupId, day);
        const image = generated.artifacts.find(artifact => artifact.type === 'image');
        const markdown = generated.artifacts.find(artifact => artifact.type === 'markdown');
        const uploaded = image?.storageRef
            ? await this.feishu.uploadImage(image.storageRef)
            : { ok: false, error: "dashboard image was not generated" } as any;
        if (!uploaded.ok) await this.store.appendAuditLog("dashboard_image_upload_failed", { artifact_id: generated.result.artifact_id, error: uploaded.error || uploaded.raw });
        for (const group of generated.subscribers) {
            if (uploaded.ok && uploaded.image_key) {
                const imageSent = await this.feishu.sendGroupImageKey(uploaded.image_key, group.chat_id);
                if (imageSent?.ok === false) await this.store.appendAuditLog("dashboard_image_delivery_failed", { artifact_id: generated.result.artifact_id, group_id: group.chat_id, error: imageSent.error || imageSent.raw });
            }
            const sent = await this.feishu.sendGroupMarkdown(String(markdown?.content || ''), group.chat_id);
            if (sent?.ok === false) await this.store.appendAuditLog("dashboard_delivery_failed", { artifact_id: generated.result.artifact_id, group_id: group.chat_id, error: sent.error || sent.raw || "unknown Feishu error" });
        }
        return generated.result;
    }

    async generateDashboard(groupId: string, day: Date = new Date()): Promise<GeneratedDashboard> {
        const result = await this.projectDashboard.generateFresh(day, "scheduled", groupId);
        const targetGroup = result.subscribers[0];
        const dashboardBaseUrl =
          result.artifact.public_url ||
          this.config.runtime?.public_base_url ||
          "http://localhost:8080/";
        const dashboardQuery = new URLSearchParams({ groupId, dashboardId: result.artifact.id }).toString();
        const dashboardUrl = `${dashboardBaseUrl}${dashboardBaseUrl.includes("?") ? "&" : "?"}${dashboardQuery}`;
        const text = `**【${targetGroup?.name || "群聊"}进度看板 | ${dayjs(day).format('YYYY-MM-DD')}】**\n\nTAPD 已完成全量校验；仅统计创建人或开发人员属于本群成员的有效任务。\n\n🔗 [点击查看完整 Dashboard](${dashboardUrl})`;
        const output = {
            artifact_id: result.artifact.id,
            public_url: result.artifact.public_url || null,
            subscriber_count: result.subscribers.length,
            sync: result.sync,
        };
        const artifacts: ArtifactInput[] = [];
        if (result.artifact.image_path) artifacts.push({
            type: 'image', mediaType: 'image/png', schemaVersion: '1.0', storageRef: result.artifact.image_path,
            metadata: { dashboardId: result.artifact.id, targetId: groupId },
        });
        artifacts.push({
            type: 'markdown', mediaType: 'text/markdown', schemaVersion: '1.0', content: text,
            metadata: { dashboardId: result.artifact.id, targetId: groupId },
        });
        return { result: output, artifacts, subscribers: result.subscribers };
    }

    async overdueScan(groupId: string, day: Date = new Date()): Promise<any> {
        const counts = { due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_day3: 0, overdue_day5: 0 };
        const delivery: OverdueDeliverySummary = { sent: 0, duplicate: 0, skipped: 0, failed: 0, rejected: 0 };
        const result = () => ({
            ...counts,
            delivery,
            status: delivery.skipped || delivery.failed || delivery.rejected ? "completed_with_warnings" : "completed",
        });

        const group = this.config.groups.find(item => item.chat_id === groupId);
        const schedule = { ...this.config.schedule, ...(group?.schedule || {}) };
        const reminderSchedule = {
            startTime: schedule.overdue_scan,
            endTime: schedule.overdue_scan_end,
            timeZone: schedule.overdue_scan_timezone,
        };
        const businessClock = zonedClock(day, reminderSchedule.timeZone);
        if (!businessClock) return result();
        const now = dayjs(businessClock.date);
        let tasks = await this.store.listTasks();

        if (typeof this.tapd?.listStories === "function") {
            this.projectTaskSync ||= TaskService.syncProjectScope({ config: this.config, tapd: this.tapd, store: this.store });
            const sync = await this.projectTaskSync;
            if (!sync.ok) {
                await this.store.appendAuditLog("overdue_scan_task_sync_failed", { group_id: groupId, error: sync.error });
                throw new Error(`超期扫描前 TAPD 全量校验失败：${sync.error}`);
            }
        } else {
            const excludedStatuses = ["deleted", "cancelled", "status_20"];
            for (const task of tasks) {
                if (task.source_group_id === groupId && task.tapd_story_id && !excludedStatuses.includes(task.status)) {
                    await TaskService.syncFromTapd({ tapd: this.tapd, store: this.store }, task);
                }
            }
        }
        // Refetch after sync
        tasks = await this.store.listTasks();
        const hierarchy = TaskService.projectHierarchy(tasks);

        const uniqueTasks = [];
        const seenTaskSignatures = new Set<string>();

        for (const rawTask of tasks) {
            const due = rawTask.due_date;
            if (!due || !hierarchy.isActionableLeaf(rawTask)) continue;

            if (taskReminderGroupId(rawTask, this.config.groups) !== groupId) continue;

            // 对抗式审查：按标题、负责任、截止时间生成签名，去重相同任务，防止因重试或网络延迟导致的重复创建刷屏
            const sig = `${groupId}-${rawTask.title}-${due}-${rawTask.primary_owner_open_id}`;
            if (seenTaskSignatures.has(sig)) continue;
            seenTaskSignatures.add(sig);

            uniqueTasks.push(rawTask);
        }

        for (const rawTask of uniqueTasks) {
            const due = rawTask.due_date;
            const dueDate = dayjs(due);
            if (!dueDate.isValid()) continue;

            const daysToDue = dueDate.startOf('day').diff(now.startOf('day'), 'day');
            const groupName = group?.name || "未知群聊";
            const link = rawTask.tapd_url ? `\n🔗 详情：${rawTask.tapd_url}` : "";
            const prefix = `你在【${groupName}】的`;

            if (daysToDue === 1) {
                const scenario: DueReminderScenario = "due_tomorrow";
                const slot = dueReminderSlot(scenario, day, reminderSchedule);
                if (slot) {
                    const outcome = await this.sendDueReminderOnce(rawTask, day, scenario, slot, `${prefix}任务明天截止，请确认当前进展和风险。\n任务：${rawTask.title}${link}\n截止时间：${due}`);
                    delivery[outcome]++;
                    if (outcome === "sent") counts.due_tomorrow++;
                }
            } else if (daysToDue === 0) {
                const scenario: DueReminderScenario = "due_today";
                const slot = dueReminderSlot(scenario, day, reminderSchedule);
                if (slot) {
                    const outcome = await this.sendDueReminderOnce(rawTask, day, scenario, slot, `${prefix}任务已于 ${due} 截止，请同步当前进展。\n任务：${rawTask.title}${link}\n截止时间：${due}`);
                    delivery[outcome]++;
                    if (outcome === "sent") counts.due_today++;
                }
            } else if (daysToDue < 0) {
                const policy = overduePolicy(due, businessClock.date);
                if (!policy) continue;
                await TaskService.markOverdue(this.store, rawTask, policy.tier);
                const text = `${prefix}任务已超期 ${policy.daysOverdue} 天，请尽快更新进展或调整计划。\n任务：${rawTask.title}${link}\n原截止时间：${due}`;
                const slot = dueReminderSlot(policy.tier, day, reminderSchedule);
                if (slot) {
                    const outcome = await this.sendDueReminderOnce(rawTask, day, policy.tier, slot, text);
                    delivery[outcome]++;
                    if (outcome === "sent") counts[policy.tier]++;
                }
            }
        }
        return result();
    }

    private async sendDueReminderOnce(task: any, day: Date, scenario: DueReminderScenario, slot: string, text: string): Promise<ReminderDeliveryOutcome> {
        if (task.tapd_story_id) {
            if (TaskService.isDirectlyCompleted(task) || ["cancelled", "deleted"].includes(task.status)) {
                return "duplicate";
            }
        }

        const reminders = { ...(task.overdue_reminders || {}) };
        if (reminders[`${scenario}_slot`] === slot) return "duplicate";

        const owner = String(task.primary_owner_open_id || "").trim();
        if (!owner) {
            const unresolvedSlotKey = `${scenario}_unresolved_owner_slot`;
            if (reminders[unresolvedSlotKey] === slot) return "duplicate";

            reminders[unresolvedSlotKey] = slot;
            task.overdue_reminders = reminders;
            await this.store.saveTask(task as Task);
            await this.store.appendAuditLog("overdue_reminder_skipped_missing_owner", {
                task_id: task.id,
                scenario,
                slot,
                due_date: task.due_date,
                owner_name: task.primary_owner_name || "",
                assignee_names: task.assignee_names || [],
                reason: "primary_owner_open_id_missing",
            });
            return "skipped";
        }

        const rejectedSlotKey = `${scenario}_rejected_slot`;
        const rejectedOwnerKey = `${scenario}_rejected_owner`;
        if (reminders[rejectedSlotKey] === slot && reminders[rejectedOwnerKey] === owner) return "duplicate";

        const claim = await this.claimReminderDelivery(task.id, scenario, slot, owner);
        if (claim === null) return "duplicate";

        let sendRes;
        try {
            sendRes = await this.feishu.sendPrivateText(owner, text);
        } catch (error) {
            await this.finishReminderDeliveryClaim(claim, "retryable", { error: error instanceof Error ? error.message : String(error) });
            throw error;
        }

        if (!sendRes.ok) {
            const permanent = isPermanentFeishuSendFailure(sendRes);
            if (permanent) {
                reminders[rejectedSlotKey] = slot;
                reminders[rejectedOwnerKey] = owner;
                task.overdue_reminders = reminders;
                await this.store.saveTask(task as Task);
            }
            await this.finishReminderDeliveryClaim(claim, permanent ? "rejected" : "retryable", {
                error: sendRes.error || sendRes.raw || "unknown Feishu error",
            });
            await this.store.appendAuditLog(permanent ? "overdue_reminder_rejected" : "overdue_reminder_failed", {
                task_id: task.id,
                scenario,
                slot,
                due_date: task.due_date,
                owner_open_id: owner,
                error: sendRes.error || sendRes.raw || "unknown Feishu error",
                retryable: !permanent,
            });
            return permanent ? "rejected" : "failed";
        }

        await this.finishReminderDeliveryClaim(claim, "completed", { message_id: sendRes.message_id });

        if (sendRes.message_id) {
            await this.store.saveBotMessageContext({
                message_id: sendRes.message_id,
                context_type: "task_thread",
                target_open_id: owner,
                task_id: task.id,
                task_title: task.title,
                created_at: utcNowIso()
            });
        }

        reminders[scenario] = dayjs(day).toISOString();
        reminders[`${scenario}_slot`] = slot;
        task.overdue_reminders = reminders;
        await this.store.saveTask(task as Task);
        await this.store.appendAuditLog("overdue_reminder_sent", { task_id: task.id, scenario, slot, due_date: task.due_date });
        return "sent";
    }

    private async claimReminderDelivery(taskId: string, scenario: DueReminderScenario, slot: string, owner: string): Promise<{ key: string; value: any } | undefined | null> {
        const store = this.store as any;
        if (typeof store.claimIdempotencyKey !== "function" || typeof store.getIdempotencyValue !== "function" || typeof store.compareAndSetIdempotencyKey !== "function") {
            return undefined;
        }

        const key = `overdue-reminder:${taskId}:${scenario}:${slot}:${owner}`;
        const claimedAt = utcNowIso();
        const value = {
            status: "sending",
            owner_open_id: owner,
            claimed_at: claimedAt,
            lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
            claim_id: randomUUID(),
        };
        if (await store.claimIdempotencyKey(key, value)) return { key, value };

        const existing = await store.getIdempotencyValue(key);
        const leaseExpired = existing?.status === "sending" && Date.parse(existing.lease_until || "") <= Date.now();
        if (existing?.status !== "retryable" && !leaseExpired) return null;
        return await store.compareAndSetIdempotencyKey(key, existing, value) ? { key, value } : null;
    }

    private async finishReminderDeliveryClaim(claim: { key: string; value: any } | undefined, status: string, detail: Record<string, any>): Promise<void> {
        if (!claim) return;
        const store = this.store as any;
        const next = { ...claim.value, ...detail, status, finished_at: utcNowIso() };
        if (typeof store.compareAndSetIdempotencyKey === "function") {
            await store.compareAndSetIdempotencyKey(claim.key, claim.value, next);
        } else if (typeof store.setIdempotencyKey === "function") {
            await store.setIdempotencyKey(claim.key, next);
        }
    }

    private async missingStandupMembers(groupId: string, day: Date): Promise<any[]> {
        return StandupService.missingMembers(this.config, this.store, groupId, day);
    }

    private async listStandupsForGroup(dateText: string, group: any): Promise<any[]> {
        return StandupService.listGroupSubmissions(this.config, this.store, dateText, group);
    }

    private standupSummaryTime(group: any, day: Date): dayjs.Dayjs | null {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(group.schedule?.standup_summary || ""));
        if (!match) return null;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour > 23 || minute > 59) return null;
        return dayjs(day).hour(hour).minute(minute).second(0).millisecond(0);
    }

    async backfillGroupMessagesForSummary(chatId: string, day: Date, period: string): Promise<void> {
        if (!this.config.runtime.daily_summary_fetch_history || !chatId) return;

        const { startTime, endTime } = this.summaryPeriodRange(day, period);
        let history: any[];

        try {
            history = await this.feishu.fetchChatHistory(chatId, startTime, endTime);
        } catch (exc: any) {
            const reason = String(exc.message || exc);
            await this.store.appendAuditLog("daily_summary_history_sync_failed", {
                date: dayjs(day).format('YYYY-MM-DD'),
                chat_id: chatId,
                reason,
            });
            throw new Error(`日报群聊历史消息同步失败：${reason}`);
        }

        let synced = 0;
        let inserted = 0;

        for (const message of history) {
            const existed = !!(await this.store.getSourceMessage(message.id));
            await this.store.saveSourceMessage(message);
            synced++;
            if (!existed) inserted++;
        }

        await this.store.appendAuditLog("daily_summary_history_synced", {
            date: dayjs(day).format('YYYY-MM-DD'),
            chat_id: chatId,
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString(),
            synced,
            inserted,
        });
    }

    private summaryPeriodRange(day: Date, period: string): { startTime: Date, endTime: Date } {
        const parts = period.includes("-") ? period.split("-") : ["00:00", "23:59"];
        const [hStart, mStart] = parts[0].split(":").map(Number);
        const [hEnd, mEnd] = parts[1].split(":").map(Number);

        const now = dayjs(day);
        let startDay = now;
        if (hStart > hEnd || (hStart === hEnd && mStart >= mEnd)) {
            startDay = now.subtract(1, 'day');
        }

        const startTime = new Date(startDay.year(), startDay.month(), startDay.date(), hStart, mStart, 0);
        const endTime = new Date(now.year(), now.month(), now.date(), hEnd, mEnd, 59, 999);
        return { startTime, endTime };
    }
}
