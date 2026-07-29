import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceMessage } from '@/models/types';
import { ContextResolver } from '@/services/messageHandler/ContextResolver';
import { HandlerContext } from '@/services/messageHandler/types';

export interface TaskAttachmentSummary {
    total: number;
    uploaded: number;
    failed: number;
}

export class TaskAttachmentService {
    static async attachSourceImages(
        ctx: HandlerContext,
        message: SourceMessage,
        storyId: string
    ): Promise<TaskAttachmentSummary> {
        const summary: TaskAttachmentSummary = { total: 0, uploaded: 0, failed: 0 };
        let images: { imageKey: string, messageId: string }[] = [];

        try {
            const related = await new ContextResolver(ctx).resolveRelatedFiles(message);
            images = related
                .filter((item): item is { imageKey: string, messageId: string } => !!item.imageKey)
                .map(item => ({ imageKey: item.imageKey, messageId: item.messageId }));
        } catch (error) {
            await ctx.store.appendAuditLog("tapd_attachment_upload_failed", {
                message_id: message.id,
                tapd_story_id: storyId,
                stage: "resolve_images",
                error: String(error),
            });
            return summary;
        }

        summary.total = images.length;
        if (!images.length) return summary;

        const failures: { message_id: string, image_key: string, error: string }[] = [];
        const embeddedImages: { messageId: string, imageKey: string, contentType: string, base64: string }[] = [];
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tapd-source-images-"));
        try {
            for (let index = 0; index < images.length; index++) {
                const image = images[index];
                const tempPath = path.join(tempDir, `image-${index + 1}`);
                try {
                    const feishu = ctx.feishu as any;
                    const downloaded = typeof feishu.downloadResourceWithMetadata === "function"
                        ? await feishu.downloadResourceWithMetadata(image.messageId, image.imageKey, "image", tempPath)
                        : { ok: await feishu.downloadResource(image.messageId, image.imageKey, "image", tempPath) };
                    if (!downloaded.ok) {
                        failures.push({
                            message_id: image.messageId,
                            image_key: image.imageKey,
                            error: downloaded.error || "Feishu image download failed",
                        });
                        continue;
                    }

                    embeddedImages.push({
                        messageId: image.messageId,
                        imageKey: image.imageKey,
                        contentType: this.imageContentType(downloaded.contentType),
                        base64: (await fs.promises.readFile(tempPath)).toString("base64"),
                    });
                } catch (error) {
                    failures.push({
                        message_id: image.messageId,
                        image_key: image.imageKey,
                        error: String(error),
                    });
                }
            }
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }

        if (embeddedImages.length) {
            try {
                const currentStory = await ctx.tapd.getStory(storyId);
                const currentDescription = this.storyDescription(currentStory.raw);
                if (!currentStory.ok || currentDescription === undefined) {
                    const error = currentStory.error || "TAPD story description could not be loaded";
                    failures.push(...embeddedImages.map(image => ({
                        message_id: image.messageId,
                        image_key: image.imageKey,
                        error,
                    })));
                } else {
                    const description = `${currentDescription}${embeddedImages
                        .map(image => `<p><img src="data:${image.contentType};base64,${image.base64}" /></p>`)
                        .join("")}`;
                    const updated = await ctx.tapd.updateStoryDescription(storyId, description);
                    if (updated.ok) {
                        summary.uploaded = embeddedImages.length;
                    } else {
                        const error = updated.error || "TAPD detail image upload failed";
                        failures.push(...embeddedImages.map(image => ({
                            message_id: image.messageId,
                            image_key: image.imageKey,
                            error,
                        })));
                    }
                }
            } catch (error) {
                failures.push(...embeddedImages.map(image => ({
                    message_id: image.messageId,
                    image_key: image.imageKey,
                    error: String(error),
                })));
            }
        }

        summary.failed = failures.length;
        await ctx.store.appendAuditLog(
            failures.length ? "tapd_attachment_upload_failed" : "tapd_attachment_upload_completed",
            {
                message_id: message.id,
                tapd_story_id: storyId,
                total: summary.total,
                uploaded: summary.uploaded,
                failed: summary.failed,
                failures,
            }
        );

        if (failures.length && message.sender_open_id) {
            const reasons = [...new Set(failures.map(item => item.error).filter(Boolean))];
            const reasonText = reasons.length ? `\n原因：${reasons.join("；")}` : "";
            await ctx.feishu.sendPrivateText(
                message.sender_open_id,
                `任务已创建，但有 ${failures.length} 张图片未能上传到 TAPD。${reasonText}`
            );
        }
        return summary;
    }

    private static imageContentType(contentType: string | undefined): string {
        const value = String(contentType || "").split(";")[0].toLowerCase();
        return ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(value)
            ? value
            : "image/png";
    }

    private static storyDescription(raw: any): string | undefined {
        const data = raw?.data;
        const item = Array.isArray(data) ? data[0] : data;
        const story = item?.Story || item?.story || item;
        return typeof story?.description === "string" ? story.description : undefined;
    }
}
