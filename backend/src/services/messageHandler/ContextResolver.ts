import { HandlerContext } from './types';
import { SourceMessage } from '@/models/types';
import { findTaskByTitle } from './utils';
import { extractFeishuImageKeys } from '@/adapters/feishu';

export class ContextResolver {
    constructor(private ctx: HandlerContext) {}

    async resolveReplyContext(message: SourceMessage): Promise<any> {
        const resolve = async () => {
            const visited = new Set<string>();
            for (const msgId of [message.parent_id, message.root_id]) {
                const context = await this.resolveContextFromMessageId(msgId, visited);
                if (context) return context;
            }
            return null;
        };
        return this.ctx.messageRoutes ? this.ctx.messageRoutes.run(resolve) : resolve();
    }

    private async resolveContextFromMessageId(messageId?: string | null, visited: Set<string> = new Set(), depth: number = 0): Promise<any> {
        if (!messageId || visited.has(messageId) || depth > 6) return null;
        visited.add(messageId);

        const context = await this.ctx.store.getBotMessageContext(messageId);
        if (context) return context;

        for (const route of this.ctx.messageRoutes?.list(undefined, 'context') || []) {
            const inferred = await route.lookupContext?.(this.ctx, messageId);
            if (inferred) return inferred;
        }
        const sourceMessage = await this.ctx.store.getSourceMessage(messageId);
        if (!sourceMessage) return null;

        for (const nextId of [sourceMessage.parent_id, sourceMessage.root_id]) {
            if (!nextId || nextId === messageId) continue;
            const chainedContext = await this.resolveContextFromMessageId(nextId, visited, depth + 1);
            if (chainedContext) return chainedContext;
        }
        return null;
    }

    async contextualTask(message: SourceMessage, replyContext: any, normalizedText?: string): Promise<any> {
        if (replyContext && replyContext.task_id) {
            const task = await this.ctx.store.getTask(replyContext.task_id);
            if (task) return task;
        }

        const text = normalizedText !== undefined ? normalizedText : (message.text || "");
        const normalized = (text.split("\n")[0] || "").trim();

        const hasIntent = /^(接受|拒绝|需要澄清|验收通过|打回)$/.test(normalized) ||
                          (/(已完成|完成了)/.test(normalized) && !/(没|不|未)完成/.test(normalized)) ||
                          (/(阻塞|阻塞了)/.test(normalized) && !/(不|没|未)阻塞/.test(normalized)) ||
                          /(?:更新|同步|记录|补充).{0,12}进度/.test(normalized) ||
                          /进度\s*(?:为|到|[:：])/.test(normalized) ||
                          normalized.startsWith("进度");

        if (!hasIntent) return null;

        const candidates = [];
        for (const task of await this.ctx.store.listTasks()) {
            const isAssignee = message.sender_open_id === task.primary_owner_open_id ||
                (task.assignee_open_ids || []).includes(message.sender_open_id);
            if (isAssignee &&
                ["pending_confirmation", "confirmed", "in_progress", "blocked", "owner_marked_done"].includes(task.status || "")) {
                candidates.push(task);
            }
        }
        return candidates.length === 1 ? candidates[0] : null;
    }

    async taskFromReplyContext(replyContext: any): Promise<any> {
        if (replyContext && replyContext.task_id) {
            return await this.ctx.store.getTask(replyContext.task_id);
        }
        return null;
    }

    async resolveRelatedFiles(message: SourceMessage): Promise<{ fileKey?: string, imageKey?: string, messageId: string }[]> {
        const files: { fileKey?: string, imageKey?: string, messageId: string }[] = [];
        const seen = new Set<string>();
        const addMessageFiles = (source: SourceMessage): number => {
            let addedImages = 0;
            if (source.file_key) {
                const key = `${source.id}:file:${source.file_key}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    files.push({ fileKey: source.file_key, messageId: source.id });
                }
            }
            const imageKeys = new Set([
                ...(source.image_key ? [source.image_key] : []),
                ...extractFeishuImageKeys(source.raw_payload),
            ]);
            for (const imageKey of imageKeys) {
                const key = `${source.id}:image:${imageKey}`;
                if (seen.has(key)) continue;
                seen.add(key);
                files.push({ imageKey, messageId: source.id });
                addedImages++;
            }
            return addedImages;
        };

        addMessageFiles(message);
        const messageIds = [...new Set([message.parent_id, message.root_id].filter(Boolean) as string[])];
        for (const messageId of messageIds) {
            const relatedMessage = await this.ctx.store.getSourceMessage(messageId);
            const addedImages = relatedMessage ? addMessageFiles(relatedMessage) : 0;
            if (addedImages > 0) continue;
            for (const imageKey of await this.ctx.feishu.getMessageImageKeys(messageId)) {
                const key = `${messageId}:image:${imageKey}`;
                if (seen.has(key)) continue;
                seen.add(key);
                files.push({ imageKey, messageId });
            }
        }
        return files;
    }

    shouldConsiderAi(message: SourceMessage, source: string, replyContext: any): boolean {
        if (source === "private") return true;
        if (replyContext) return true;
        return (message.mentions || []).some(m => m.open_id === this.ctx.config.feishu.bot_open_id);
    }
}
