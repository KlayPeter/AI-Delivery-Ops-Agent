import { HandlerContext } from '../types';
import { SourceMessage, utcNowIso } from '@/models/types';
import { ContextResolver } from '../ContextResolver';
import { parseTaskCommand, hasTaskIntent } from '@/services/taskParser';
import { TaskService } from '@/services/taskService';
import { maybeHandleAiIntent } from '../aiActions';
import { reply } from '../statusUpdates';
import { looksLikeStandup } from '@/services/standup';

export class TaskCommandHandler {
    static async maybeHandle(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        const isPrivate = source === "private";
        const botOpenId = ctx.config.feishu.bot_open_id;
        const key = `${message.id}:create_task`;

        if (looksLikeStandup(message.text || "")) return null;
        if (await ctx.store.hasIdempotencyKey(key)) return { handled: true, action: "idempotent_skip" };

        const command = parseTaskCommand(message.text || "", message.mentions || [], botOpenId, undefined, isPrivate);
        const aiResult = await maybeHandleAiIntent(
            ctx,
            resolver,
            message,
            source,
            replyContext,
            command.should_create ? command : undefined
        );
        const aiFallback = (message.ai_result as any)?.fallback === "deterministic_rule"
            ? (message.ai_result as any)
            : null;
        if (aiResult) {
            if (["task_created", "ai_tasks_created", "independent_tasks_created"].includes(aiResult.action)) {
                await ctx.store.setIdempotencyKey(key, aiResult);
            }
            return aiResult;
        }

        if (command.should_create) {
            message.ai_result = {
                type: "task_command",
                parser: "rule",
                reason: command.reason,
                title: command.title,
                priority: command.priority,
                due_date: command.due_date,
                ai_fallback: aiFallback ? { category: aiFallback.category } : undefined,
            };
            message.confidence = 1.0;
            await ctx.store.saveSourceMessage(message);

            const contextualTask = await resolver.contextualTask(message, replyContext, message.text);
            const parentId = contextualTask ? contextualTask.tapd_story_id : undefined;
            const result = await TaskService.createFromCommand(ctx, message, command, parentId);
            await ctx.store.setIdempotencyKey(key, result);
            if (aiFallback && ["task_created", "independent_tasks_created", "pending_primary_owner"].includes(result.action)) {
                const reason = aiFallback.category === "rate_limited"
                    ? "AI 服务当前限流"
                    : aiFallback.category === "timeout"
                        ? "AI 服务响应超时"
                        : "AI 服务暂时不可用";
                try {
                    await reply(ctx, message, source, `ℹ️ ${reason}，已按任务规则继续处理。`);
                } catch (replyError) {
                    console.error("Failed to send task rule fallback notice:", replyError);
                }
                try {
                    await ctx.store.appendAuditLog("task_command_rule_fallback", {
                        message_id: message.id,
                        category: aiFallback.category,
                        action: result.action,
                    });
                } catch (auditError) {
                    console.error("Failed to audit task rule fallback:", auditError);
                }
            }
            return result;
        }

        if (hasTaskIntent(message.text || "")) {
            const fieldResult = await this.maybeReplyMissingTaskField(ctx, message, source, command.reason);
            if (fieldResult) return fieldResult;
        }

        return null; // Not a task command
    }

    private static async maybeReplyMissingTaskField(ctx: HandlerContext, message: SourceMessage, source: string, reason: string): Promise<any> {
        const prompts: Record<string, string> = {
            "no_assignee_mentioned": "请 @ 任务负责人，并补充期望完成时间。",
            "missing_title": "任务创建没有标题，请引用本条消息并补充任务标题，例如：标题是 xxx"
        };
        const text = prompts[reason];
        if (!text) return null;

        const res = await reply(ctx, message, source, text);
        if (res && res.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "missing_task_field",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                chat_type: message.chat_type,
                metadata: { original_text: message.text }
            });
        }
        await ctx.store.appendAuditLog("task_field_missing", { message_id: message.id, reason });
        return { handled: true, action: "task_field_missing", reason };
    }
}
