import { z } from 'zod';
import type { AgentRegistry } from '@/platform/agents/registry';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import type { PluginHostServices } from '@/platform/plugins/contracts';
import { checkHash } from '@/platform/plugins/checks';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { KNOWLEDGE_IMPACT_CAPABILITY } from '../impact/plugin';
import { KnowledgeImpactService } from '../impact/service';

const scope = { workspaceId: DEFAULT_WORKSPACE_ID, botInstanceId: DEFAULT_BOT_INSTANCE_ID };
export const watchInput = z.object({
    runIds: z.array(z.string().uuid()).min(1).max(20).refine(ids => new Set(ids).size === ids.length),
    intervalMinutes: z.union([z.literal(1), z.literal(15), z.literal(60), z.literal(1440)]),
}).strict();
const planSchema = watchInput.extend({ revision: z.number().int().positive(), enabled: z.boolean(), nextCheckAt: z.string().datetime(),
    installationId: z.string(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), lastAttemptAt: z.string().datetime().optional(),
    lastCheckRunId: z.string().optional(), lastRunStatus: z.string().optional(), lastError: z.string().optional(),
});
export class WatchError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

export class KnowledgeWatchService {
    private readonly key = `knowledge:watch:${scope.workspaceId}:${scope.botInstanceId}:plan`;
    private readonly impact: KnowledgeImpactService;
    private pending?: Promise<void>;
    private stopped = false;
    constructor(private readonly store: PersistentKeyValueStore, private readonly agents: AgentRegistry, private readonly runLocal: NonNullable<PluginHostServices['runLocal']>) {
        this.impact = new KnowledgeImpactService(store);
    }
    private async plan() {
        const value = await this.store.getIdempotencyValue<z.infer<typeof planSchema>>(this.key);
        // CAS 比较原始 JSON，校验时保留字段顺序。
        if (value !== null) planSchema.parse(value);
        return value;
    }
    private binding() {
        let agent;
        try { agent = this.agents.resolve(scope.workspaceId, scope.botInstanceId, KNOWLEDGE_IMPACT_CAPABILITY); }
        catch { throw new WatchError('引用复核能力当前不可用，请恢复插件后重新保存计划', 409); }
        if (agent.manifest.runtime.type !== 'native' || agent.manifest.id !== 'native.knowledge-impact' || !agent.manifest.triggers.includes('manual')) throw new WatchError('计划只支持已装配的原生引用复核能力', 409);
        return { installationId: agent.installation.id, manifestHash: checkHash(agent.manifest) };
    }
    async status() {
        const plan = await this.plan();
        let reviews: Awaited<ReturnType<KnowledgeImpactService['reviews']>> = [], unavailable = '';
        if (plan) {
            try { reviews = await this.impact.reviews(scope, plan.runIds); }
            catch { unavailable = '计划中的历史记录当前无法读取，请核对原结果'; }
        }
        return { plan, reviews, unavailable };
    }
    async receipt(runId: string) {
        z.string().uuid().parse(runId);
        const run = await new PersistentAgentRunStore(this.store).get(runId);
        if (!run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId) throw new WatchError('运行不存在', 404);
        return this.store.getIdempotencyValue<{ schemaVersion: '1.0'; runId: string; revision: number; triggerKey: string; runIds: string[]; intervalMinutes: number; attemptedAt: string }>(`${this.key}:run:${runId}`);
    }
    async configure(value: unknown, now = new Date()) {
        const input = watchInput.parse(value), binding = this.binding();
        let targets;
        try { targets = await this.impact.targets(scope, input.runIds); }
        catch { throw new WatchError('所选历史记录不存在或不属于当前工作区'); }
        if (targets.some(target => target.problem || !target.references.length || target.references.some(ref => !ref.sourceKey || !ref.sourceKind))) throw new WatchError('请选择带完整来源引用的成功知识回答或发布草稿');
        for (let attempt = 0; attempt < 5; attempt++) {
            const previous = await this.plan(), next = { ...input, ...binding, revision: (previous?.revision || 0) + 1, enabled: true, nextCheckAt: new Date(now.getTime() + input.intervalMinutes * 60_000).toISOString() };
            if (previous ? await this.store.compareAndSetIdempotencyKey(this.key, previous, next) : await this.store.claimIdempotencyKey(this.key, next)) return next;
        }
        throw new WatchError('计划保存发生冲突，请刷新后重试', 409);
    }
    async pause() {
        for (let attempt = 0; attempt < 5; attempt++) {
            const plan = await this.plan();
            if (!plan || !plan.enabled) return plan;
            const next = { ...plan, revision: plan.revision + 1, enabled: false };
            if (await this.store.compareAndSetIdempotencyKey(this.key, plan, next)) return next;
        }
        throw new WatchError('计划状态发生冲突，请刷新后重试', 409);
    }
    tick(now = new Date()): Promise<void> {
        if (this.stopped || this.pending) return Promise.resolve();
        return this.pending = this.check(now).finally(() => { this.pending = undefined; });
    }
    private async check(now: Date) {
        const plan = await this.plan();
        if (this.stopped || !plan?.enabled || Date.parse(plan.nextCheckAt) > now.getTime()) return;
        const claimed: z.infer<typeof planSchema> = { ...plan, revision: plan.revision + 1, nextCheckAt: new Date(now.getTime() + plan.intervalMinutes * 60_000).toISOString(),
            lastAttemptAt: now.toISOString(), lastRunStatus: 'running', lastCheckRunId: undefined, lastError: undefined };
        if (!await this.store.compareAndSetIdempotencyKey(this.key, plan, claimed)) return;
        if (this.stopped) return;
        let result: Awaited<ReturnType<NonNullable<PluginHostServices['runLocal']>>> | undefined, lastError: string | undefined;
        try {
            const binding = this.binding();
            if (binding.installationId !== plan.installationId || binding.manifestHash !== plan.manifestHash) throw new WatchError('复核执行版本或绑定已变化，请重新保存计划', 409);
            // shortcut: 定时检查复用 Host 的本机 manual 通道；增加其他个人调度类型时再抽出独立触发服务。
            const triggerKey = `knowledge-watch:${claimed.revision}`;
            result = await this.runLocal(KNOWLEDGE_IMPACT_CAPABILITY, { operation: 'check', runIds: plan.runIds }, triggerKey, binding);
            if (result.runId) {
                try { await this.store.setIdempotencyKey(`${this.key}:run:${result.runId}`, { schemaVersion: '1.0', runId: result.runId, revision: claimed.revision, triggerKey, runIds: plan.runIds, intervalMinutes: plan.intervalMinutes, attemptedAt: now.toISOString() }); }
                catch { lastError = '检查记录已创建，但计划来源凭证未保存；请查看运行历史'; }
            }
            if (!result.runId || result.status !== 'succeeded') lastError = '本次定期检查未完成，请查看运行记录';
        } catch (error) { lastError = error instanceof WatchError ? error.message : '本次定期检查未完成，请查看运行记录或恢复插件后重试'; }
        await this.store.compareAndSetIdempotencyKey(this.key, claimed, { ...claimed, lastCheckRunId: result?.runId, lastRunStatus: lastError ? 'failed' : result!.status, lastError });
    }
    async stop() { this.stopped = true; await this.pending?.catch(() => {}); }
}
