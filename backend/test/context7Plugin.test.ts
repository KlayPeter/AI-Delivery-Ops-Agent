import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readAgentSkill } from '@/platform/skills/packageLoader';
import type { AgentSkillGrants } from '@/platform/skills/packageLoader';
import { SkillRegistry } from '@/platform/skills/registry';
import { SkillRuntime } from '@/platform/skills/runtime';
import { OrchestratedPromptSkillExecutor } from '@/platform/skills/promptExecutor';
import { InMemoryAgentRunStore } from '@/platform/agents/runStore';
import { ToolRegistry } from '@/platform/tools/registry';
import { ToolGateway } from '@/platform/tools/gateway';
import { InMemoryToolCallStore } from '@/platform/tools/callStore';
import { RunToolCallBudget } from '@/platform/tools/budget';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { buildConfig } from '@/core/config';
import { createExecutionScope, createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { CONTEXT7_CAPABILITY, CONTEXT7_SKILL, context7Plugin } from '@/connectors/context7/plugin';
import type { FeaturePlugin } from '@/platform/plugins/contracts';

const grants: AgentSkillGrants = { id: 'imported.docs', version: '1.0.0', inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
    allowedTools: ['mcp.context7.docs'], compatibleAgents: ['test.reader'], riskLevel: 'medium', maxToolCalls: 2, timeoutSeconds: 5 };
const upstream = path.resolve(import.meta.dir, '../src/connectors/context7/upstream/context7-mcp');
const trigger = (id: string, payload: unknown) => createTriggerEnvelope({ occurredAt: new Date().toISOString(),
    scope: createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: id }), payload, replyPolicy: { mode: 'none' } });

test('standard SKILL.md imports metadata and instructions without taking tool grants or execution policy from frontmatter', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-import-')), dir = path.join(root, 'community-docs'); await mkdir(dir);
    try {
        await writeFile(path.join(dir, 'SKILL.md'), '---\r\nname: community-docs\r\ndescription: Fetch API references\r\nallowed-tools: Bash(*)\r\nallowedTools: [shell.execute]\r\ncompatibleAgents: ["*"]\r\nexecution: {type: native}\r\n---\r\n# Read the supplied evidence.');
        const imported = await readAgentSkill(dir, grants);
        expect(imported.manifest).toMatchObject({ id: grants.id, name: 'community-docs', description: 'Fetch API references', execution: { type: 'prompt' }, allowedTools: grants.allowedTools, compatibleAgents: ['test.reader'], maxToolCalls: 2 });
        expect(imported.instructions).toBe('# Read the supplied evidence.');
        const registry = new SkillRegistry(); registry.register(imported.manifest, imported.instructions);
        expect(() => registry.resolve(grants.id, 'other-agent')).toThrow('not compatible');
        const unicode = path.join(root, '文档-查询'); await mkdir(unicode);
        await writeFile(path.join(unicode, 'SKILL.md'), '---\nname: 文档-查询\ndescription: 中文文档检索\n---\n读取来源。');
        expect((await readAgentSkill(unicode, grants)).manifest.name).toBe('文档-查询');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Agent Skill import rejects invalid metadata, directory mismatches, oversize files and file symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-invalid-')), dir = path.join(root, 'valid-skill'); await mkdir(dir);
    const filename = path.join(dir, 'SKILL.md');
    try {
        for (const content of ['# no frontmatter', '---\nname: Wrong\ndescription: Invalid name\n---\nbody', '---\nname: other-name\ndescription: Mismatch\n---\nbody', '---\nname: valid-skill\ndescription: ""\n---\nbody', '---\nname: valid-skill\ndescription: Empty body\n---\n']) {
            await writeFile(filename, content); await expect(readAgentSkill(dir, grants)).rejects.toThrow();
        }
        await writeFile(filename, '---\nname: valid-skill\ndescription: Bounded UTF-8\nignored: ' + '文'.repeat(3000) + '\n---\nbody');
        await expect(readAgentSkill(dir, grants)).rejects.toThrow('bounded YAML');
        await writeFile(filename, 'x'.repeat(128 * 1024 + 1)); await expect(readAgentSkill(dir, grants)).rejects.toThrow('128 KiB');
        await rm(filename); await writeFile(path.join(root, 'outside.md'), '---\nname: valid-skill\ndescription: Link\n---\nbody');
        await symlink(path.join(root, 'outside.md'), filename); await expect(readAgentSkill(dir, grants)).rejects.toThrow('regular');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('upstream Context7 Skill executes through the existing prompt runtime, scoped Tool Gateway and shared budget', async () => {
    const imported = await readAgentSkill(upstream, { ...grants, allowedTools: ['mcp.context7.resolve', 'mcp.context7.docs'] });
    expect(imported.manifest.name).toBe('context7-mcp'); expect(imported.instructions).toContain('Step 1: Resolve the Library ID');
    const tools = new ToolRegistry(), queries: unknown[] = [], runs = new InMemoryAgentRunStore();
    for (const id of imported.manifest.allowedTools) tools.register({ id, version: '1.0.0', description: 'Documentation fixture', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 1 }, async input => { queries.push(input); return { content: [{ type: 'text', text: 'Source: https://react.dev/reference/react/useEffect' }] }; });
    const registry = new SkillRegistry(); registry.register(imported.manifest, imported.instructions);
    const gateway = new ToolGateway(tools, new InMemoryToolCallStore(), runs), budget = new RunToolCallBudget(2);
    const runtime = new SkillRuntime(registry, gateway, runs, new OrchestratedPromptSkillExecutor({ run: async request => {
        expect(request.instructions).toContain(imported.instructions);
        await request.tools.find(tool => tool.name === 'mcp_context7_resolve')!.execute({ libraryName: 'React', query: 'cleanup' }, 'resolve-1');
        await request.tools.find(tool => tool.name === 'mcp_context7_docs')!.execute({ libraryId: '/reactjs/react.dev', query: 'cleanup' }, 'docs-1');
        return { text: 'See https://react.dev/reference/react/useEffect', metrics: { modelCalls: 1, toolCalls: 2 } };
    } }, tools, runs));
    const scope = createExecutionScope(createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: 'skill-import' }), 'install-test');
    expect(await runtime.execute({ runId: 'import-run', agentId: 'test.reader', scope, skillId: grants.id, input: {}, budget })).toContain('https://react.dev');
    expect(queries).toHaveLength(2); expect(budget.used).toBe(2);
    expect((await runs.listSteps('import-run')).filter(step => step.kind === 'skill' && step.status === 'succeeded')).toHaveLength(1);
    expect((await runs.listSteps('import-run')).filter(step => step.kind === 'tool')).toHaveLength(2);
});

test('Context7 plugin contributes working native queries, an imported Skill and a model assistant without frontend changes', async () => {
    const calls: Array<{ id: string; input: unknown }> = [];
    let empty = false;
    const connector: FeaturePlugin = { manifest: { apiVersion: '1.0', id: 'connector.mcp', name: 'Fixture', version: '1.0.0', description: 'Offline MCP fixture' }, apply(ctx) {
        for (const id of ['mcp.context7.resolve', 'mcp.context7.docs']) ctx.delivery.tools.register({ id, version: '1.0.0', description: 'Fixture', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', riskLevel: 'medium', idempotent: true, timeoutSeconds: 1 }, async input => { calls.push({ id, input }); return { content: empty ? [] : [{ type: 'text', text: 'Source: https://react.dev/reference/react/useEffect' }] }; });
    } };
    const context = { store: new InMemoryPersistentKeyValueStore(), config: buildConfig({}), feishu: {}, tapd: {} } as any;
    const host = new AgentHost(() => context, 1000, undefined, [], { plugins: [context7Plugin, connector] });
    try {
        await host.initialize();
        expect(host.web.pages()).toMatchObject([{ path: '/context7', view: { capability: CONTEXT7_CAPABILITY } }]);
        expect(await host.listSkills('community.context7-assistant')).toEqual(expect.arrayContaining([expect.objectContaining({ id: CONTEXT7_SKILL, version: '4.5.0' })]));
        const queried = await host.dispatch(trigger('ctx7-query', {}), CONTEXT7_CAPABILITY, { prompt: 'useEffect cleanup' });
        expect(queried.execution?.run.status).toBe('succeeded'); expect(queried.execution?.result.metrics).toMatchObject({ modelCalls: 0, toolCalls: 1 });
        expect(queried.execution?.result.artifacts?.[0]?.content).toContain('<https://react.dev/reference/react/useEffect>');
        expect(calls[0]).toEqual({ id: 'mcp.context7.docs', input: { libraryId: '/reactjs/react.dev', query: 'useEffect cleanup' } });
        await host.dispatch(trigger('ctx7-search', {}), CONTEXT7_CAPABILITY, { prompt: 'cleanup', operation: 'search', libraryName: 'React' });
        expect(calls[1]).toEqual({ id: 'mcp.context7.resolve', input: { libraryName: 'React', query: 'cleanup' } });
        const invalid = await host.dispatch(trigger('ctx7-invalid', {}), CONTEXT7_CAPABILITY, { prompt: 'search', operation: 'search' });
        expect(invalid.status).toBe('failed'); expect(calls).toHaveLength(2);
        empty = true;
        const failed = await host.dispatch(trigger('ctx7-empty', {}), CONTEXT7_CAPABILITY, { prompt: 'cleanup' });
        expect(failed.status).toBe('failed');
    } finally { await host.stop(); }
    expect(host.web.pages()).toEqual([]);
});
