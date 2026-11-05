import { z } from 'zod';
import type { AgentRegistry } from '@/platform/agents/registry';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { checkHash } from '@/platform/plugins/checks';
import { validateSchema } from '@/platform/agents/schema';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const parameters = z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 32768, '参数最多 32 KiB');
const createInput = z.object({ id: uuid, name: z.string().trim().min(1).max(80), sourceRunId: uuid, input: parameters }).strict();
const launchInput = z.object({ triggerId: uuid, input: parameters }).strict();
const execution = z.object({ schemaVersion: z.literal('1.0'), agentId: z.string(), agentVersion: z.string(), manifestHash: hash, inputHash: hash });
type Scope = { workspaceId: string; botInstanceId: string };
export interface RunRecipe extends Scope {
    schemaVersion: '1.0'; id: string; name: string; sourceRunId: string; capability: string; installationId: string;
    agentId: string; agentName: string; agentVersion: string; manifestHash: string; inputHash: string; input: z.infer<typeof parameters>; createdAt: string;
}
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };

export class RunRecipeService {
    private readonly runs: PersistentAgentRunStore;
    constructor(private readonly store: PersistentKeyValueStore, private readonly agents: AgentRegistry, private readonly capabilities: readonly string[], private readonly runLocal: NonNullable<PluginHostServices['runLocal']>) {
        this.runs = new PersistentAgentRunStore(store);
    }
    private prefix() { return `personal:recipes:${encodeURIComponent(scope.workspaceId)}:${encodeURIComponent(scope.botInstanceId)}:`; }
    private async collection(): Promise<RunRecipe[]> { return await this.store.getIdempotencyValue<RunRecipe[]>(this.prefix() + 'collection') || []; }
    async get(id: string) {
        uuid.parse(id);
        return (await this.collection()).find(item => item.id === id) || fail('配方不存在', 404);
    }
    private resolve(recipe: RunRecipe) {
        if (!this.capabilities.includes(recipe.capability)) return fail('此能力未在配方插件的可信配置中启用', 409);
        let resolved;
        try { resolved = this.agents.resolve(scope.workspaceId, scope.botInstanceId, recipe.capability); }
        catch { return fail('原能力当前未装配，请先恢复插件', 409); }
        if (resolved.installation.id !== recipe.installationId || resolved.manifest.id !== recipe.agentId || resolved.manifest.version !== recipe.agentVersion || checkHash(resolved.manifest) !== recipe.manifestHash) return fail('Agent 版本、契约或绑定已变化，请重新运行并创建配方', 409);
        if (!resolved.manifest.triggers.includes('manual')) return fail('此 Agent 不接受手动任务', 409);
        return resolved;
    }
    async list() {
        return (await this.collection()).map(({ input, ...recipe }) => {
            try { this.resolve({ ...recipe, input }); return { ...recipe, available: true }; }
            catch (error) { return { ...recipe, available: false, reason: error instanceof Error ? error.message : '当前不可运行' }; }
        });
    }
    async create(value: unknown) {
        const input = createInput.parse(value), source = await this.runs.get(input.sourceRunId);
        if (!source || source.workspaceId !== scope.workspaceId || source.botInstanceId !== scope.botInstanceId) return fail('来源运行不存在或不属于当前范围', 404);
        if (source.status !== 'succeeded' || source.parentRunId || source.rootRunId !== source.id) return fail('只能从已成功完成的根运行创建配方');
        if (!this.capabilities.includes(source.capability)) return fail('此能力不支持配方；默认仅开放已审查的个人读取任务');
        const steps = (await this.runs.listSteps(source.id)).filter(step => step.kind === 'agent' && !step.name.startsWith('delegate:'));
        if (steps.length !== 1 || steps[0]!.status !== 'succeeded') return fail('来源缺少单次执行凭证；人工多轮任务请先用完整参数重新执行');
        const parsed = execution.safeParse(steps[0]!.metadata?.execution);
        if (!parsed.success || steps[0]!.name !== parsed.data.agentId) return fail('旧运行缺少完整版本或输入指纹，不能补造配方凭证');
        if (checkHash(input.input) !== parsed.data.inputHash) return fail('参数与来源运行的输入指纹不匹配；修改参数后请先执行任务');
        const recipe: RunRecipe = { schemaVersion: '1.0', ...scope, id: input.id, name: input.name, sourceRunId: source.id, capability: source.capability, installationId: source.agentInstallationId,
            agentId: parsed.data.agentId, agentVersion: parsed.data.agentVersion, manifestHash: parsed.data.manifestHash, inputHash: parsed.data.inputHash, agentName: '', input: input.input, createdAt: new Date().toISOString() };
        const resolved = this.resolve(recipe); recipe.agentName = resolved.manifest.name;
        const errors = validateSchema(recipe.input, resolved.manifest.inputSchema); if (errors.length) return fail(errors.join('; ').slice(0, 500));
        const key = this.prefix() + 'collection';
        await this.store.claimIdempotencyKey(key, []);
        for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.collection(), existing = current.find(item => item.id === recipe.id);
            if (existing) {
                if (existing.name !== recipe.name || existing.sourceRunId !== recipe.sourceRunId || existing.inputHash !== recipe.inputHash) return fail('配方请求 ID 已被其他内容使用', 409);
                return existing;
            }
            // shortcut: 每个范围最多 50 个配方，接近上限时再增加归档管理。
            if (current.length >= 50) return fail('最多保存 50 个配方');
            if (await this.store.compareAndSetIdempotencyKey(key, current, [...current, recipe])) return recipe;
        }
        return fail('配方保存发生冲突，请重试', 409);
    }
    async launch(id: string, value: unknown) {
        const input = launchInput.parse(value), recipe = await this.get(id), resolved = this.resolve(recipe);
        const errors = validateSchema(input.input, resolved.manifest.inputSchema); if (errors.length) return fail(errors.join('; ').slice(0, 500));
        const binding = { recipeId: recipe.id, inputHash: checkHash(input.input), manifestHash: recipe.manifestHash };
        const key = this.prefix() + `request:${input.triggerId}`;
        if (!await this.store.claimIdempotencyKey(key, binding)) {
            const previous = await this.store.getIdempotencyValue(key);
            if (checkHash(previous) !== checkHash(binding)) return fail('运行请求 ID 已绑定其他配方或参数', 409);
        }
        const result = await this.runLocal(recipe.capability, input.input, `recipe:${recipe.id}:${input.triggerId}`, { installationId: recipe.installationId, manifestHash: recipe.manifestHash });
        if (!result.runId && result.status === 'failed') return fail(result.error?.message || '任务未能创建，请检查插件状态', 409);
        if (!result.runId) return { ...result, receiptSaved: false, warning: '任务提交仍在处理中，请在运行记录中查看，勿重复发起。' };
        const receipt = { schemaVersion: '1.0', runId: result.runId, recipeId: recipe.id, recipeName: recipe.name, sourceRunId: recipe.sourceRunId, agentId: recipe.agentId, agentVersion: recipe.agentVersion,
            manifestHash: recipe.manifestHash, inputHash: binding.inputHash, parametersChanged: binding.inputHash !== recipe.inputHash };
        try { await this.store.setIdempotencyKey(this.prefix() + `run:${result.runId}`, receipt); }
        catch { return { ...result, receiptSaved: false, warning: '运行已创建，但配方来源记录保存失败。请保留运行 ID，勿重复提交。' }; }
        return { ...result, receiptSaved: true };
    }
    async receipt(runId: string) {
        uuid.parse(runId);
        const run = await this.runs.get(runId);
        if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId) return fail('运行不存在', 404);
        return this.store.getIdempotencyValue(this.prefix() + `run:${runId}`);
    }
}
