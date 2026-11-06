import type { HandlerContext } from '@/services/messageHandler/types';

export async function lookupTaskReplyContext(ctx: HandlerContext, messageId: string): Promise<any> {
    let task = (await ctx.store.listTasks(true)).find(item => item.source_message_id === messageId);
    if (!task) {
        for (const update of await ctx.store.listTaskUpdates()) {
            if (update.source_message_id !== messageId) continue;
            task = await ctx.store.getTask(update.task_id) || undefined;
            if (task) break;
        }
    }
    if (!task) {
        const source = await ctx.store.getSourceMessage(messageId), result = source?.ai_result;
        const id = result && typeof result === 'object' ? [result.task_id, result.taskId, result.task?.id].find(value => typeof value === 'string' && value) : undefined;
        if (typeof id === 'string' && id) task = await ctx.store.getTask(id) || undefined;
    }
    return task ? { context_type: 'task_thread', task_id: task.id, task_title: task.title, metadata: { tapd_story_id: task.tapd_story_id } } : null;
}
