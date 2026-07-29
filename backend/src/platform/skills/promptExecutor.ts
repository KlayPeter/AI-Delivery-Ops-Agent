import { randomUUID } from 'node:crypto';
import type { AgentRunStore } from '@/platform/agents/runStore';
import type { OrchestratorAdapter, OrchestratorStepTrace, OrchestratorTool } from '@/platform/models/contracts';
import type { ToolRegistry } from '@/platform/tools/registry';
import type { PromptSkillExecutor, RegisteredSkill, SkillHandlerContext } from './contracts';

export class OrchestratedPromptSkillExecutor implements PromptSkillExecutor {
    constructor(
        private readonly orchestrator: OrchestratorAdapter,
        private readonly tools: ToolRegistry,
        private readonly runs?: AgentRunStore,
    ) {}

    async execute(skill: RegisteredSkill, input: unknown, context: SkillHandlerContext): Promise<unknown> {
        const orchestratorTools: OrchestratorTool[] = skill.manifest.allowedTools.map(toolId => {
            const tool = this.tools.resolve(toolId).definition;
            return {
                name: this.safeName(toolId),
                description: tool.description,
                inputSchema: tool.inputSchema,
                execute: (toolInput: unknown, toolCallId: string) => context.tools.execute(toolId, toolInput, { idempotencyKey: `${context.runId}:${toolCallId}` }),
            };
        });
        const result = await this.orchestrator.run({
            agentId: `skill:${skill.manifest.id}`,
            instructions: `${skill.instructions}\n\nReturn only the value required by the output schema.`,
            messages: [{ role: 'user', content: JSON.stringify(input) }],
            tools: orchestratorTools,
            maxSteps: Math.max(1, skill.manifest.maxToolCalls + 2),
            timeoutMs: skill.manifest.timeoutSeconds * 1000,
            signal: context.signal,
            onStep: trace => this.saveModelStep(context.runId, `skill:${skill.manifest.id}`, trace),
        });
        if (result.needsHuman) throw Object.assign(new Error(`Prompt Skill requires Agent-level clarification: ${result.needsHuman.question}`), { code: 'SKILL_NEEDS_HUMAN', retryable: false });
        if (skill.manifest.outputSchema.type === 'string') return result.text;
        try {
            return JSON.parse(this.jsonText(result.text));
        } catch {
            throw Object.assign(new Error(`Prompt Skill returned invalid JSON: ${skill.manifest.id}`), { code: 'INVALID_SKILL_JSON', retryable: false });
        }
    }

    private async saveModelStep(runId: string, name: string, trace: OrchestratorStepTrace): Promise<void> {
        const now = new Date().toISOString();
        await this.runs?.saveStep({ id: randomUUID(), runId, kind: 'model', name, status: 'succeeded', startedAt: now, completedAt: now, metadata: { ...trace } });
    }

    private safeName(id: string): string { return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64); }
    private jsonText(text: string): string { return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); }
}
