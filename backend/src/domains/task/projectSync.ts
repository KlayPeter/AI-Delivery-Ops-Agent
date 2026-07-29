import { createHash } from 'node:crypto';
import {
    type Task,
    type TaskUpdate,
    TASK_STATUS_BLOCKED,
    utcNowIso,
} from '@/models/types';
import { canonicalTapdPriority, canonicalTapdStatus } from './tapdPolicy';

export interface ProjectTaskSyncResult {
    ok: boolean;
    fetched: number;
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
    local_only: number;
    error?: string;
}

export interface ProjectSyncOptions {
    pageSize?: number;
    maxPages?: number;
}

function tapdStory(entry: any): any {
    return entry?.Story || entry?.story || entry;
}

function tapdWorkitemType(entry: any): any {
    return entry?.WorkitemType || entry?.workitem_type || entry;
}

function canonicalWorkitemType(value: unknown): "STORY" | "DEVELOP" | "ARTS" | null {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return null;
    if (/(^|[^a-z])(arts?|artwork)([^a-z]|$)|美术|视觉/.test(text)) return "ARTS";
    if (/develop|development|开发|研发|技术/.test(text)) return "DEVELOP";
    if (/story|requirement|需求|产品/.test(text)) return "STORY";
    return null;
}

function tapdPeople(owner: any): string[] {
    return String(owner || "")
        .split(/[;,，]/)
        .map(name => name.trim())
        .filter(Boolean);
}

function personNameAliases(value: unknown): string[] {
    const normalized = String(value || "")
        .normalize("NFKC")
        .trim()
        .toLocaleLowerCase()
        .replace(/\s+/g, "");
    if (!normalized) return [];

    const withoutTrailingAlias = normalized.replace(/\([^()]*\)$/, "");
    return Array.from(new Set([normalized, withoutTrailingAlias].filter(Boolean)));
}

function tapdEffortDays(story: any): number | null {
    const raw = story?.effort ?? story?.workload ?? story?.estimate ?? story?.estimated_effort;
    if (raw === null || raw === undefined || raw === "") return null;
    const value = Number(String(raw).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function sameTask(left: any, right: any): boolean {
    const fields = [
        "title", "description", "status", "priority", "due_date", "updated_at",
        "primary_owner_open_id", "primary_owner_name", "tapd_url", "parent_id",
    ];
    if (fields.some(field => (left?.[field] ?? null) !== (right?.[field] ?? null))) return false;
    if (JSON.stringify(left?.assignee_open_ids || []) !== JSON.stringify(right?.assignee_open_ids || [])) return false;
    if (JSON.stringify(left?.assignee_names || []) !== JSON.stringify(right?.assignee_names || [])) return false;
    return JSON.stringify(left?.trace?.tapd || {}) === JSON.stringify(right?.trace?.tapd || {});
}

function tapdTaskChanges(previous: Task, next: Task): Record<string, { from: unknown; to: unknown }> {
    const fields: Array<keyof Task> = [
        "title",
        "priority",
        "due_date",
        "primary_owner_name",
        "assignee_names",
    ];
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of fields) {
        const before = previous[field] ?? null;
        const after = next[field] ?? null;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            changes[field] = { from: before, to: after };
        }
    }
    const tapdFields = ["status", "progress", "iteration_id", "completed_at"] as const;
    for (const field of tapdFields) {
        const before = previous.trace?.tapd?.[field] ?? null;
        const after = next.trace?.tapd?.[field] ?? null;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            changes[field === "status" ? "tapd_status" : field] = { from: before, to: after };
        }
    }
    return changes;
}

async function saveTapdSyncUpdate(store: any, previous: Task, next: Task): Promise<void> {
    if (typeof store.saveTaskUpdate !== "function") return;
    const changes = tapdTaskChanges(previous, next);
    if (!Object.keys(changes).length) return;

    const eventAt = String(next.trace?.tapd?.modified_at || next.updated_at || utcNowIso());
    const digest = createHash("sha256")
        .update(JSON.stringify({ task_id: next.id, event_at: eventAt, changes }))
        .digest("hex")
        .slice(0, 16);
    await store.saveTaskUpdate({
        id: `tapd-sync-${next.id}-${digest}`,
        task_id: next.id,
        user_open_id: "tapd",
        user_name: "TAPD",
        update_type: "tapd_sync",
        content: `TAPD 同步更新：${Object.keys(changes).join("、")}`,
        source: "tapd",
        source_message_id: null,
        source_group_id: next.source_group_id || "",
        created_at: eventAt,
        metadata: {
            tapd_story_id: next.tapd_story_id,
            changes,
        },
    } satisfies TaskUpdate);
}

export async function syncProjectTasks(ctx: any, options: ProjectSyncOptions = {}): Promise<ProjectTaskSyncResult> {
    const pageSize = Math.max(1, Math.min(200, options.pageSize || 200));
    const maxPages = Math.max(1, options.maxPages || 1000);
    const emptyResult = { fetched: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, local_only: 0 };

    if (!ctx?.tapd || typeof ctx.tapd.listStories !== "function") {
        return { ok: false, ...emptyResult, error: "TAPD listStories is unavailable" };
    }
    if (!ctx?.store || typeof ctx.store.listTasks !== "function" || typeof ctx.store.saveTask !== "function") {
        return { ok: false, ...emptyResult, error: "Task store is unavailable" };
    }

    const remoteById = new Map<string, any>();
    const workitemTypesById = new Map<string, any>();
    try {
        if (typeof ctx.tapd.listWorkitemTypes === "function") {
            try {
                const typeResult = await ctx.tapd.listWorkitemTypes(1, 200);
                if (typeResult?.ok && Array.isArray(typeResult?.raw?.data)) {
                    for (const entry of typeResult.raw.data) {
                        const workitemType = tapdWorkitemType(entry);
                        const typeId = String(workitemType?.id || "").trim();
                        if (typeId) workitemTypesById.set(typeId, workitemType);
                    }
                }
            } catch {
                workitemTypesById.clear();
            }
        }
        let completed = false;
        for (let page = 1; page <= maxPages; page++) {
            const result = await ctx.tapd.listStories(page, pageSize);
            if (!result?.ok) {
                return { ok: false, ...emptyResult, error: result?.error || `TAPD page ${page} failed` };
            }
            const rows = result?.raw?.data;
            if (!Array.isArray(rows)) {
                return { ok: false, ...emptyResult, error: `TAPD page ${page} returned invalid data` };
            }
            for (const entry of rows) {
                const story = tapdStory(entry);
                const storyId = String(story?.id || "").trim();
                if (!storyId) {
                    return { ok: false, ...emptyResult, error: `TAPD page ${page} contains a story without id` };
                }
                if (remoteById.has(storyId)) {
                    return { ok: false, ...emptyResult, error: `TAPD returned duplicate story id ${storyId}` };
                }
                remoteById.set(storyId, story);
            }
            if (rows.length < pageSize) {
                completed = true;
                break;
            }
        }
        if (!completed) {
            return { ok: false, ...emptyResult, error: `TAPD pagination exceeded ${maxPages} pages` };
        }
    } catch (error: any) {
        return { ok: false, ...emptyResult, error: error?.message || String(error) };
    }

    const existingTasks: Task[] = await ctx.store.listTasks(true);
    const existingByTapd = new Map<string, Task>();
    for (const task of existingTasks) {
        if (task.tapd_story_id) existingByTapd.set(String(task.tapd_story_id), task);
    }

    const members = (ctx.config?.groups || [])
        .flatMap((group: any) => group.members || [])
        .filter((member: any) => member?.is_active !== false && member?.open_id);
    const memberByName = new Map<string, any>();
    const activeMemberOpenIds = new Set<string>();
    for (const member of members) {
        const name = String(member?.name || "").trim();
        if (name && !memberByName.has(name)) memberByName.set(name, member);
        activeMemberOpenIds.add(String(member.open_id));
    }
    if (typeof ctx.store.listCompanyMembers === "function") {
        try {
            const companyMembers = await ctx.store.listCompanyMembers();
            for (const member of companyMembers || []) {
                const name = String(member?.name || "").trim();
                if (name && member?.open_id && member.is_active !== false) {
                    memberByName.set(name, member);
                    activeMemberOpenIds.add(String(member.open_id));
                }
            }
        } catch {
            // Company directory enriches TAPD names but must not block task synchronization.
        }
    }
    const memberByAlias = new Map<string, any | null>();
    for (const [name, member] of memberByName) {
        for (const alias of personNameAliases(name)) {
            const existing = memberByAlias.get(alias);
            if (existing === undefined || existing?.open_id === member?.open_id) {
                memberByAlias.set(alias, member);
            } else {
                memberByAlias.set(alias, null);
            }
        }
    }
    const resolveMember = (name: unknown): any | undefined => {
        const exactName = String(name || "").trim();
        const exact = memberByName.get(exactName);
        if (exact) return exact;
        for (const alias of personNameAliases(exactName)) {
            const matched = memberByAlias.get(alias);
            if (matched) return matched;
        }
        return undefined;
    };

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    for (const [storyId, story] of remoteById) {
        const existing = existingByTapd.get(storyId);
        const syncedStatus = canonicalTapdStatus(story.status);
        const workitemTypeId = story.workitem_type_id ? String(story.workitem_type_id) : null;
        const workitemType = workitemTypeId ? workitemTypesById.get(workitemTypeId) : null;
        const workitemTypeName =
            story.workitem_type ||
            story.workitem_type_name ||
            workitemType?.name ||
            workitemType?.english_name ||
            story.type ||
            null;
        const workitemTypeKey =
            canonicalWorkitemType(story.workitem_type) ||
            canonicalWorkitemType(story.workitem_type_name) ||
            canonicalWorkitemType(workitemType?.english_name) ||
            canonicalWorkitemType(workitemType?.name) ||
            canonicalWorkitemType(story.type);
        const names = tapdPeople(story.owner || story.developer);
        const assigneeNames = names.length ? names : (existing?.assignee_names || []);
        const assigneeOpenIds = assigneeNames.map((name: string) => {
            const known = resolveMember(name)?.open_id;
            if (known) return String(known);
            const existingIndex = existing?.assignee_names?.indexOf(name) ?? -1;
            const existingOpenId = existingIndex >= 0 ? String(existing?.assignee_open_ids?.[existingIndex] || "") : "";
            return activeMemberOpenIds.has(existingOpenId) ? existingOpenId : "";
        });
        const primaryName = assigneeNames[0] || existing?.primary_owner_name || "";
        const primaryMember = resolveMember(primaryName);
        const existingPrimaryOpenId = existing?.primary_owner_name === primaryName
            ? String(existing?.primary_owner_open_id || "")
            : "";
        const primaryOpenId = String(
            primaryMember?.open_id ||
            (activeMemberOpenIds.has(existingPrimaryOpenId) ? existingPrimaryOpenId : "") ||
            assigneeOpenIds[0] ||
            ""
        );
        const creatorName = String(story.creator || existing?.creator_name || "TAPD").replace(/[;,，]+$/, "").trim();
        const existingCreatorOpenId = String(existing?.creator_open_id || "");
        const creatorOpenId = String(
            resolveMember(creatorName)?.open_id ||
            (activeMemberOpenIds.has(existingCreatorOpenId) ? existingCreatorOpenId : "")
        );
        const trace = {
            ...(existing?.trace || {}),
            tapd: {
                source: "project_sync",
                people_source: "tapd_names",
                status: String(story.status || ""),
                workitem_type_id: workitemTypeId,
                workitem_type: workitemTypeName,
                workitem_type_key: workitemTypeKey,
                modified_at: story.modified || null,
                begin_date: story.begin || null,
                effort_days: tapdEffortDays(story),
                completed_at: story.completed || null,
                progress: story.progress ?? null,
                priority_label: story.priority_label || null,
                iteration_id: story.iteration_id || null,
            },
        };
        const next: Task = {
            id: existing?.id || `tapd-${storyId}`,
            title: String(story.name || existing?.title || `TAPD ${storyId}`),
            creator_open_id: creatorOpenId,
            creator_name: creatorName,
            primary_owner_open_id: primaryOpenId,
            primary_owner_name: primaryName,
            assignee_open_ids: assigneeOpenIds,
            assignee_names: assigneeNames,
            status: syncedStatus,
            priority: canonicalTapdPriority(story, existing?.priority || "P2"),
            source_message_id: existing?.source_message_id || "",
            source_group_id: existing?.source_group_id || "",
            created_at: String(story.created || existing?.created_at || utcNowIso()),
            updated_at: String(story.modified || existing?.updated_at || utcNowIso()),
            source_sender_open_id: existing?.source_sender_open_id,
            source_sender_name: existing?.source_sender_name,
            source_sent_at: existing?.source_sent_at,
            raw_text: existing?.raw_text,
            ai_result: existing?.ai_result,
            confidence: existing?.confidence,
            trace,
            description: String(story.description || existing?.description || ""),
            due_date: story.due || null,
            acceptance_criteria: existing?.acceptance_criteria || [],
            dependencies: existing?.dependencies || [],
            related_links: existing?.related_links || [],
            tags: Array.from(new Set([...(existing?.tags || []), "TAPD"])),
            task_plan: existing?.task_plan,
            blocked_at: syncedStatus === TASK_STATUS_BLOCKED
                ? (existing?.blocked_at || String(story.modified || utcNowIso()))
                : null,
            blocker_info: existing?.blocker_info,
            overdue_reminders: existing?.overdue_reminders,
            tapd_story_id: storyId,
            tapd_url: typeof ctx.tapd.storyUrl === "function"
                ? ctx.tapd.storyUrl(storyId)
                : existing?.tapd_url || null,
            parent_id: story.parent_id ? String(story.parent_id) : existing?.parent_id || null,
            is_draft: false,
        };

        if (!existing) {
            await ctx.store.saveTask(next);
            created++;
        } else if (!sameTask(existing, next)) {
            await ctx.store.saveTask(next);
            await saveTapdSyncUpdate(ctx.store, existing, next);
            updated++;
        } else {
            unchanged++;
        }
    }

    for (const task of existingTasks) {
        if (!task.tapd_story_id || remoteById.has(String(task.tapd_story_id)) || task.status === "deleted") continue;
        const deletedTask = { ...task, status: "deleted", updated_at: utcNowIso() };
        await ctx.store.saveTask(deletedTask);
        await saveTapdSyncUpdate(ctx.store, task, deletedTask);
        deleted++;
    }

    return {
        ok: true,
        fetched: remoteById.size,
        created,
        updated,
        deleted,
        unchanged,
        local_only: existingTasks.filter(task => !task.tapd_story_id && task.status !== "deleted" && !task.is_draft).length,
    };
}
