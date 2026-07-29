import { test, expect, describe } from "bun:test";
import { hasExplicitTaskCreationIntent, hasTaskIntent, parseTaskCommand, parseDueDateText } from '@/services/taskParser';
import { Mention } from '@/models/types';

describe("TaskParser", () => {
    test("should distinguish explicit creation from due-date updates", () => {
        expect(hasExplicitTaskCreationIntent("创建任务，还需要 Peter 考虑一个分类方案。截止时间：本周五。")).toBe(true);
        expect(hasExplicitTaskCreationIntent("把任务截止时间改为本周五")).toBe(false);
        expect(hasExplicitTaskCreationIntent("先不要创建任务")).toBe(false);
    });

    test("should extract due date correctly", () => {
        const today = new Date("2026-06-25T12:00:00Z"); // Thursday
        expect(parseDueDateText("明天完成", today)).toBe("2026-06-26");
        expect(parseDueDateText("下周一完成", today)).toBe("2026-06-29");
        expect(parseDueDateText("2026-07-01完成", today)).toBe("2026-07-01");
        expect(parseDueDateText("预计3天完成", today)).toBe("2026-06-28");
        expect(parseDueDateText("工期一周", today)).toBe("2026-07-02");
    });

    test("should parse task command correctly", () => {
        const mentions: Mention[] = [
            { open_id: "bot_123", name: "Bot" },
            { open_id: "user_456", name: "张三" }
        ];

        const result = parseTaskCommand(
            "@Bot 创建任务：修复登录页面的Bug\n主负责人 @张三\n截止时间：下周三\n优先级：高\n验收标准：1. 登录正常；2. 报错清晰",
            mentions,
            "bot_123",
            new Date("2026-06-25T12:00:00Z"),
            false
        );

        expect(result.should_create).toBe(true);
        expect(result.title).toBe("修复登录页面的Bug");
        expect(result.primary_owner?.name).toBe("张三");
        expect(result.priority).toBe("P0");
        expect(result.due_date).toBe("2026-07-01");
        expect(result.acceptance_criteria.length).toBe(2);
    });

    test("should default task due date to one day when not mentioned", () => {
        const mentions: Mention[] = [
            { open_id: "bot_123", name: "Bot" },
            { open_id: "user_456", name: "张三" }
        ];

        const result = parseTaskCommand(
            "@Bot 创建任务：修复登录页面的Bug @张三",
            mentions,
            "bot_123",
            new Date("2026-06-25T12:00:00Z"),
            false
        );

        expect(result.should_create).toBe(true);
        expect(result.due_date).toBe("2026-06-26");
    });

    test("should parse natural task intent without requiring fixed command words", () => {
        const mentions: Mention[] = [
            { open_id: "bot_123", name: "Bot" },
            { open_id: "user_456", name: "张三" }
        ];

        const result = parseTaskCommand(
            "@Bot @张三 明天把登录页验收问题处理完",
            mentions,
            "bot_123",
            new Date("2026-06-25T12:00:00Z"),
            false
        );

        expect(result.should_create).toBe(true);
        expect(result.title).toBe("登录页验收问题");
        expect(result.primary_owner?.name).toBe("张三");
        expect(result.due_date).toBe("2026-06-26");
    });

    test("should keep every mentioned assignee and use the first as primary owner", () => {
        const mentions: Mention[] = [
            { open_id: "bot_123", name: "Bot" },
            { open_id: "user_456", name: "张三" },
            { open_id: "user_789", name: "李四" },
            { open_id: "user_456", name: "张三" },
        ];

        const result = parseTaskCommand(
            "@Bot 创建任务：联合完成交互方案，负责人 @张三 @李四",
            mentions,
            "bot_123",
            new Date("2026-06-25T12:00:00Z"),
            false
        );

        expect(result.should_create).toBe(true);
        expect(result.primary_owner?.open_id).toBe("user_456");
        expect(result.assignees.map(item => item.open_id)).toEqual(["user_456", "user_789"]);
        expect(result.missing_primary_owner).toBe(false);
    });

    test("should not treat casual mentions as task intent", () => {
        expect(hasTaskIntent("@Bot @张三 看下这个消息")).toBe(false);
        expect(hasTaskIntent("@Bot @张三 不要处理这个任务")).toBe(false);
    });
});
