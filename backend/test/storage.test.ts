import { test, expect, describe } from "bun:test";
import { normalizeDynamicConfigMembers, PrismaStore } from '@/core/storage';
import type { SourceMessage } from '@/models/types';
import { randomUUID } from 'node:crypto';

describe("PrismaStore", () => {
    const store = new PrismaStore();

    test("should save and read source message", async () => {
        const sentAt = new Date().toISOString();
        const msg: SourceMessage = {
            id: "msg_123_test",
            chat_id: "chat_456",
            chat_type: "group",
            sender_open_id: "ou_789",
            sender_name: "Test User",
            text: "Hello World",
            message_type: "text",
            sent_at: sentAt,
            raw_payload: {}
        };

        await store.saveSourceMessage(msg);
        const readMsg = await store.getSourceMessage("msg_123_test");
        expect(readMsg).not.toBeNull();
        expect(readMsg?.id).toBe("msg_123_test");
        expect(readMsg?.text).toBe("Hello World");
        expect(await store.getLatestSourceMessageSentAt(
            'chat_456',
            new Date(Date.parse(sentAt) - 1_000),
            new Date(Date.parse(sentAt) + 1_000),
        )).toBe(sentAt);
    });

    test("should normalize dynamic config members before saving", () => {
        const members = normalizeDynamicConfigMembers({
            chat_id: "oc_test",
            name: "测试群",
            members: [
                { open_id: " ou_123 ", name: " 张三 ", role: "PM", job_title: "产品经理", is_active: true },
                { open_id: "ou_456", name: "", is_active: false },
                { open_id: "", name: "", is_active: true },
            ],
        });

        expect(members).toEqual([
            { open_id: "ou_123", name: "张三", role: "PM", job_title: "产品经理", is_active: true },
            { open_id: "ou_456", name: "ou_456", role: null, job_title: null, is_active: false },
        ]);
    });

    test("should reject named members without open_id", () => {
        expect(() => normalizeDynamicConfigMembers({
            chat_id: "oc_test",
            name: "测试群",
            members: [{ name: "张三", is_active: true }],
        })).toThrow("缺少 open_id");
    });

    test("should atomically allow only one idempotency claimant", async () => {
        const key = `test-claim:${randomUUID()}`;
        try {
            const claims = await Promise.all(
                Array.from({ length: 8 }, (_, index) => store.claimIdempotencyKey(key, { claimant: index }))
            );

            expect(claims.filter(Boolean)).toHaveLength(1);
            expect(await store.hasIdempotencyKey(key)).toBe(true);
        } finally {
            await store.prisma.idempotency.deleteMany({ where: { key } });
        }
    });
});
