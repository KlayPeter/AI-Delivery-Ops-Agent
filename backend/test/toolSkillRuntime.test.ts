import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { SkillPackageLoader } from '@/platform/skills/packageLoader';
import { SkillRegistry } from '@/platform/skills/registry';
import { SkillRuntime } from '@/platform/skills/runtime';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { InMemoryToolCallStore } from '@/platform/tools/callStore';
import { ToolGateway } from '@/platform/tools/gateway';
import { ToolRegistry } from '@/platform/tools/registry';
import { createExecutionScope, createTriggerScope } from '@/platform/runtime/scope';

function executionScope() {
    return createExecutionScope(createTriggerScope({
        workspaceId: 'workspace-default',
        botInstanceId: 'bot-default',
        triggerType: 'manual',
        triggerId: 'tool-skill-test',
        actorId: 'ou_user',
    }), 'install-test-agent', { correlationId: 'correlation-1' });
}

describe('Tool and Skill runtime', () => {
    test('does not enter a handler when cancelled before execution or during the ledger claim', async () => {
        for (const phase of ['before', 'claim']) {
            const controller = new AbortController();
            const registry = new ToolRegistry();
            let invoked = 0;
            registry.register({
                id: 'test.cancel', version: '1.0.0', description: 'Cancellation boundary', inputSchema: {}, outputSchema: {},
                sideEffect: 'write', riskLevel: 'high', idempotent: true, timeoutSeconds: 1,
            }, async () => { invoked++; return {}; });
            const calls = new InMemoryToolCallStore();
            const claim = calls.claim.bind(calls);
            let claimed = false;
            calls.claim = async (...args) => {
                claimed = true;
                const result = await claim(...args);
                controller.abort();
                return result;
            };
            if (phase === 'before') controller.abort();
            const gateway = new ToolGateway(registry, calls);
            await expect(gateway.execute('test.cancel', {}, {
                runId: 'cancel-run', agentId: 'cancel-agent', scope: executionScope(), allowedTools: ['test.cancel'],
                idempotencyKey: 'cancel-key', signal: controller.signal,
            })).rejects.toMatchObject({ code: 'TOOL_CANCELLED', retryable: false });
            expect(invoked).toBe(0);
            expect(claimed).toBe(phase === 'claim');
        }
    });

    test('validates, traces, and deduplicates an idempotent write Tool', async () => {
        const registry = new ToolRegistry();
        let writes = 0;
        registry.register({
            id: 'task.note.write',
            version: '1.0.0',
            description: 'Writes a deterministic task note.',
            inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
            outputSchema: { type: 'object', required: ['saved'], properties: { saved: { type: 'boolean' } } },
            sideEffect: 'write',
            riskLevel: 'medium',
            idempotent: true,
            timeoutSeconds: 1,
        }, async () => { writes++; return { saved: true }; });
        const runs = new InMemoryAgentRunStore();
        const gateway = new ToolGateway(registry, new InMemoryToolCallStore(), runs);
        const budget = new RunToolCallBudget(1);
        const options = {
            runId: 'run-1',
            agentId: 'task-agent',
            scope: executionScope(),
            allowedTools: ['task.note.write'],
            idempotencyKey: 'message-1:note-1',
            budget,
        };
        expect(await gateway.execute('task.note.write', { text: 'done' }, options)).toEqual({ saved: true });
        expect(await gateway.execute('task.note.write', { text: 'done' }, options)).toEqual({ saved: true });
        expect(writes).toBe(1);
        expect(budget.used).toBe(1);
        expect((await runs.listSteps('run-1')).filter(step => step.kind === 'tool')).toHaveLength(1);
        await expect(gateway.execute('task.note.write', { text: 'again' }, {
            ...options,
            idempotencyKey: 'message-2:note-2',
        })).rejects.toMatchObject({ code: 'TOOL_CALL_LIMIT_EXCEEDED', retryable: false });
        expect((await runs.listSteps('run-1')).filter(step => step.kind === 'guardrail')).toHaveLength(1);
        await expect(gateway.execute('task.note.write', {}, { ...options, idempotencyKey: 'message-2' })).rejects.toThrow("required property 'text'");
        await expect(gateway.execute('task.note.write', { text: 'x' }, { ...options, allowedTools: [] })).rejects.toThrow('Tool is not allowed');
    });

    test('executes a native Skill with only its declared Tools', async () => {
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
        const gateway = new ToolGateway(tools, new InMemoryToolCallStore(), runs);
        const skills = new SkillRegistry();
        skills.register({
            schemaVersion: '1.0',
            id: 'task.describe',
            version: '1.0.0',
            name: 'Describe Task',
            description: 'Reads and describes one task.',
            execution: { type: 'native' },
            instructionsRef: 'SKILL.md',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
            allowedTools: ['task.read'],
            compatibleAgents: ['task-agent'],
            riskLevel: 'low',
            maxToolCalls: 1,
            timeoutSeconds: 1,
        }, 'Read the task and return a concise description.', async (_input, context) => {
            const task = await context.tools.execute('task.read', {}) as { title: string };
            return { summary: task.title };
        });
        const runtime = new SkillRuntime(skills, gateway, runs);
        expect(await runtime.execute({
            runId: 'run-skill',
            agentId: 'task-agent',
            scope: executionScope(),
            skillId: 'task.describe',
            input: {},
        })).toEqual({ summary: 'Agent platform' });
        expect((await runs.listSteps('run-skill')).map(step => step.kind).sort()).toEqual(['skill', 'tool']);
        await expect(runtime.execute({
            runId: 'run-skill-limited',
            agentId: 'task-agent',
            scope: executionScope(),
            skillId: 'task.describe',
            input: {},
            budget: new RunToolCallBudget(0),
        })).rejects.toMatchObject({ code: 'TOOL_CALL_LIMIT_EXCEEDED', retryable: false });
        expect((await runs.listSteps('run-skill-limited')).map(step => step.kind).sort()).toEqual(['guardrail', 'skill']);
        await expect(runtime.execute({
            runId: 'run-wrong-agent',
            agentId: 'standup-agent',
            scope: executionScope(),
            skillId: 'task.describe',
            input: {},
        })).rejects.toThrow('not compatible');
    });

    test('loads prompt Skill metadata and instructions from a confined package', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'skills-'));
        const packageRoot = path.join(root, 'daily-summary');
        await mkdir(packageRoot);
        await writeFile(path.join(packageRoot, 'manifest.yaml'), [
            'schemaVersion: "1.0"',
            'id: daily-summary.compose',
            'version: 1.0.0',
            'name: Daily Summary Compose',
            'description: Compose a daily summary.',
            'execution:',
            '  type: prompt',
            'instructionsRef: SKILL.md',
            'inputSchema:',
            '  type: object',
            'outputSchema:',
            '  type: object',
            'allowedTools: []',
            'compatibleAgents: ["daily-summary-agent"]',
            'riskLevel: low',
            'maxToolCalls: 0',
            'timeoutSeconds: 10',
        ].join('\n'));
        await writeFile(path.join(packageRoot, 'SKILL.md'), '# Daily Summary\n\nCompose only from supplied facts.');
        const registry = new SkillRegistry();
        expect(await new SkillPackageLoader(registry).loadDirectory(root)).toBe(1);
        expect(registry.list('daily-summary-agent')).toEqual([expect.objectContaining({ id: 'daily-summary.compose', version: '1.0.0' })]);
        expect(registry.resolve('daily-summary.compose', 'daily-summary-agent').instructions).toContain('supplied facts');
    });
});
