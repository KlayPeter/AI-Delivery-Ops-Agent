import { describe, expect, test } from "bun:test";
import { normalizeDynamicConfigMembers } from "@/core/storage";
import { GroupMemberSyncService, mergeFetchedGroupMembers } from "@/services/groupMembers";

describe("Group member synchronization", () => {
    test("should persist synchronized job titles in dynamic group config", () => {
        expect(normalizeDynamicConfigMembers({
            name: "交付群",
            members: [{ open_id: "ou_dev", name: "研发", job_title: "后端工程师" }],
        })).toEqual([{
            open_id: "ou_dev",
            name: "研发",
            role: null,
            job_title: "后端工程师",
            is_active: true,
        }]);
    });

    test("should replace current members with Feishu members and preserve roles", () => {
        const result = mergeFetchedGroupMembers(
            [
                { open_id: "ou_keep", name: "旧姓名", role: "前端", is_active: true },
                { open_id: "ou_removed", name: "已退群", role: "后端", is_active: true },
            ],
            [
                { open_id: "ou_keep", name: "新姓名", job_title: "高级前端工程师" },
                { member_id: "ou_added", user_name: "新成员", job_title: "产品经理" },
            ]
        );

        expect(result.added).toEqual(["ou_added"]);
        expect(result.removed).toEqual(["ou_removed"]);
        expect(result.changed).toBe(true);
        expect(result.members).toEqual([
            { open_id: "ou_keep", name: "新姓名", role: "前端", job_title: "高级前端工程师", is_active: true },
            { open_id: "ou_added", name: "新成员", role: undefined, job_title: "产品经理", is_active: true },
        ]);
    });

    test("should not wipe existing members when Feishu returns an empty list", async () => {
        const savedPayloads: any[] = [];
        const auditLogs: any[] = [];
        const store: any = {
            getDynamicConfig: async () => ({
                groups: [{
                    chat_id: "oc_group",
                    name: "群组",
                    members: [{ open_id: "ou_keep", name: "成员", is_active: true }],
                    schedule: {},
                    daily_summary_period: "00:00-23:59",
                }],
            }),
            saveDynamicConfig: async (payload: any) => savedPayloads.push(payload),
            appendAuditLog: async (eventType: string, payload: any) => auditLogs.push({ eventType, payload }),
        };
        const feishu: any = {
            listGroupMembers: async (): Promise<any[]> => [],
        };

        const service = new GroupMemberSyncService(store, feishu);
        const result = await service.syncAll("test");

        expect(result.changed).toBe(false);
        expect(result.results[0].skipped).toBe("empty_feishu_response");
        expect(savedPayloads).toHaveLength(0);
        expect(auditLogs[0].eventType).toBe("group_members_sync");
    });

    test("should persist job titles returned by Feishu group member lookup", async () => {
        const savedPayloads: any[] = [];
        const store: any = {
            getDynamicConfig: async () => ({
                groups: [{
                    chat_id: "oc_group",
                    name: "交付群",
                    members: [{ open_id: "ou_qa", name: "测试同学", is_active: true }],
                    schedule: {},
                    daily_summary_period: "00:00-23:59",
                }],
            }),
            saveDynamicConfig: async (payload: any) => savedPayloads.push(payload),
            appendAuditLog: async (): Promise<void> => undefined,
        };
        const feishu: any = {
            listGroupMembers: async () => [{ open_id: "ou_qa", name: "测试同学", job_title: "QA工程师" }],
        };

        const service = new GroupMemberSyncService(store, feishu);
        const result = await service.syncAll("test");

        expect(result.changed).toBe(true);
        expect(savedPayloads[0].groups[0].members[0]).toMatchObject({
            open_id: "ou_qa",
            job_title: "QA工程师",
        });
    });
});

for (const method of ['syncAll', 'syncGroup'] as const) test(`scheduled ${method} failures are audited without replacing existing members`, async () => {
    const logs: any[] = [];
    const raw = { groups: [{ chat_id: 'oc_existing', name: 'Group', members: [{ open_id: 'ou_kept', name: 'Existing member', is_active: true }], schedule: {} }] };
    const store: any = { getDynamicConfig: async () => raw,
        saveDynamicConfig: async () => { throw new Error('A failed fetch must not replace members'); },
        appendAuditLog: async (event: string, payload: any) => { logs.push({ event, payload }); },
    };
    const service = new GroupMemberSyncService(store, { listGroupMembers: async () => { throw new Error('fixture access failure'); } } as any);
    const result = method === 'syncAll' ? await service.syncAll('scheduler') : await service.syncGroup('oc_existing', 'scheduler');
    expect(result.changed).toBe(false); expect(result.results[0].error).toBe('fixture access failure');
    expect(raw.groups[0].members[0].open_id).toBe('ou_kept');
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ event: 'group_members_sync', payload: { changed: false, trigger: 'scheduler' } });
});
