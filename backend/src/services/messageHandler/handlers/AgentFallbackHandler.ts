import { utcNowIso, type SourceMessage } from '@/models/types';
import { reply } from '../statusUpdates';
import type { HandlerContext } from '../types';

export class AgentFallbackHandler {
    static async maybeHandle(
        ctx: HandlerContext,
        message: SourceMessage,
        source: 'group' | 'private',
        replyContext: unknown,
    ): Promise<any> {
        if (!ctx.agentOrchestrator?.isAvailable()) return null;
        try {
            const outcome = await ctx.agentOrchestrator.handle(message, source, replyContext);
            return this.deliver(ctx, message, source, outcome);
        } catch (error: any) {
            await ctx.store.appendAuditLog('agent_orchestrator_failed', {
                message_id: message.id,
                error: error?.message || String(error),
                code: error?.code || 'AGENT_ORCHESTRATOR_ERROR',
            });
            await reply(ctx, message, source, 'Agent 暂时无法完成该请求，现有任务、站会、日报和看板指令仍可正常使用，请稍后重试。');
            return { handled: true, action: 'agent_orchestrator_failed', error: error?.message || String(error) };
        }
    }

    static async maybeResume(
        ctx: HandlerContext,
        message: SourceMessage,
        source: 'group' | 'private',
        replyContext: any,
    ): Promise<any> {
        if (replyContext?.context_type !== 'agent_checkpoint') return null;
        const runId = String(replyContext.metadata?.run_id || '');
        if (!runId || !ctx.agentOrchestrator?.isAvailable()) {
            await reply(ctx, message, source, '上一次 Agent 会话当前无法恢复，请重新发送完整请求。');
            return { handled: true, action: 'agent_resume_unavailable', run_id: runId || undefined };
        }
        try {
            const outcome = await ctx.agentOrchestrator.resume(runId, message, source);
            return this.deliver(ctx, message, source, outcome);
        } catch (error: any) {
            await ctx.store.appendAuditLog('agent_resume_failed', {
                message_id: message.id,
                run_id: runId,
                error: error?.message || String(error),
                code: error?.code || 'AGENT_RESUME_ERROR',
            });
            await reply(ctx, message, source, 'Agent 会话恢复失败，请重新发送完整请求。');
            return { handled: true, action: 'agent_resume_failed', run_id: runId, error: error?.message || String(error) };
        }
    }

    private static async deliver(
        ctx: HandlerContext,
        message: SourceMessage,
        source: 'group' | 'private',
        outcome: { runId: string; status: 'waiting_human' | 'succeeded'; text: string },
    ): Promise<any> {
        const receipt = await reply(ctx, message, source, outcome.text);
        if (outcome.status === 'waiting_human' && receipt?.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: receipt.message_id,
                context_type: 'agent_checkpoint',
                created_at: utcNowIso(),
                chat_id: receipt.chat_id || message.chat_id,
                chat_type: source === 'group' ? 'group' : 'p2p',
                target_open_id: message.sender_open_id,
                metadata: { run_id: outcome.runId },
            });
        }
        await ctx.store.appendAuditLog('agent_orchestrator_replied', {
            message_id: message.id,
            run_id: outcome.runId,
            status: outcome.status,
        });
        return {
            handled: true,
            action: outcome.status === 'waiting_human' ? 'agent_waiting_human' : 'agent_orchestrated',
            run_id: outcome.runId,
        };
    }
}
