import { describe, expect, test } from "bun:test";
import { TaskService } from "@/services/taskService";

function remoteStory(overrides: Record<string, any> = {}) {
    return {
        Story: {
            id: "1112345678001002001",
            name: "线上需求",
            description: "TAPD 最新描述",
            status: "status_14",
            owner: "张三;李四;",
            priority_label: "High",
            due: "2026-07-20",
            begin: "2026-07-08",
            effort: "2.5",
            workitem_type_id: "1112345678001000017",
            created: "2026-07-01 09:00:00",
            modified: "2026-07-10 10:00:00",
            ...overrides,
        },
    };
}

function localTask(overrides: Record<string, any> = {}) {
    return {
        id: "task-local",
        title: "本地任务",
        creator_open_id: "ou_creator",
        creator_name: "创建人",
        primary_owner_open_id: "ou_zhang",
        primary_owner_name: "张三",
        assignee_open_ids: ["ou_zhang"],
        assignee_names: ["张三"],
        status: "confirmed",
        priority: "P2",
        source_message_id: "om_local",
        source_group_id: "oc_dev",
        created_at: "2026-07-01T01:00:00Z",
        updated_at: "2026-07-01T01:00:00Z",
        tapd_story_id: null as string | null,
        tapd_url: null as string | null,
        ...overrides,
    };
}

const config: any = {
    tapd: { workspace_id: 12345678 },
    groups: [
        {
            chat_id: "oc_dev",
            name: "Demo 研发组",
            members: [
                { open_id: "ou_zhang", name: "张三", is_active: true },
                { open_id: "ou_li", name: "李四", is_active: true },
            ],
            schedule: { dashboard_enabled: true, module_dashboard_enabled: true },
        },
        {
            chat_id: "oc_test",
            name: "测试群",
            members: [],
            schedule: { dashboard_enabled: false, module_dashboard_enabled: true },
        },
    ],
};

describe("TaskService project dashboard synchronization", () => {
    test("imports every TAPD story, updates linked tasks, marks missing stories deleted, and preserves local-only work", async () => {
        const tasks = new Map<string, any>();
        const linked = localTask({
            id: "task-linked",
            title: "旧标题",
            status: "pending_confirmation",
            tapd_story_id: "1112345678001002001",
            tapd_url: "https://tapd.test/1112345678001002001",
        });
        const removed = localTask({
            id: "task-removed",
            title: "已从TAPD删除",
            tapd_story_id: "1112345678001002999",
            tapd_url: "https://tapd.test/1112345678001002999",
        });
        const localOnly = localTask();
        const testOnly = localTask({ id: "task-test", source_group_id: "oc_test" });
        for (const task of [linked, removed, localOnly, testOnly]) tasks.set(task.id, task);

        const pageCalls: number[] = [];
        const tapd = {
            listWorkitemTypes: async () => ({
                ok: true,
                raw: {
                    data: [
                        { WorkitemType: { id: "1112345678001000017", name: "STORY" } },
                        { WorkitemType: { id: "1112345678001000020", name: "DEVELOP" } },
                    ],
                },
            }),
            listStories: async (page: number, limit: number) => {
                pageCalls.push(page);
                if (page === 1) {
                    return {
                        ok: true,
                        raw: {
                            data: [
                                remoteStory(),
                                remoteStory({
                                    id: "1112345678001002002",
                                    name: "TAPD 手工创建需求",
                                    owner: "李四;",
                                    status: "status_2",
                                    workitem_type_id: "1112345678001000020",
                                }),
                            ],
                        },
                    };
                }
                return { ok: true, raw: { data: [] } };
            },
            storyUrl: (storyId: string) => `https://tapd.test/${storyId}`,
        };
        const store = {
            listTasks: async () => Array.from(tasks.values()),
            saveTask: async (task: any) => tasks.set(task.id, structuredClone(task)),
        };

        const result = await TaskService.syncProjectScope({ config, tapd, store }, { pageSize: 2 });

        expect(result).toMatchObject({ ok: true, fetched: 2, created: 1, deleted: 1, local_only: 2 });
        expect(pageCalls).toEqual([1, 2]);
        expect(tasks.get("task-linked")).toMatchObject({
            title: "线上需求",
            status: "in_progress",
            priority: "P0",
            primary_owner_open_id: "ou_zhang",
            primary_owner_name: "张三",
            assignee_open_ids: ["ou_zhang", "ou_li"],
            assignee_names: ["张三", "李四"],
            due_date: "2026-07-20",
            trace: {
                tapd: {
                    begin_date: "2026-07-08",
                    effort_days: 2.5,
                    workitem_type: "STORY",
                    workitem_type_key: "STORY",
                },
            },
        });
        expect(tasks.get("task-removed").status).toBe("deleted");
        expect(tasks.get("task-local").status).toBe("confirmed");
        expect(tasks.get("tapd-1112345678001002002")).toMatchObject({
            tapd_story_id: "1112345678001002002",
            title: "TAPD 手工创建需求",
            status: "requirement",
            source_group_id: "",
            primary_owner_open_id: "ou_li",
            trace: {
                tapd: {
                    people_source: "tapd_names",
                    workitem_type: "DEVELOP",
                    workitem_type_key: "DEVELOP",
                },
            },
        });
    });

    test("resolves a unique TAPD short name to a member name with a parenthetical alias", async () => {
        let savedTask: any = null;
        const aliasConfig = {
            ...config,
            groups: [{
                ...config.groups[0],
                members: [{ open_id: "ou_dion", name: "刘开发（Dion）", is_active: true }],
            }],
        };
        const tapd = {
            listStories: async () => ({
                ok: true,
                raw: {
                    data: [remoteStory({
                        id: "1112345678001002888",
                        owner: "刘开发;",
                    })],
                },
            }),
            storyUrl: (storyId: string) => `https://tapd.test/${storyId}`,
        };
        const store = {
            listTasks: async (): Promise<any[]> => [],
            saveTask: async (task: any) => { savedTask = structuredClone(task); },
        };

        const result = await TaskService.syncProjectScope({ config: aliasConfig, tapd, store }, { pageSize: 2 });

        expect(result).toMatchObject({ ok: true, fetched: 1, created: 1 });
        expect(savedTask).toMatchObject({
            primary_owner_name: "刘开发",
            primary_owner_open_id: "ou_dion",
            assignee_names: ["刘开发"],
            assignee_open_ids: ["ou_dion"],
        });
    });

    test("keeps an ambiguous TAPD short name unresolved", async () => {
        let savedTask: any = null;
        const ambiguousConfig = {
            ...config,
            groups: [{
                ...config.groups[0],
                members: [
                    { open_id: "ou_product", name: "王明（产品）", is_active: true },
                    { open_id: "ou_develop", name: "王明（研发）", is_active: true },
                ],
            }],
        };
        const tapd = {
            listStories: async () => ({
                ok: true,
                raw: { data: [remoteStory({ id: "1112345678001002889", owner: "王明;" })] },
            }),
        };
        const store = {
            listTasks: async (): Promise<any[]> => [],
            saveTask: async (task: any) => { savedTask = structuredClone(task); },
        };

        const result = await TaskService.syncProjectScope({ config: ambiguousConfig, tapd, store }, { pageSize: 2 });

        expect(result).toMatchObject({ ok: true, fetched: 1, created: 1 });
        expect(savedTask).toMatchObject({
            primary_owner_name: "王明",
            primary_owner_open_id: "",
            assignee_open_ids: [""],
        });
    });

    test("does not mutate local tasks when a TAPD page cannot be fetched", async () => {
        const original = localTask({
            id: "task-linked",
            tapd_story_id: "1112345678001002001",
            title: "同步前标题",
        });
        const saved: any[] = [];
        const tapd = {
            listStories: async () => ({ ok: false, raw: {}, error: "HTTP 503" }),
        };
        const store = {
            listTasks: async () => [original],
            saveTask: async (task: any) => saved.push(task),
        };

        const result = await TaskService.syncProjectScope({ config, tapd, store }, { pageSize: 2 });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("HTTP 503");
        expect(saved).toHaveLength(0);
        expect(original.title).toBe("同步前标题");
    });

    test("uses the current TAPD status when the local workflow is ahead", async () => {
        const task = localTask({
            id: "task-test-placeholder",
            status: "development_completed",
            tapd_story_id: "1112345678001002001",
            trace: { workflow: { phase: "development_completed" } },
        });
        let savedTask: any = null;
        const tapd = {
            listWorkitemTypes: async () => {
                throw new Error("work item type metadata unavailable");
            },
            listStories: async () => ({ ok: true, raw: { data: [remoteStory({ status: "status_14" })] } }),
            storyUrl: (storyId: string) => `https://tapd.test/${storyId}`,
        };
        const store = {
            listTasks: async () => [task],
            saveTask: async (updatedTask: any) => { savedTask = structuredClone(updatedTask); },
        };

        const result = await TaskService.syncProjectScope({ config, tapd, store }, { pageSize: 2 });

        expect(result.ok).toBe(true);
        expect(savedTask.status).toBe("in_progress");
        expect(savedTask.trace.workflow.phase).toBe("development_completed");
    });
});
