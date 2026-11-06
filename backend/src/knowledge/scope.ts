import type { TriggerScope } from '@/platform/runtime/scope';

export function requirePersonalScope(scope: TriggerScope): void {
    if (scope.chatId || scope.conversationId || !['manual', 'agent'].includes(scope.triggerType)) {
        throw new Error('Personal knowledge currently requires a local manual scope without a chat or conversation');
    }
}

export function requirePersonalVersionScope(scope: TriggerScope): void {
    if (scope.triggerType === 'schedule' && !scope.chatId && !scope.conversationId) return;
    requirePersonalScope(scope);
}
