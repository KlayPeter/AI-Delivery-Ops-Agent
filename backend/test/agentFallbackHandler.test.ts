import { describe, expect, test } from 'bun:test';
import { AgentFallbackHandler } from '@/services/messageHandler/handlers/AgentFallbackHandler';
import type { SourceMessage } from '@/models/types';

const message: SourceMessage = {
    id: 'om_user', chat_id: 'oc_group', chat_type: 'group', sender_open_id: 'ou_user', sender_name: 'User',
    text: '帮我综合处理一下', message_type: 'text', sent_at: new Date().toISOString(), raw_payload: {}, mentions: [],
};

describe('Agent fallback message bridge', () => {
    test('keeps the legacy unrecognized path when the model Agent is unavailable', async () => {
        const ctx: any = { agentOrchestrator: { isAvailable: () => false } };
        expect(await AgentFallbackHandler.maybeHandle(ctx, message, 'group', null)).toBeNull();
    });

    test('persists a resumable reply context when the main Agent needs human input', async () => {
        const contexts: any[] = [];
        const audits: any[] = [];
        const ctx: any = {
            agentOrchestrator: {
                isAvailable: () => true,
                handle: async () => ({ runId: 'run-root', status: 'waiting_human', text: '请补充负责人' }),
            },
            feishu: { sendReplyText: async () => ({ message_id: 'om_bot', chat_id: 'oc_group' }) },
            store: {
                saveBotMessageContext: async (value: any) => contexts.push(value),
                appendAuditLog: async (action: string, payload: any) => audits.push({ action, payload }),
            },
        };

        const result = await AgentFallbackHandler.maybeHandle(ctx, message, 'group', null);
        expect(result).toMatchObject({ action: 'agent_waiting_human', run_id: 'run-root' });
        expect(contexts[0]).toMatchObject({ context_type: 'agent_checkpoint', metadata: { run_id: 'run-root' } });
        expect(audits.at(-1)).toMatchObject({ action: 'agent_orchestrator_replied', payload: { run_id: 'run-root', status: 'waiting_human' } });
    });

    test('resumes the same root Run from an Agent checkpoint reply', async () => {
        let resumedRunId = '';
        const ctx: any = {
            agentOrchestrator: {
                isAvailable: () => true,
                resume: async (runId: string) => { resumedRunId = runId; return { runId, status: 'succeeded', text: '处理完成' }; },
            },
            feishu: { sendPrivateText: async () => ({ message_id: 'om_done', chat_id: 'oc_private' }) },
            store: { appendAuditLog: async () => {} },
        };
        const privateMessage = { ...message, chat_type: 'p2p', chat_id: 'oc_private' };
        const result = await AgentFallbackHandler.maybeResume(ctx, privateMessage, 'private', { context_type: 'agent_checkpoint', metadata: { run_id: 'run-root' } });
        expect(resumedRunId).toBe('run-root');
        expect(result).toMatchObject({ action: 'agent_orchestrated', run_id: 'run-root' });
    });
});
