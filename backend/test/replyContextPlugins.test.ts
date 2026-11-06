import { expect, test } from 'bun:test';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { MessageRouteRegistry } from '@/services/messageHandler/routes';
import { ContextResolver } from '@/services/messageHandler/ContextResolver';
import { taskPlugin } from '@/agents/plugins/task';
import { buildConfig } from '@/core/config';

function fixture() {
    let reads = 0, beforeRead: (() => Promise<void>) | undefined;
    const tasks = [{ id: 'task-one', title: 'Original task', source_message_id: 'source-direct', tapd_story_id: 'story-one' }, { id: 'task-two', title: 'Updated task', source_message_id: 'unrelated' }];
    const sources: Record<string, any> = { 'source-ai': { ai_result: { taskId: 'task-two' } }, 'source-ai-fallback': { ai_result: { task_id: 42, taskId: 'task-two' } }, child: { parent_id: 'source-direct' }, cycle: { parent_id: 'cycle' } };
    const store = Object.assign(new InMemoryPersistentKeyValueStore(), {
        listTasks: async () => { reads++; await beforeRead?.(); return tasks; }, listTaskUpdates: async () => [{ task_id: 'task-two', source_message_id: 'source-update' }],
        getTask: async (id: string) => tasks.find(task => task.id === id), getBotMessageContext: async (): Promise<null> => null,
        getSourceMessage: async (id: string) => sources[id] || null,
    });
    const ctx: any = { store, config: buildConfig({}), feishu: {}, tapd: {}, messageRoutes: new MessageRouteRegistry() };
    const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: [taskPlugin], messageRoutes: ctx.messageRoutes });
    return { ctx, host, tasks, resolver: new ContextResolver(ctx), reads: () => reads, block: (fn: () => Promise<void>) => { beforeRead = fn; } };
}
const message = (parent_id: string) => ({ parent_id, root_id: parent_id }) as any;

test('an empty message registry does not infer or read legacy task state', async () => {
    const f = fixture();
    expect(await f.resolver.resolveReplyContext(message('source-direct'))).toBeNull(); expect(f.reads()).toBe(0); expect(f.tasks).toHaveLength(2);
});

test('the installed task plugin preserves direct, update, AI-result and chained reply inference', async () => {
    const f = fixture(); await f.host.initialize();
    try {
        for (const [source, id] of [['source-direct', 'task-one'], ['source-update', 'task-two'], ['source-ai', 'task-two'], ['source-ai-fallback', 'task-two'], ['child', 'task-one']]) {
            expect(await f.resolver.resolveReplyContext(message(source!))).toMatchObject({ context_type: 'task_thread', task_id: id });
        }
        expect(await f.resolver.resolveReplyContext(message('cycle'))).toBeNull();
    } finally { await f.host.stop(); }
    const emptyContext = { ...f.ctx, messageRoutes: new MessageRouteRegistry() }, before = f.reads();
    expect(await new ContextResolver(emptyContext).resolveReplyContext(message('source-direct'))).toBeNull(); expect(f.reads()).toBe(before); expect(f.tasks).toHaveLength(2);
});

test('stopping the Host waits for accepted plugin reply-context lookup before releasing routes', async () => {
    const f = fixture(); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.block(async () => { entered(); await gate; }); await f.host.initialize();
    const pending = f.resolver.resolveReplyContext(message('source-direct')); await ready;
    let stopped = false; const stopping = f.host.stop().then(() => { stopped = true; });
    try { await Promise.resolve(); expect(stopped).toBe(false); }
    finally { release(); expect(await pending).toMatchObject({ task_id: 'task-one' }); await stopping; }
    expect(f.ctx.messageRoutes.list()).toEqual([]);
});


test('reply lookup declarations require a function on the context phase', () => {
    const registry = new MessageRouteRegistry(), base = { id: 'example.lookup', priority: 1, sources: ['group'] as const, handle: async (): Promise<null> => null };
    expect(() => registry.register({ ...base, lookupContext: async (): Promise<null> => null })).toThrow();
    expect(() => registry.register({ ...base, phase: 'context', matches: () => true, lookupContext: 'invalid' as any })).toThrow();
});
