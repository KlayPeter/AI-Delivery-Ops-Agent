import { SourceMessage } from '@/models/types';
import { ContextResolver } from './ContextResolver';
import { HandlerContext } from './types';
import { StandupHandler } from './handlers/StandupHandler';
import { StatusUpdateHandler } from './handlers/StatusUpdateHandler';
import { TaskCommandHandler } from './handlers/TaskCommandHandler';
import { looksLikeStandup } from '@/services/standup';
import { AgentFallbackHandler } from './handlers/AgentFallbackHandler';

const STANDUP_CONTEXT_TYPES = new Set([
    "standup_prompt",
    "standup_receipt",
]);

const TASK_CONTEXT_TYPES = new Set([
    "task_confirmation",
    "task_plan_request",
    "task_group_notice",
    "task_acceptance_prompt",
    "missing_task_field",
    "task_status_notice",
    "task_thread",
    "pending_primary_owner",
]);

export class ContextRouter {
    static async maybeHandle(
        ctx: HandlerContext,
        resolver: ContextResolver,
        message: SourceMessage,
        source: "group" | "private",
        replyContext: any
    ): Promise<any> {
        if (!replyContext?.context_type) return null;

        if (replyContext.context_type === 'agent_checkpoint') {
            return AgentFallbackHandler.maybeResume(ctx, message, source, replyContext);
        }

        // A structured standup must never be consumed as a task status update just
        // because the user replied in a task thread.
        if (STANDUP_CONTEXT_TYPES.has(replyContext.context_type) || looksLikeStandup(message.text || "")) {
            return await StandupHandler.maybeHandle(ctx, message, source, replyContext);
        }

        if (TASK_CONTEXT_TYPES.has(replyContext.context_type)) {
            const statusResult = await StatusUpdateHandler.maybeHandle(ctx, resolver, message, source, replyContext);
            if (statusResult) return statusResult;
            return await TaskCommandHandler.maybeHandle(ctx, resolver, message, source, replyContext);
        }

        return null;
    }
}
