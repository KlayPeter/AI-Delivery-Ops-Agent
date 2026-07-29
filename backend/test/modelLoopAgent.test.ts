import { describe, expect, test } from 'bun:test';
import type { AgentManifest } from '@/platform/agents/contracts';
import { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';
import { AgentRegistry } from '@/platform/agents/registry';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { AgentRuntime } from '@/platform/agents/runtime';
import { BotRegistry } from '@/platform/bots/registry';
import { InMemoryDeliveryOutbox } from '@/platform/delivery/outbox';
import type { OrchestratorAdapter } from '@/platform/models/contracts';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { PersistentTriggerClaimStore } from '@/platform/runtime/persistentTriggerStore';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { TriggerRuntime } from '@/platform/runtime/triggerRuntime';
import { PersistentAgentSessionStore } from '@/platform/session/persistentStore';
import { SkillRegistry } from '@/platform/skills/registry';
import { SkillRuntime } from '@/platform/skills/runtime';
import { InMemoryToolCallStore } from '@/platform/tools/callStore';
import { ToolGateway } from '@/platform/tools/gateway';
import { ToolRegistry } from '@/platform/tools/registry';

const manifest: AgentManifest = {
    schemaVersion: '1.1',
    id: 'native.interview-agent',
    name: 'Interview Agent',
    version: '1.0.0',
    description: 'Tests a resumable model loop.',
    runtime: { type: 'model-loop', engine: 'ai-sdk' },
    capabilities: ['interview.answer'],
    triggers: ['manual'],
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    requirements: { tools: [], secrets: [], networkHosts: [] },
    limits: { timeoutSeconds: 5, maxSteps: 3, maxToolCalls: 2, maxAgentCalls: 1, maxDepth: 1, maxOutputBytes: 4096 },
    delivery: { allowedArtifactTypes: ['markdown'], directDelivery: false },
    memory: { mode: 'session', maxMessages: 20, ttlHours: 24 },
    skills: [],
};

function trigger(id: string, payload: unknown) {
    const scope = createTriggerScope({
        workspaceId: 'workspace-default',
        botInstanceId: 'bot-default',
        triggerType: 'manual',
        triggerId: id,
        conversationId: 'ou_user',
        actorId: 'ou_user',
    });
    return createTriggerEnvelope({ occurredAt: '2026-07-17T00:00:00Z', scope, payload, replyPolicy: { mode: 'none' } });
}

describe('Model Loop Agent', () => {
    test('waits for human input and resumes the same durable Run', async () => {
        let calls = 0;
        const orchestrator: OrchestratorAdapter = {
            run: async request => {
                calls++;
                await request.onStep?.({ modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 4, finishReason: 'stop' });
                if (calls === 1) return {
                    text: '',
                    needsHuman: { question: '请补充负责人', fields: ['owner'] },
                    metrics: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 4 },
                };
                return {
                    text: `已收到：${request.messages.at(-1)?.content}`,
                    metrics: { modelCalls: 1, toolCalls: 0, inputTokens: 12, outputTokens: 6 },
                };
            },
        };
        const tools = new ToolRegistry();
        const runs = new InMemoryAgentRunStore();
        const gateway = new ToolGateway(tools, new InMemoryToolCallStore(), runs);
        const skills = new SkillRegistry();
        const skillRuntime = new SkillRuntime(skills, gateway, runs);
        const sessionDatabase = new InMemoryPersistentKeyValueStore();
        const sessions = new PersistentAgentSessionStore(sessionDatabase);
        const adapter = new ModelLoopAgentAdapter(orchestrator, tools, gateway, skills, skillRuntime, sessions, runs);
        adapter.register(manifest.id, manifest.version, { instructions: 'Ask for missing fields, then answer.' });

        const registry = new AgentRegistry();
        registry.register(manifest);
        registry.install({ id: 'install-interview', workspaceId: 'workspace-default', agentId: manifest.id, version: manifest.version, status: 'active', config: {}, secretRefs: {} });
        registry.bind({ id: 'bind-interview', botInstanceId: 'bot-default', agentInstallationId: 'install-interview', enabled: true, priority: 1, capabilities: manifest.capabilities, routingConfig: {}, configOverride: {} });
        const bots = new BotRegistry([{
            id: 'bot-default', workspaceId: 'workspace-default', platform: 'feishu', name: 'default', appId: 'app', secretRef: 'secret://bot', status: 'active', config: {},
        }]);
        const runtime = new TriggerRuntime(
            new PersistentTriggerClaimStore(sessionDatabase),
            new AgentRuntime(registry, bots, runs, [adapter]),
            new InMemoryDeliveryOutbox(),
        );

        const first = await runtime.dispatch(trigger('question-1', { prompt: '创建任务' }), 'interview.answer', { prompt: '创建任务' });
        expect(first.status).toBe('processed');
        expect(first.execution?.run.status).toBe('waiting_human');
        const runId = first.execution!.run.id;
        expect(await sessions.getCheckpoint(runId)).toMatchObject({ status: 'waiting', fields: ['owner'] });

        const resumed = await runtime.resume(trigger('answer-1', { prompt: '负责人是张三' }), runId, { prompt: '负责人是张三' });
        expect(resumed.status).toBe('processed');
        expect(resumed.execution?.run.id).toBe(runId);
        expect(resumed.execution?.run.status).toBe('succeeded');
        expect(resumed.execution?.result.data).toEqual({ text: '已收到：负责人是张三' });
        expect(await sessions.getCheckpoint(runId)).toMatchObject({ status: 'completed' });
        expect((await runs.listSteps(runId)).filter(step => step.kind === 'model')).toHaveLength(2);
        expect((await runs.listSteps(runId)).filter(step => step.kind === 'agent')).toHaveLength(2);
    });

    test('restores the Tool budget from durable steps when re-entering the same Run', async () => {
        const tools = new ToolRegistry();
        tools.register({
            id: 'task.read',
            version: '1.0.0',
            description: 'Reads one task.',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
            sideEffect: 'read',
            riskLevel: 'low',
            idempotent: true,
            timeoutSeconds: 1,
        }, async () => ({ title: 'Agent platform' }));
        const runs = new InMemoryAgentRunStore();
        await runs.saveStep({
            id: 'prior-tool-step',
            runId: 'resumed-run',
            kind: 'tool',
            name: 'task.read',
            status: 'succeeded',
            startedAt: '2026-07-17T00:00:00Z',
            completedAt: '2026-07-17T00:00:01Z',
        });
        const orchestrator: OrchestratorAdapter = {
            run: async request => {
                const tool = request.tools.find(candidate => candidate.name === 'tool_task_read');
                expect(tool).toBeDefined();
                await tool!.execute({}, 'second-tool-call', request.signal);
                return {
                    text: 'unexpected',
                    metrics: { modelCalls: 1, toolCalls: 1, inputTokens: 1, outputTokens: 1 },
                };
            },
        };
        const gateway = new ToolGateway(tools, new InMemoryToolCallStore(), runs);
        const skills = new SkillRegistry();
        const sessions = new PersistentAgentSessionStore(new InMemoryPersistentKeyValueStore());
        const adapter = new ModelLoopAgentAdapter(orchestrator, tools, gateway, skills, new SkillRuntime(skills, gateway, runs), sessions, runs);
        const limitedManifest: AgentManifest = {
            ...manifest,
            id: 'limited-agent',
            requirements: { ...manifest.requirements, tools: ['task.read'] },
            limits: { ...manifest.limits, maxToolCalls: 1 },
        };
        adapter.register(limitedManifest.id, limitedManifest.version, { instructions: 'Read the task.' });
        const scope = {
            workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual' as const, triggerId: 'resume-trigger',
            conversationId: 'ou_user', actorId: 'ou_user', locale: 'zh-CN', timezone: 'Asia/Shanghai',
            agentInstallationId: 'install-limited', correlationId: 'resumed-run',
        };
        const resolved = {
            manifest: limitedManifest,
            installation: { id: 'install-limited', workspaceId: 'workspace-default', agentId: limitedManifest.id, version: limitedManifest.version, status: 'active' as const, config: {}, secretRefs: {} },
            binding: { id: 'bind-limited', botInstanceId: 'bot-default', agentInstallationId: 'install-limited', enabled: true, priority: 1, capabilities: limitedManifest.capabilities, routingConfig: {}, configOverride: {} },
        };

        await expect(adapter.execute({
            runId: 'resumed-run',
            scope,
            capability: 'interview.answer',
            input: { prompt: 'continue' },
            deadlineAt: new Date(Date.now() + 5000).toISOString(),
            traceContext: { correlationId: 'resumed-run' },
        }, resolved, new AbortController().signal)).rejects.toMatchObject({
            code: 'TOOL_CALL_LIMIT_EXCEEDED',
            retryable: false,
        });
        expect((await runs.listSteps('resumed-run')).filter(step => step.kind === 'tool')).toHaveLength(1);
        expect((await runs.listSteps('resumed-run')).filter(step => step.kind === 'guardrail')).toHaveLength(1);
    });

    test('exposes allowlisted child Agents as tools and promotes non-text child Artifacts', async () => {
        let delegated = 0;
        const orchestrator: OrchestratorAdapter = {
            run: async request => {
                const childTool = request.tools.find(tool => tool.name === 'agent_child_run');
                expect(childTool).toBeDefined();
                const child = await childTool!.execute({ prompt: 'generate' }, 'tool-call-1', request.signal);
                return {
                    text: `child status: ${(child as any).status}`,
                    metrics: { modelCalls: 1, toolCalls: 1, inputTokens: 10, outputTokens: 5 },
                };
            },
        };
        const tools = new ToolRegistry();
        const runs = new InMemoryAgentRunStore();
        const gateway = new ToolGateway(tools, new InMemoryToolCallStore(), runs);
        const skills = new SkillRegistry();
        const sessions = new PersistentAgentSessionStore(new InMemoryPersistentKeyValueStore());
        const adapter = new ModelLoopAgentAdapter(orchestrator, tools, gateway, skills, new SkillRuntime(skills, gateway, runs), sessions, runs);
        const parentManifest: AgentManifest = {
            ...manifest,
            id: 'main-agent',
            capabilities: ['main.run'],
            delegates: ['child.run'],
            delivery: { allowedArtifactTypes: ['markdown', 'image'], directDelivery: false },
        };
        adapter.register(parentManifest.id, parentManifest.version, { instructions: 'Delegate the request.' });
        adapter.setDelegateExecutor({
            describeDelegate: () => ({ name: 'Child Agent', description: 'Generates an image.', inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } }),
            delegate: async () => {
                delegated++;
                return {
                    run: {
                        id: 'child-run', workspaceId: 'workspace-default', botInstanceId: 'bot-default', agentInstallationId: 'install-child',
                        capability: 'child.run', triggerId: 'delegate-1', correlationId: 'root-run', rootRunId: 'root-run', parentRunId: 'root-run',
                        depth: 1, status: 'succeeded', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
                    },
                    result: { status: 'succeeded', data: { ok: true }, artifacts: [] },
                    artifacts: [{
                        id: 'artifact-image', runId: 'child-run', type: 'image', mediaType: 'image/png', schemaVersion: '1.0',
                        content: '/tmp/dashboard.png', metadata: { title: 'Dashboard' }, createdAt: new Date().toISOString(),
                    }],
                };
            },
        });
        const scope = {
            workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual' as const, triggerId: 'root-trigger',
            conversationId: 'ou_user', actorId: 'ou_user', locale: 'zh-CN', timezone: 'Asia/Shanghai',
            agentInstallationId: 'install-main', correlationId: 'root-run',
        };
        const resolved = {
            manifest: parentManifest,
            installation: { id: 'install-main', workspaceId: 'workspace-default', agentId: parentManifest.id, version: parentManifest.version, status: 'active' as const, config: {}, secretRefs: {} },
            binding: { id: 'bind-main', botInstanceId: 'bot-default', agentInstallationId: 'install-main', enabled: true, priority: 1, capabilities: parentManifest.capabilities, routingConfig: {}, configOverride: {} },
        };
        const result = await adapter.execute({
            runId: 'root-run', scope, capability: 'main.run', input: { prompt: 'generate dashboard' },
            deadlineAt: new Date(Date.now() + 5000).toISOString(), traceContext: { correlationId: 'root-run' },
        }, resolved, new AbortController().signal);

        expect(delegated).toBe(1);
        expect(result.data).toEqual({ text: 'child status: succeeded' });
        expect(result.artifacts.find(artifact => artifact.type === 'image')).toMatchObject({
            content: '/tmp/dashboard.png', metadata: { title: 'Dashboard', delegatedFromRunId: 'child-run' },
        });
    });
});
