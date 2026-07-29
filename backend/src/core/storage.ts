import { PrismaClient } from '@prisma/client';
import { serializeAuditPayload } from './auditPayload';
import { BotMessageContext, DailySummary, DashboardArtifact, MeetingSummaryRecord, SourceMessage, Standup, Task, TaskUpdate, WeeklyReport } from '@/models/types';

const DYNAMIC_RUNTIME_KEYS = [
    "public_base_url",
    "public_missing_standups",
    "public_overdue_owners",
    "daily_summary_period",
    "daily_summary_fetch_history",
    "daily_summary_fetch_page_size",
];



function parseJsonObject(value?: string | null): Record<string, any> {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function pickDynamicRuntime(runtime: any): Record<string, any> {
    return pickKeys(runtime, DYNAMIC_RUNTIME_KEYS);
}

function pickKeys(source: any, keys: string[]): Record<string, any> {
    const result: Record<string, any> = {};
    if (!source || typeof source !== "object") return result;
    for (const key of keys) {
        if (source[key] !== undefined) result[key] = source[key];
    }
    return result;
}

function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: string }).code === "P2002";
}

export function normalizeDynamicConfigMembers(group: any): Array<{ open_id: string; name: string; role: string | null; job_title: string | null; is_active: boolean }> {
    if (!Array.isArray(group.members)) return [];

    return group.members
        .filter((member: any) => member && (member.open_id || member.name || member.role || member.job_title))
        .map((member: any, index: number) => {
            const openId = String(member.open_id || "").trim();
            if (!openId) {
                const label = String(member.name || member.role || member.job_title || `第 ${index + 1} 个成员`);
                throw new Error(`群组 ${group.name || group.chat_id} 的成员「${label}」缺少 open_id，无法保存`);
            }

            return {
                open_id: openId,
                name: String(member.name || openId).trim(),
                role: member.role ? String(member.role) : null,
                job_title: member.job_title ? String(member.job_title) : null,
                is_active: member.is_active !== false,
            };
        });
}

export class PrismaStore {
    public prisma: PrismaClient;

    constructor(dataDir?: string) {
        if (dataDir) {
            process.env.DATABASE_URL = `file:${dataDir}/data.db`;
        } else if (!process.env.DATABASE_URL) {
            process.env.DATABASE_URL = `file:../../data/data.db`;
        }
        this.prisma = new PrismaClient();
    }

    async getDynamicConfig(): Promise<any> {
        const settings = await this.prisma.systemSetting.findMany({
            where: { key: { in: ["runtime", "schedule"] } }
        });
        const settingMap = new Map(settings.map((s: any) => [s.key, parseJsonObject(s.value_json)]));
        const groups = await this.prisma.projectGroup.findMany({
            include: { members: true },
            orderBy: { name: "asc" }
        });

        return {

            runtime: settingMap.get("runtime") || {},
            schedule: settingMap.get("schedule") || {},
            groups: groups.filter((g: any) => g.enabled).map((group: any) => ({
                chat_id: group.chat_id,
                name: group.name,
                daily_summary_period: group.daily_summary_period,
                schedule: parseJsonObject(group.schedule_json),
                members: group.members.map((member: any) => ({
                    open_id: member.open_id,
                    name: member.name,
                    role: member.role || undefined,
                    job_title: member.job_title || undefined,
                    is_active: member.is_active,
                })),
            })),
        };
    }

    async saveDynamicConfig(payload: any): Promise<void> {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("Config payload must be an object");
        }

        const runtime = pickDynamicRuntime(payload.runtime);
        const schedule = payload.schedule && typeof payload.schedule === "object" && !Array.isArray(payload.schedule)
            ? payload.schedule
            : {};
        const groups = Array.isArray(payload.groups) ? payload.groups.filter((g: any) => g && g.chat_id) : [];
        const updatedAt = new Date().toISOString();

        await this.prisma.$transaction(async (tx: any) => {

            await tx.systemSetting.upsert({
                where: { key: "runtime" },
                update: { value_json: JSON.stringify(runtime), updated_at: updatedAt },
                create: { key: "runtime", value_json: JSON.stringify(runtime), updated_at: updatedAt }
            });
            await tx.systemSetting.upsert({
                where: { key: "schedule" },
                update: { value_json: JSON.stringify(schedule), updated_at: updatedAt },
                create: { key: "schedule", value_json: JSON.stringify(schedule), updated_at: updatedAt }
            });

            await tx.groupMember.deleteMany({});
            await tx.projectGroup.deleteMany({});

            for (const group of groups) {
                const members = normalizeDynamicConfigMembers(group);
                await tx.projectGroup.create({
                    data: {
                        chat_id: String(group.chat_id),
                        name: String(group.name || group.chat_id),
                        daily_summary_period: String(group.daily_summary_period || runtime.daily_summary_period || "00:00-23:59"),
                        schedule_json: JSON.stringify(group.schedule && typeof group.schedule === "object" ? group.schedule : {}),
                        enabled: group.enabled !== false,
                        members: {
                            create: members
                        }
                    }
                });
            }
        });
    }

    async hasIdempotencyKey(key: string): Promise<boolean> {
        const record = await this.prisma.idempotency.findUnique({ where: { key } });
        return !!record;
    }

    async claimIdempotencyKey(key: string, value: any): Promise<boolean> {
        try {
            await this.prisma.idempotency.create({
                data: { key, value: JSON.stringify(value) }
            });
            return true;
        } catch (error) {
            if (isUniqueConstraintError(error)) return false;
            throw error;
        }
    }

    async setIdempotencyKey(key: string, value: any): Promise<void> {
        await this.prisma.idempotency.upsert({
            where: { key },
            update: { value: JSON.stringify(value) },
            create: { key, value: JSON.stringify(value) }
        });
    }

    async getIdempotencyValue<T = unknown>(key: string): Promise<T | null> {
        const record = await this.prisma.idempotency.findUnique({ where: { key } });
        return record ? JSON.parse(record.value) as T : null;
    }

    async listIdempotencyEntries<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>> {
        const records = await this.prisma.idempotency.findMany({
            where: { key: { startsWith: prefix } },
            orderBy: { key: 'asc' },
        });
        return records.map((record: any) => ({ key: record.key, value: JSON.parse(record.value) as T }));
    }

    async compareAndSetIdempotencyKey(key: string, expected: unknown, next: unknown): Promise<boolean> {
        const result = await this.prisma.idempotency.updateMany({
            where: { key, value: JSON.stringify(expected) },
            data: { value: JSON.stringify(next) },
        });
        return result.count === 1;
    }

    async saveSourceMessage(message: SourceMessage): Promise<void> {
        const data = {
            id: message.id,
            chat_id: message.chat_id,
            chat_type: message.chat_type,
            sender_open_id: message.sender_open_id,
            sender_name: message.sender_name,
            text: message.text,
            message_type: message.message_type,
            sent_at: message.sent_at,
            raw_payload: message.raw_payload ? JSON.stringify(message.raw_payload) : null,
            mentions: message.mentions ? JSON.stringify(message.mentions) : null,
            ai_result: message.ai_result ? JSON.stringify(message.ai_result) : null,
            confidence: message.confidence,
            parent_id: message.parent_id,
            root_id: message.root_id,
            file_key: message.file_key,
            image_key: message.image_key
        };
        await this.prisma.sourceMessage.upsert({
            where: { id: message.id },
            update: data,
            create: data
        });
    }

    async getSourceMessage(messageId?: string | null): Promise<any> {
        if (!messageId) return null;
        const record = await this.prisma.sourceMessage.findUnique({ where: { id: messageId } });
        if (!record) return null;
        return this._parseSourceMessage(record);
    }

    async listSourceMessages(): Promise<any[]> {
        const records = await this.prisma.sourceMessage.findMany();
        return records.map((r: any) => this._parseSourceMessage(r));
    }

    private _parseSourceMessage(record: any): any {
        return {
            ...record,
            raw_payload: record.raw_payload ? JSON.parse(record.raw_payload) : null,
            mentions: record.mentions ? JSON.parse(record.mentions) : undefined,
            ai_result: record.ai_result ? JSON.parse(record.ai_result) : undefined
        };
    }

    async saveTask(task: Task): Promise<void> {
        const data = {
            id: task.id,
            title: task.title,
            creator_open_id: task.creator_open_id,
            creator_name: task.creator_name,
            primary_owner_open_id: task.primary_owner_open_id,
            primary_owner_name: task.primary_owner_name,
            assignee_open_ids: JSON.stringify(task.assignee_open_ids),
            assignee_names: JSON.stringify(task.assignee_names),
            status: task.status,
            priority: task.priority,
            source_message_id: task.source_message_id,
            source_group_id: task.source_group_id,
            created_at: task.created_at,
            updated_at: task.updated_at,
            source_sender_open_id: task.source_sender_open_id,
            source_sender_name: task.source_sender_name,
            source_sent_at: task.source_sent_at,
            raw_text: task.raw_text,
            ai_result: task.ai_result ? JSON.stringify(task.ai_result) : null,
            confidence: task.confidence,
            trace: task.trace ? JSON.stringify(task.trace) : null,
            description: task.description,
            due_date: task.due_date,
            acceptance_criteria: task.acceptance_criteria ? JSON.stringify(task.acceptance_criteria) : null,
            dependencies: task.dependencies ? JSON.stringify(task.dependencies) : null,
            related_links: task.related_links ? JSON.stringify(task.related_links) : null,
            tags: task.tags ? JSON.stringify(task.tags) : null,
            task_plan: task.task_plan ? JSON.stringify(task.task_plan) : null,
            blocked_at: task.blocked_at,
            blocker_info: task.blocker_info ? JSON.stringify(task.blocker_info) : null,
            overdue_reminders: task.overdue_reminders ? JSON.stringify(task.overdue_reminders) : null,
            tapd_story_id: task.tapd_story_id,
            tapd_url: task.tapd_url,
            parent_id: task.parent_id,
            is_draft: task.is_draft || false
        };
        await this.prisma.task.upsert({
            where: { id: task.id },
            update: data,
            create: data
        });
    }

    async getTask(taskId: string): Promise<any> {
        const record = await this.prisma.task.findUnique({ where: { id: taskId } });
        return record ? this._parseTask(record) : null;
    }

    async findTask(identifier: string): Promise<any> {
        const cleaned = identifier.trim();
        const record = await this.prisma.task.findFirst({
            where: {
                OR: [
                    { id: cleaned },
                    { tapd_story_id: cleaned }
                ]
            }
        });
        return record ? this._parseTask(record) : null;
    }

    async listTasks(includeDeleted: boolean = false): Promise<any[]> {
        const where = includeDeleted ? {} : { status: { not: "deleted" } };
        const records = await this.prisma.task.findMany({ where });
        return records.map((r: any) => this._parseTask(r));
    }

    private _parseTask(record: any): any {
        return {
            ...record,
            assignee_open_ids: JSON.parse(record.assignee_open_ids),
            assignee_names: JSON.parse(record.assignee_names),
            ai_result: record.ai_result ? JSON.parse(record.ai_result) : undefined,
            trace: record.trace ? JSON.parse(record.trace) : undefined,
            acceptance_criteria: record.acceptance_criteria ? JSON.parse(record.acceptance_criteria) : undefined,
            dependencies: record.dependencies ? JSON.parse(record.dependencies) : undefined,
            related_links: record.related_links ? JSON.parse(record.related_links) : undefined,
            tags: record.tags ? JSON.parse(record.tags) : undefined,
            task_plan: record.task_plan ? JSON.parse(record.task_plan) : undefined,
            blocker_info: record.blocker_info ? JSON.parse(record.blocker_info) : undefined,
            overdue_reminders: record.overdue_reminders ? JSON.parse(record.overdue_reminders) : undefined
        };
    }

    async saveTaskUpdate(update: TaskUpdate): Promise<void> {
        const data = {
            id: update.id,
            task_id: update.task_id,
            user_open_id: update.user_open_id,
            user_name: update.user_name,
            update_type: update.update_type,
            content: update.content,
            source: update.source,
            source_message_id: update.source_message_id,
            created_at: update.created_at,
            source_group_id: update.source_group_id,
            source_sender_open_id: update.source_sender_open_id,
            source_sender_name: update.source_sender_name,
            source_sent_at: update.source_sent_at,
            raw_text: update.raw_text,
            ai_result: update.ai_result ? JSON.stringify(update.ai_result) : null,
            confidence: update.confidence,
            trace: update.trace ? JSON.stringify(update.trace) : null,
            metadata: update.metadata ? JSON.stringify(update.metadata) : null
        };
        await this.prisma.taskUpdate.upsert({
            where: { id: update.id },
            update: data,
            create: data
        });
    }

    async listTaskUpdates(taskId?: string | null): Promise<any[]> {
        const where = taskId ? { task_id: taskId } : {};
        const records = await this.prisma.taskUpdate.findMany({ where });
        return records.map((r: any) => this._parseTaskUpdate(r));
    }

    async deleteStandupTaskUpdates(standupId: string): Promise<void> {
        const ids = (await this.listTaskUpdates())
            .filter((update: any) => update.source === "standup" && update.metadata?.standup_id === standupId)
            .map((update: any) => update.id);
        if (ids.length) await this.prisma.taskUpdate.deleteMany({ where: { id: { in: ids } } });
    }

    private _parseTaskUpdate(record: any): any {
        return {
            ...record,
            ai_result: record.ai_result ? JSON.parse(record.ai_result) : undefined,
            trace: record.trace ? JSON.parse(record.trace) : undefined,
            metadata: record.metadata ? JSON.parse(record.metadata) : undefined
        };
    }

    async saveStandup(standup: Standup): Promise<void> {
        const data = {
            id: standup.id,
            open_id: standup.open_id,
            user_name: standup.user_name,
            date: standup.date,
            yesterday_done: JSON.stringify(standup.yesterday_done),
            today_plan: JSON.stringify(standup.today_plan),
            blockers: JSON.stringify(standup.blockers),
            risks: JSON.stringify(standup.risks),
            decisions_needed: JSON.stringify(standup.decisions_needed),
            submitted_at: standup.submitted_at,
            source_message_id: standup.source_message_id,
            source_group_id: standup.source_group_id,
            source_sender_open_id: standup.source_sender_open_id,
            source_sender_name: standup.source_sender_name,
            source_sent_at: standup.source_sent_at,
            raw_text: standup.raw_text,
            ai_result: standup.ai_result ? JSON.stringify(standup.ai_result) : null,
            confidence: standup.confidence,
            trace: standup.trace ? JSON.stringify(standup.trace) : null
        };
        await this.prisma.standup.upsert({
            where: { id: standup.id },
            update: data,
            create: data
        });
    }

    async listStandups(date: string, groupId?: string | null): Promise<any[]> {
        const where: any = { date };
        if (groupId) {
            where.source_group_id = groupId;
        }
        const records = await this.prisma.standup.findMany({ where });
        const parsed = records.map((r: any) => this._parseStandup(r));

        const map = new Map<string, any>();
        for (const s of parsed) {
            const existing = map.get(s.open_id);
            if (!existing || (s.submitted_at || "") > (existing.submitted_at || "")) {
                map.set(s.open_id, s);
            }
        }
        return Array.from(map.values()).sort((a: any, b: any) => (a.user_name || "").localeCompare(b.user_name || ""));
    }

    private _parseStandup(record: any): any {
        return {
            ...record,
            yesterday_done: JSON.parse(record.yesterday_done),
            today_plan: JSON.parse(record.today_plan),
            blockers: JSON.parse(record.blockers),
            risks: JSON.parse(record.risks),
            decisions_needed: JSON.parse(record.decisions_needed),
            ai_result: record.ai_result ? JSON.parse(record.ai_result) : undefined,
            trace: record.trace ? JSON.parse(record.trace) : undefined
        };
    }
    async saveDailySummary(summary: DailySummary): Promise<void> {
        const data = {
            id: summary.id,
            group_id: summary.group_id,
            date: summary.date,
            highlights: JSON.stringify(summary.highlights || []),
            tasks: JSON.stringify(summary.tasks || []),
            progress_updates: JSON.stringify(summary.progress_updates || []),
            blockers: JSON.stringify(summary.blockers || []),
            decisions: JSON.stringify(summary.decisions || []),
            risks: JSON.stringify(summary.risks || []),
            helps: JSON.stringify(summary.helps || []),
            shares: JSON.stringify(summary.shares || []),
            meetings: JSON.stringify(summary.meetings || []),
            created_at: summary.created_at,
            ai_abstract: summary.ai_abstract
        };
        await this.prisma.dailySummary.upsert({
            where: { id: summary.id },
            update: data,
            create: data
        });
    }

    async saveDashboardArtifact(artifact: DashboardArtifact): Promise<void> {
        const data = {
            id: artifact.id,
            date: artifact.date,
            html_path: artifact.html_path,
            stats_path: artifact.stats_path,
            created_at: artifact.created_at,
            public_url: artifact.public_url
        };
        await this.prisma.dashboardArtifact.upsert({
            where: { id: artifact.id },
            update: data,
            create: data
        });
    }

    async listDashboardArtifacts(date?: string): Promise<DashboardArtifact[]> {
        return this.prisma.dashboardArtifact.findMany({
            where: date ? { date } : {},
            orderBy: { created_at: 'desc' },
        });
    }

    async saveWeeklyReport(report: WeeklyReport): Promise<void> {
        const data = {
            id: report.id,
            group_id: report.group_id,
            period_start: report.period_start,
            period_end: report.period_end,
            cutoff_at: report.cutoff_at,
            version: report.version,
            status: report.status,
            facts_json: JSON.stringify(report.facts || {}),
            narrative_json: JSON.stringify(report.narrative || {}),
            html_path: report.html_path,
            public_url: report.public_url || null,
            tapd_synced_at: report.tapd_synced_at || null,
            generated_at: report.generated_at,
            trigger_type: report.trigger_type,
            source_message_id: report.source_message_id || null,
        };
        await this.prisma.weeklyReport.upsert({
            where: { id: report.id },
            update: data,
            create: data,
        });
    }

    async getWeeklyReport(reportId: string): Promise<WeeklyReport | null> {
        const record = await this.prisma.weeklyReport.findUnique({ where: { id: reportId } });
        return record ? this._parseWeeklyReport(record) : null;
    }

    async listWeeklyReports(groupId?: string, periodStart?: string, periodEnd?: string): Promise<WeeklyReport[]> {
        const where: any = {};
        if (groupId) where.group_id = groupId;
        if (periodStart) where.period_start = periodStart;
        if (periodEnd) where.period_end = periodEnd;
        const records = await this.prisma.weeklyReport.findMany({
            where,
            orderBy: [{ generated_at: 'desc' }, { version: 'desc' }],
        });
        return records.map((record: any) => this._parseWeeklyReport(record));
    }

    private _parseWeeklyReport(record: any): WeeklyReport {
        const { facts_json, narrative_json, ...rest } = record;
        return {
            ...rest,
            facts: parseJsonObject(facts_json),
            narrative: parseJsonObject(narrative_json),
        };
    }

    async saveMeetingSummaryRecord(record: MeetingSummaryRecord): Promise<void> {
        const data = {
            id: record.id,
            date: record.date,
            group_id: record.group_id,
            source_message_id: record.source_message_id,
            theme: record.theme || null,
            summary_file: record.summary_file || null,
            timeline_file: record.timeline_file || null,
            email_sent: record.email_sent,
            created_at: record.created_at
        };
        await this.prisma.meetingSummaryRecord.upsert({
            where: { id: record.id },
            update: data,
            create: data
        });
    }

    async listMeetingSummaryRecords(groupId?: string | null): Promise<any[]> {
        const where = groupId ? { group_id: groupId } : {};
        const records = await this.prisma.meetingSummaryRecord.findMany({
            where,
            orderBy: { created_at: 'desc' }
        });
        return records;
    }

    async saveBotMessageContext(context: BotMessageContext): Promise<void> {
        const data = {
            message_id: context.message_id,
            context_type: context.context_type,
            created_at: context.created_at,
            chat_id: context.chat_id,
            chat_type: context.chat_type,
            target_open_id: context.target_open_id,
            task_id: context.task_id,
            task_title: context.task_title,
            metadata: context.metadata ? JSON.stringify(context.metadata) : null
        };
        await this.prisma.botMessageContext.upsert({
            where: { message_id: context.message_id },
            update: data,
            create: data
        });
    }

    async getBotMessageContext(messageId?: string | null): Promise<any> {
        if (!messageId) return null;
        const record = await this.prisma.botMessageContext.findUnique({ where: { message_id: messageId } });
        if (!record) return null;
        return {
            ...record,
            metadata: record.metadata ? JSON.parse(record.metadata) : undefined
        };
    }

    async listBotMessageContexts(): Promise<any[]> {
        const records = await this.prisma.botMessageContext.findMany();
        return records.map((r: any) => ({
            ...r,
            metadata: r.metadata ? JSON.parse(r.metadata) : undefined
        }));
    }

    async updateChatId(openId: string, chatId: string): Promise<void> {
        await this.prisma.chatIdMapping.upsert({
            where: { open_id: openId },
            update: { chat_id: chatId },
            create: { open_id: openId, chat_id: chatId }
        });
    }

    async openIdForChatId(chatId: string): Promise<string | null> {
        const record = await this.prisma.chatIdMapping.findFirst({ where: { chat_id: chatId } });
        return record ? record.open_id : null;
    }

    async appendAuditLog(eventType: string, payload: any): Promise<void> {
        await this.prisma.auditLog.create({
            data: {
                timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
                event_type: eventType,
                payload: serializeAuditPayload(payload)
            }
        });
    }

    async deleteAuditLogsBefore(cutoff: string, limit: number): Promise<number> {
        const records = await this.prisma.auditLog.findMany({
            where: { timestamp: { lt: cutoff } },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: Math.max(1, limit),
        });
        if (!records.length) return 0;
        const result = await this.prisma.auditLog.deleteMany({
            where: { id: { in: records.map(record => record.id) } },
        });
        return result.count;
    }

    async countAuditLogsBefore(cutoff: string): Promise<number> {
        return this.prisma.auditLog.count({ where: { timestamp: { lt: cutoff } } });
    }

    async listRawIdempotencyRecords(prefix: string): Promise<Array<{ key: string; value: string }>> {
        return this.prisma.idempotency.findMany({
            where: { key: { startsWith: prefix } },
            select: { key: true, value: true },
            orderBy: { key: 'asc' },
        });
    }

    async deleteIdempotencyKeys(keys: string[]): Promise<number> {
        if (!keys.length) return 0;
        const result = await this.prisma.idempotency.deleteMany({ where: { key: { in: keys } } });
        return result.count;
    }

    async saveCompanyMembers(members: Array<{ open_id: string; name: string; department?: string | null; is_active?: boolean }>): Promise<void> {
        const updatedAt = new Date().toISOString();
        await this.prisma.$transaction(
            members.map(member => this.prisma.companyMember.upsert({
                where: { open_id: member.open_id },
                update: {
                    name: member.name,
                    department: member.department || null,
                    is_active: member.is_active !== false,
                    updated_at: updatedAt
                },
                create: {
                    open_id: member.open_id,
                    name: member.name,
                    department: member.department || null,
                    is_active: member.is_active !== false,
                    updated_at: updatedAt
                }
            }))
        );
    }

    async reconcileCompanyMembers(members: Array<{ open_id: string; name: string; department?: string | null }>): Promise<{ deactivated: number }> {
        const activeMembers = members.filter(member => member.open_id);
        if (activeMembers.length === 0) throw new Error("Company directory snapshot is empty");

        const updatedAt = new Date().toISOString();
        return this.prisma.$transaction(async (tx: any) => {
            const inactive = await tx.companyMember.updateMany({
                where: { is_active: true, open_id: { notIn: activeMembers.map(member => member.open_id) } },
                data: { is_active: false, updated_at: updatedAt },
            });
            await Promise.all(activeMembers.map(member => tx.companyMember.upsert({
                where: { open_id: member.open_id },
                update: {
                    name: member.name,
                    department: member.department || null,
                    is_active: true,
                    updated_at: updatedAt,
                },
                create: {
                    open_id: member.open_id,
                    name: member.name,
                    department: member.department || null,
                    is_active: true,
                    updated_at: updatedAt,
                },
            })));
            return { deactivated: inactive.count };
        });
    }

    async getCompanyMember(openId: string): Promise<any> {
        return this.prisma.companyMember.findUnique({ where: { open_id: openId } });
    }

    async listCompanyMembers(): Promise<any[]> {
        return this.prisma.companyMember.findMany();
    }
}
