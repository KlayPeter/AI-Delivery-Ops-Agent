import { describe, expect, test } from "bun:test";
import { StandupService } from "@/services/standupService";

describe("task standup statistics", () => {
    test("classifies task commitments and latest same-day reports", async () => {
        const group = {
            chat_id: "oc_dev",
            members: [{ open_id: "ou_owner", name: "李康", is_active: true }],
        };
        const tasks = [
            {
                id: "standup-1",
                title: "公众号文章初稿",
                source_group_id: "oc_dev",
                source_sent_at: "2026-08-18T16:00:00Z",
                primary_owner_open_id: "ou_owner",
                primary_owner_name: "李康",
                due_date: "2026-08-19T09:00:00Z",
                tags: ["standup_commitment"],
            },
            {
                id: "standup-2",
                title: "不属于当天的任务",
                source_group_id: "oc_dev",
                source_sent_at: "2026-08-18T01:00:00Z",
                primary_owner_open_id: "ou_owner",
                primary_owner_name: "李康",
                tags: ["standup_commitment"],
            },
        ];
        const result = await StandupService.listTaskCommitments({
            listTasks: async () => tasks,
            listTaskUpdates: async () => [{
                task_id: "standup-1",
                update_type: "standup_completed",
                content: "已经交付",
                created_at: "2026-08-18T17:00:00Z",
                metadata: { standup_commitment: true, report_status: "completed" },
            }],
        }, "2026-08-19", group);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            title: "公众号文章初稿",
            status: "completed",
            status_label: "已完成",
            reported: true,
        });
    });
});
