import { describe, expect, test } from "bun:test";
import { TaskAttachmentService } from "@/domains/task/attachments";

describe("TaskAttachmentService", () => {
    test("should embed source images into the TAPD story description", async () => {
        const auditEvents: any[] = [];
        const privateMessages: string[] = [];
        const descriptions: string[] = [];
        const summary = await TaskAttachmentService.attachSourceImages({
            config: { tapd: {} },
            store: {
                getSourceMessage: async (): Promise<any> => null,
                appendAuditLog: async (event: string, payload: any) => auditEvents.push({ event, payload }),
            },
            feishu: {
                downloadResourceWithMetadata: async (_messageId: string, _imageKey: string, _type: string, tempPath: string) => {
                    await Bun.write(tempPath, new Uint8Array([137, 80, 78, 71]));
                    return {
                        ok: true,
                        contentType: "image/png",
                        fileName: "需求截图.png",
                    };
                },
                sendPrivateText: async (_openId: string, text: string) => {
                    privateMessages.push(text);
                    return { ok: true };
                },
            },
            tapd: {
                getStory: async () => ({ ok: true, raw: { data: [{ Story: { description: "<p>原始描述</p>" } }] } }),
                updateStoryDescription: async (_storyId: string, description: string) => {
                    descriptions.push(description);
                    return { ok: true };
                },
            },
        } as any, {
            id: "om_create",
            sender_open_id: "ou_creator",
            sender_name: "创建人",
            image_key: "img_source",
        } as any, "story-1");

        expect(summary).toEqual({ total: 1, uploaded: 1, failed: 0 });
        expect(auditEvents[0]).toMatchObject({
            event: "tapd_attachment_upload_completed",
            payload: { tapd_story_id: "story-1", total: 1, uploaded: 1, failed: 0 },
        });
        expect(descriptions[0]).toContain("<p>原始描述</p>");
        expect(descriptions[0]).toContain('data:image/png;base64,iVBORw==');
        expect(privateMessages).toEqual([]);
    });

    test("should report a TAPD detail update failure without failing task creation", async () => {
        const auditEvents: any[] = [];
        const privateMessages: string[] = [];
        const summary = await TaskAttachmentService.attachSourceImages({
            config: { tapd: {} },
            store: {
                getSourceMessage: async (): Promise<any> => null,
                appendAuditLog: async (event: string, payload: any) => auditEvents.push({ event, payload }),
            },
            feishu: {
                downloadResourceWithMetadata: async (_messageId: string, _imageKey: string, _type: string, tempPath: string) => {
                    await Bun.write(tempPath, new Uint8Array([137, 80, 78, 71]));
                    return { ok: true, contentType: "image/png" };
                },
                sendPrivateText: async (_openId: string, text: string) => {
                    privateMessages.push(text);
                    return { ok: true };
                },
            },
            tapd: {
                getStory: async () => ({ ok: true, raw: { data: [{ Story: { description: "<p>原始描述</p>" } }] } }),
                updateStoryDescription: async () => ({ ok: false, error: "detail update failed" }),
            },
        } as any, {
            id: "om_create",
            sender_open_id: "ou_creator",
            image_key: "img_source",
        } as any, "story-1");

        expect(summary).toEqual({ total: 1, uploaded: 0, failed: 1 });
        expect(auditEvents[0]).toMatchObject({
            event: "tapd_attachment_upload_failed",
            payload: { tapd_story_id: "story-1", total: 1, uploaded: 0, failed: 1 },
        });
        expect(privateMessages[0]).toContain("原因：detail update failed");
    });
});
