import type { AgentError } from '@/platform/agents/contracts';

export const interruptedByRestart = (): AgentError => ({
    code: 'PROCESS_RESTARTED',
    message: 'Host restarted before execution completed; the operation was not replayed',
    retryable: false,
});
