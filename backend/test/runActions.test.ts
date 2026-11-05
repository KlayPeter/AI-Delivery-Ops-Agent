import { describe, expect, test } from 'bun:test';
import type { AgentRun } from '@/platform/agents/contracts';
import { RunActionRegistry, statusPanelSchema } from '@/platform/plugins/runActions';
import { knowledgeReviewPanel } from '@/knowledge/impact/presentation';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { echoPlugin } from '../examples/plugins/echo';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import { randomUUID } from 'node:crypto';

const run = { capability: 'example.echo', status: 'succeeded' } as AgentRun;
const panel = { schemaVersion: '1.0' as const, tone: 'neutral' as const, title: 'Ready' };
const action = { id: 'example.followup', label: 'Follow up', capability: 'example.echo', appliesTo: ['example.echo'], input: (runId: string) => ({ text: runId }), readState: () => panel };

describe('plugin run actions', () => {
    test('validates unique actions, limits them to matching successful runs and disposes registrations', () => {
        const registry = new RunActionRegistry(), dispose = registry.register(action);
        expect(registry.forRun(run).map(item => item.id)).toEqual([action.id]);
        expect(registry.forRun({ ...run, status: 'failed' })).toEqual([]);
        expect(registry.forRun({ ...run, capability: 'other' })).toEqual([]);
        expect(() => registry.register(action)).toThrow('Duplicate');
        expect(() => registry.register({ ...action, id: '../invalid' })).toThrow();
        expect(() => registry.register({ ...action, id: 'example.empty', appliesTo: [] })).toThrow();
        expect(() => registry.register({ ...action, id: 'example.bad', readState: null as any })).toThrow('handlers');
        dispose(); dispose(); expect(registry.forRun(run)).toEqual([]);
    });

    test('rejects invalid status panels and refuses a green assessment without checked evidence', () => {
        expect(statusPanelSchema.safeParse({ ...panel, tone: 'green' }).success).toBe(false);
        expect(statusPanelSchema.safeParse({ ...panel, relatedRun: { id: '', label: 'run' } }).success).toBe(false);
        expect(() => knowledgeReviewPanel({ runId: 'target', state: 'current', references: [] })).toThrow();
        expect(knowledgeReviewPanel({ runId: 'target', state: 'unverifiable', reason: 'not_checked' })).toMatchObject({ tone: 'neutral', title: '知识引用尚未检查' });
        expect(knowledgeReviewPanel({ runId: 'target', state: 'unverifiable', reason: 'check_incomplete', checkRunId: 'check' })).toMatchObject({ tone: 'warning', title: '知识引用检查尚未完成' });
    });

    test('Host waits for an in-flight action state read before releasing plugin resources', async () => {
        const store = new InMemoryPersistentKeyValueStore();
        let entered!: () => void, release!: () => void, disposed = false;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const finish = new Promise<void>(resolve => { release = resolve; });
        const plugin: FeaturePlugin = { ...echoPlugin, apply(ctx, config) {
            echoPlugin.apply(ctx, config);
            ctx.effect(() => () => { disposed = true; });
            ctx.delivery.runActions.register({ ...action, readState: async () => { entered(); await finish; expect(disposed).toBe(false); return panel; } });
        } };
        const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'test', app_id: '' }, ai: {} }, feishu: {}, tapd: {} } as any), 1000, undefined, [], { plugins: [plugin] });
        const result = await host.runLocal('example.echo', { text: 'result' }, randomUUID());
        const state = host.getLocalRunActions(result.execution!.run.id);
        await reading;
        const stopping = host.stop(); await Promise.resolve();
        expect(disposed).toBe(false); release();
        expect((await state)![0]!.panel).toEqual(panel);
        await stopping;
        expect(disposed).toBe(true); expect(host.runActions.forRun(run)).toEqual([]);
        await expect(host.getLocalRunActions(result.execution!.run.id)).rejects.toThrow('stopped');
    });
});
