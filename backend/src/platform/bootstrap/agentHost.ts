import { PluginRuntime } from '@/platform/plugins/runtime';
import type { FeaturePlugin } from '@/platform/plugins/contracts';
import type { SourceMessage } from '@/models/types';
import type { AgentManifest } from '@/platform/agents/contracts';
import { PersistentAgentCatalog } from '@/platform/agents/catalog';
import { createExternalAgentPackage, type ExternalAgentInstallOptions } from '@/platform/agents/externalInstaller';
import { HttpAgentAdapter } from '@/platform/agents/httpAdapter';
import { ModelLoopAgentAdapter } from '@/platform/agents/modelLoopAdapter';
import { NativeAgentAdapter } from '@/platform/agents/nativeAdapter';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { AgentRegistry } from '@/platform/agents/registry';
import { AgentRuntime } from '@/platform/agents/runtime';
import { BotRegistry } from '@/platform/bots/registry';
import { PersistentBotControlCatalog } from '@/platform/bots/catalog';
import type { BotAgentBinding, BotInstance } from '@/platform/bots/contracts';
import { RoutedFeishuDeliveryAdapter } from '@/platform/delivery/routedFeishuAdapter';
import { PersistentDeliveryOutbox } from '@/platform/delivery/persistentOutbox';
import { DeliveryWorker } from '@/platform/delivery/worker';
import { PersistentTriggerClaimStore } from '@/platform/runtime/persistentTriggerStore';
import { createTriggerEnvelope, createTriggerScope, DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import { TriggerRuntime } from '@/platform/runtime/triggerRuntime';
import { EnvironmentSecretResolver } from '@/platform/secrets/resolver';
import { AiSdkOrchestratorAdapter } from '@/platform/models/aiSdkOrchestrator';
import { AiSdkModelGateway } from '@/platform/models/gateway';
import { PersistentAgentSessionStore } from '@/platform/session/persistentStore';
import { OrchestratedPromptSkillExecutor } from '@/platform/skills/promptExecutor';
import { SkillRegistry } from '@/platform/skills/registry';
import { SkillRuntime } from '@/platform/skills/runtime';
import type { SkillExecutionRequest } from '@/platform/skills/contracts';
import { PersistentToolCallStore } from '@/platform/tools/callStore';
import { ToolGateway } from '@/platform/tools/gateway';
import { ToolRegistry } from '@/platform/tools/registry';
import type { HandlerContext } from '@/services/messageHandler/types';

export interface AgentConversationOutcome {
    runId: string;
    status: 'waiting_human' | 'succeeded';
    text: string;
}

export interface AgentHostHealth {
    initialized: boolean;
    started: boolean;
    workspaceId: string;
    botInstanceId: string;
    tools: number;
    skills: number;
    bots: number;
    bindings: number;
}

export interface AgentHostExtensionContext {
    getContext: () => HandlerContext;
    registry: AgentRegistry;
    nativeAdapter: NativeAgentAdapter;
    modelLoopAdapter: ModelLoopAgentAdapter;
    toolRegistry: ToolRegistry;
    skillRegistry: SkillRegistry;
}

export interface AgentHostExtension {
    id: string;
    register: (context: AgentHostExtensionContext) => void | Promise<void>;
}

export interface AgentHostOptions {
    plugins?: readonly FeaturePlugin[];
    pluginConfig?: Readonly<Record<string, Record<string, unknown>>>;
    conversationCapability?: string;
}

export class AgentHost {
    readonly registry = new AgentRegistry();
    readonly nativeAdapter = new NativeAgentAdapter();
    readonly bots = new BotRegistry();
    readonly toolRegistry = new ToolRegistry();
    readonly skillRegistry = new SkillRegistry();

    private initializePromise?: Promise<void>;
    private initialized = false;
    private started = false;
    private triggerRuntime?: TriggerRuntime;
    private deliveryWorker?: DeliveryWorker;
    private catalog?: PersistentAgentCatalog;
    private controlCatalog?: PersistentBotControlCatalog;
    private toolGateway?: ToolGateway;
    private skillRuntime?: SkillRuntime;
    private modelLoopAdapter?: ModelLoopAgentAdapter;
    private runStore?: PersistentAgentRunStore;
    private sessionStore?: PersistentAgentSessionStore;
    private pluginRuntime?: PluginRuntime;
    private stopped = false;
    private readonly inFlight = new Set<Promise<unknown>>();

    constructor(
        private readonly getContext: () => HandlerContext,
        private readonly deliveryPollIntervalMs: number = 1000,
        private readonly skillRoot: string = `${import.meta.dir}/../../../skills`,
        private readonly extensions: readonly AgentHostExtension[] = [],
        private readonly options: AgentHostOptions = {},
    ) {}

    initialize(): Promise<void> {
        if (this.stopped) return Promise.reject(new Error('Agent Host is stopped; create a new host to restart'));
        if (!this.initializePromise) this.initializePromise = this.initializeOnce().catch(async error => {
            await this.pluginRuntime?.dispose();
            throw error;
        });
        return this.initializePromise;
    }

    async start(): Promise<void> {
        await this.initialize();
        if (this.stopped) throw new Error('Agent Host is stopped');
        if (this.started) return;
        this.started = true;
        this.deliveryWorker!.start(this.deliveryPollIntervalMs, error => {
            Promise.resolve(this.getContext().store.appendAuditLog('agent_delivery_worker_error', {
                at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
            })).catch(() => {});
        });
    }

    async stop(): Promise<void> {
        this.started = false;
        this.stopped = true;
        await this.initializePromise?.catch(() => {});
        await Promise.allSettled(this.inFlight);
        await this.deliveryWorker?.stop();
        await this.pluginRuntime?.dispose();
        this.initialized = false;
    }

    health(): AgentHostHealth {
        return {
            initialized: this.initialized,
            started: this.started,
            workspaceId: DEFAULT_WORKSPACE_ID,
            botInstanceId: DEFAULT_BOT_INSTANCE_ID,
            tools: this.toolRegistry.list().length,
            skills: this.skillRegistry.list().length,
            bots: this.bots.list().length,
            bindings: this.registry.listBindings().length,
        };
    }

    refreshBot(): void {
        const ctx = this.getContext();
        this.bots.upsert({
            id: DEFAULT_BOT_INSTANCE_ID,
            workspaceId: DEFAULT_WORKSPACE_ID,
            platform: 'feishu',
            name: ctx.config.feishu.bot_name || 'default',
            appId: ctx.config.feishu.app_id,
            secretRef: 'config://feishu/app_secret',
            status: 'active',
            config: {},
        });
    }

    async dispatch(trigger: Parameters<TriggerRuntime['dispatch']>[0], capability: string, input: unknown) {
        await this.initialize();
        return this.track(() => this.triggerRuntime!.dispatch(trigger, capability, input));
    }

    async resume(trigger: Parameters<TriggerRuntime['resume']>[0], runId: string, input: unknown) {
        await this.initialize();
        return this.track(() => this.triggerRuntime!.resume(trigger, runId, input));
    }

    async dispatchBotMessage(input: {
        workspaceId: string;
        botInstanceId: string;
        capability: string;
        message: SourceMessage;
        targetOpenId: string;
    }) {
        await this.initialize();
        const bot = this.bots.requireActive(input.botInstanceId);
        if (bot.workspaceId !== input.workspaceId) throw new Error('Bot message workspace does not match BotInstance');
        if (!input.targetOpenId.trim()) throw new Error('Private message target is required');
        const safeMessage = { ...input.message, raw_payload: {} };
        const payload = {
            prompt: input.message.text || '',
            message: safeMessage,
            source: 'private',
        };
        const scope = createTriggerScope({
            workspaceId: input.workspaceId,
            botInstanceId: input.botInstanceId,
            triggerType: 'message',
            triggerId: input.message.id,
            conversationId: input.message.chat_id || input.targetOpenId,
            actorId: input.message.sender_open_id,
        });
        const trigger = createTriggerEnvelope({
            occurredAt: input.message.sent_at || new Date().toISOString(),
            scope,
            payload,
            trustedContext: { source: 'private', message: structuredClone(safeMessage) },
            replyPolicy: { mode: 'configured_target', channel: 'private', targetId: input.targetOpenId },
        });
        const result = await this.dispatch(trigger, input.capability, payload);
        if (result.status === 'failed') throw Object.assign(new Error(result.claim.error?.message || 'Bot Agent failed'), result.claim.error || {});
        return result;
    }

    isModelAvailable(): boolean {
        const ai = this.getContext().config.ai;
        return Boolean(ai?.api_key && ai?.model);
    }

    canDispatch(capability: string, workspaceId = DEFAULT_WORKSPACE_ID, botInstanceId = DEFAULT_BOT_INSTANCE_ID): boolean {
        if (!this.initialized || this.stopped) return false;
        try {
            this.registry.resolve(workspaceId, botInstanceId, capability);
            return true;
        } catch {
            return false;
        }
    }

    async handleMessage(message: SourceMessage, source: 'group' | 'private', replyContext?: unknown): Promise<AgentConversationOutcome> {
        return this.dispatchMessage(message, source, replyContext);
    }

    async resumeMessage(runId: string, message: SourceMessage, source: 'group' | 'private'): Promise<AgentConversationOutcome> {
        return this.dispatchMessage(message, source, undefined, runId);
    }

    async flushDeliveries(now: Date = new Date()) {
        await this.initialize();
        return this.deliveryWorker!.runOnce(now);
    }

    async installExternal(manifest: AgentManifest, options: ExternalAgentInstallOptions) {
        await this.initialize();
        const bot = this.bots.get(options.botInstanceId);
        if (!bot) throw new Error(`BotInstance not found: ${options.botInstanceId}`);
        if (bot.workspaceId !== options.workspaceId) throw new Error('External Agent installation and BotInstance must belong to the same workspace');
        const agentPackage = createExternalAgentPackage(manifest, options);
        this.registry.registerOrVerify(agentPackage.manifest);
        const saved = await this.catalog!.upsert(agentPackage);
        this.registry.upsertInstallation(saved.installation);
        this.registry.upsertBinding(saved.binding);
        return saved;
    }

    async registerBot(bot: BotInstance): Promise<Record<string, unknown>> {
        await this.initialize();
        if (bot.id === DEFAULT_BOT_INSTANCE_ID) throw new Error('The default BotInstance is managed by application config');
        if (!bot.id.trim() || !bot.workspaceId.trim() || !bot.name.trim() || !bot.appId.trim()) throw new Error('BotInstance id, workspaceId, name and appId are required');
        if (!/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(bot.secretRef)) throw new Error('Bot secretRef must be an env:// reference');
        const sendRetryCount = Number(bot.config.sendRetryCount || 3);
        const saved = await this.controlCatalog!.upsertBot({
            ...bot,
            platform: 'feishu',
            config: {
                ...bot.config,
                sendRetryCount: Number.isFinite(sendRetryCount) ? Math.max(0, Math.min(10, sendRetryCount)) : 3,
            },
        });
        this.bots.upsert(saved);
        return this.publicBot(saved);
    }

    async bindAgent(input: {
        id?: string;
        botInstanceId: string;
        agentInstallationId: string;
        capabilities?: readonly string[];
        priority?: number;
        enabled?: boolean;
        routingConfig?: Readonly<Record<string, unknown>>;
        configOverride?: Readonly<Record<string, unknown>>;
    }): Promise<BotAgentBinding> {
        await this.initialize();
        const bot = this.bots.get(input.botInstanceId);
        if (!bot) throw new Error(`BotInstance not found: ${input.botInstanceId}`);
        const installation = this.registry.getInstallation(input.agentInstallationId);
        const manifest = this.registry.getManifestForInstallation(input.agentInstallationId);
        if (!installation || !manifest) throw new Error(`Agent installation not found: ${input.agentInstallationId}`);
        if (installation.workspaceId !== bot.workspaceId) throw new Error('Agent installation and BotInstance must belong to the same workspace');
        const capabilities = input.capabilities?.length ? [...input.capabilities] : [...manifest.capabilities];
        if (capabilities.some(capability => !manifest.capabilities.includes(capability))) throw new Error('Binding contains a capability not declared by the Agent');
        const binding: BotAgentBinding = {
            id: input.id || `bind-${input.agentInstallationId}-${input.botInstanceId}`,
            botInstanceId: input.botInstanceId,
            agentInstallationId: input.agentInstallationId,
            enabled: input.enabled !== false,
            priority: Math.max(1, Number(input.priority || 100)),
            capabilities,
            routingConfig: input.routingConfig || {},
            configOverride: input.configOverride || {},
        };
        const saved = await this.controlCatalog!.upsertBinding(binding);
        this.registry.upsertBinding(saved);
        return saved;
    }

    async listBots(): Promise<Array<Record<string, unknown>>> {
        await this.initialize();
        return this.bots.list().map(bot => this.publicBot(bot));
    }

    async listBindings(botInstanceId?: string): Promise<Array<Record<string, unknown>>> {
        await this.initialize();
        return this.registry.listBindings(botInstanceId).map(binding => ({
            id: binding.id,
            botInstanceId: binding.botInstanceId,
            agentInstallationId: binding.agentInstallationId,
            enabled: binding.enabled,
            priority: binding.priority,
            capabilities: binding.capabilities,
            routingConfig: binding.routingConfig,
            hasConfigOverride: Object.keys(binding.configOverride).length > 0,
        }));
    }

    async executeSkill(request: SkillExecutionRequest): Promise<unknown> {
        await this.initialize();
        return this.skillRuntime!.execute(request);
    }

    async listSkills(agentId?: string) {
        await this.initialize();
        return this.skillRegistry.list(agentId);
    }

    async getRunDetails(runId: string) {
        await this.initialize();
        const run = await this.runStore!.get(runId);
        if (!run) return null;
        const [steps, artifacts, checkpoint, children] = await Promise.all([
            this.runStore!.listSteps(runId),
            this.runStore!.listArtifacts(runId),
            this.sessionStore!.getCheckpoint(runId),
            this.runStore!.listChildren(runId),
        ]);
        return {
            run,
            steps: steps.sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
            artifacts: artifacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
            checkpoint,
            children: children.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        };
    }

    async listAgents(): Promise<Array<Record<string, unknown>>> {
        await this.initialize();
        const nativeAgents = (this.options.plugins || []).flatMap(plugin => (plugin.agents || []).map(agent => ({
            agentId: agent.manifest.id,
            name: agent.manifest.name,
            version: agent.manifest.version,
            runtime: agent.manifest.runtime.type,
            installationId: agent.installationId,
            status: 'active',
            capabilities: agent.manifest.capabilities,
            botInstanceId: DEFAULT_BOT_INSTANCE_ID,
            source: plugin.manifest.id.startsWith('builtin.') ? 'built-in' : 'plugin',
            pluginId: plugin.manifest.id,
            secretNames: [] as string[],
        })));
        const externalAgents = (await this.catalog!.list()).map(agentPackage => ({
            agentId: agentPackage.manifest.id,
            name: agentPackage.manifest.name,
            version: agentPackage.manifest.version,
            runtime: agentPackage.manifest.runtime.type,
            installationId: agentPackage.installation.id,
            status: agentPackage.installation.status,
            capabilities: agentPackage.manifest.capabilities,
            botInstanceId: agentPackage.binding.botInstanceId,
            updatedAt: agentPackage.updatedAt,
            source: 'external',
            secretNames: Object.keys(agentPackage.installation.secretRefs),
        }));
        return [...nativeAgents, ...externalAgents];
    }

    private async initializeOnce(): Promise<void> {
        const ctx = this.getContext();
        this.refreshBot();
        this.catalog = new PersistentAgentCatalog(ctx.store);
        this.controlCatalog = new PersistentBotControlCatalog(ctx.store);

        const outbox = new PersistentDeliveryOutbox(ctx.store);
        const runStore = new PersistentAgentRunStore(ctx.store);
        const toolCallStore = new PersistentToolCallStore(ctx.store);
        const triggerStore = new PersistentTriggerClaimStore(ctx.store);
        const [runRecovery, toolCallsRecovered, triggersRecovered] = await Promise.all([
            runStore.recoverInterrupted(),
            toolCallStore.recoverInterrupted(),
            triggerStore.recoverInterrupted(),
        ]);
        const recovered = runRecovery.runs + runRecovery.steps + toolCallsRecovered + triggersRecovered;
        if (recovered > 0 && typeof (ctx.store as any).appendAuditLog === 'function') {
            await ctx.store.appendAuditLog('agent_runtime_recovered_after_restart', {
                runs: runRecovery.runs,
                steps: runRecovery.steps,
                tool_calls: toolCallsRecovered,
                triggers: triggersRecovered,
            }).catch(() => {});
        }
        this.runStore = runStore;
        this.sessionStore = new PersistentAgentSessionStore(ctx.store);
        const orchestrator = new AiSdkOrchestratorAdapter(new AiSdkModelGateway(() => this.getContext().config.ai));
        this.toolGateway = new ToolGateway(this.toolRegistry, toolCallStore, runStore);
        const promptSkillExecutor = new OrchestratedPromptSkillExecutor(orchestrator, this.toolRegistry, runStore);
        this.skillRuntime = new SkillRuntime(this.skillRegistry, this.toolGateway, runStore, promptSkillExecutor);
        this.modelLoopAdapter = new ModelLoopAgentAdapter(
            orchestrator,
            this.toolRegistry,
            this.toolGateway,
            this.skillRegistry,
            this.skillRuntime,
            this.sessionStore,
            runStore,
        );
        this.pluginRuntime = new PluginRuntime(this.options.plugins || [], {
            getContext: this.getContext,
            agents: this.registry,
            nativeAgents: this.nativeAdapter,
            modelAgents: this.modelLoopAdapter,
            tools: this.toolRegistry,
            skills: this.skillRegistry,
            bots: this.bots,
            botCatalog: this.controlCatalog,
            skillRoot: this.skillRoot,
        }, this.options.pluginConfig);
        await this.pluginRuntime.start();
        await this.catalog.loadInto(this.registry);
        await this.controlCatalog.loadInto(this.bots, this.registry);
        await this.pluginRuntime.restored();
        for (const bot of this.bots.list()) {
            const capability = bot.config.entryCapability;
            if (typeof capability !== 'string' || bot.status !== 'active') continue;
            try {
                this.registry.resolve(bot.workspaceId, bot.id, capability);
            } catch {
                this.bots.upsert({ ...bot, status: 'disabled' });
            }
        }
        await this.registerExtensions();
        const agentRuntime = new AgentRuntime(
            this.registry,
            this.bots,
            runStore,
            [this.nativeAdapter, this.modelLoopAdapter, new HttpAgentAdapter(new EnvironmentSecretResolver())],
        );
        this.modelLoopAdapter.setDelegateExecutor(agentRuntime);
        this.triggerRuntime = new TriggerRuntime(
            triggerStore,
            agentRuntime,
            outbox,
        );
        this.deliveryWorker = new DeliveryWorker(
            outbox,
            this.bots,
            new RoutedFeishuDeliveryAdapter(
                this.bots,
                DEFAULT_BOT_INSTANCE_ID,
                () => this.getContext().feishu,
                new EnvironmentSecretResolver(),
                undefined,
                (bot, action, payload) => {
                    this.getContext().store.appendAuditLog(action, {
                        ...payload,
                        bot_instance_id: bot.id,
                    }).catch(() => {});
                },
            ),
        );
        this.initialized = true;
    }

    private async registerExtensions(): Promise<void> {
        const extensionIds = new Set<string>();
        for (const extension of this.extensions) {
            const id = extension.id.trim();
            if (!id) throw new Error('Agent Host extension id is required');
            if (extensionIds.has(id)) throw new Error(`Duplicate Agent Host extension id: ${id}`);
            extensionIds.add(id);
        }
        for (const extension of this.extensions) {
            await extension.register({
                getContext: this.getContext,
                registry: this.registry,
                nativeAdapter: this.nativeAdapter,
                modelLoopAdapter: this.modelLoopAdapter!,
                toolRegistry: this.toolRegistry,
                skillRegistry: this.skillRegistry,
            });
        }
    }

    private async dispatchMessage(
        message: SourceMessage,
        source: 'group' | 'private',
        replyContext?: unknown,
        resumeRunId?: string,
    ): Promise<AgentConversationOutcome> {
        await this.initialize();
        if (!this.options.conversationCapability) throw new Error('Conversation capability is not configured');
        if (!this.isModelAvailable()) throw Object.assign(new Error('AI model is not configured'), { code: 'MODEL_NOT_CONFIGURED', retryable: false });
        const scope = createTriggerScope({
            workspaceId: DEFAULT_WORKSPACE_ID,
            botInstanceId: DEFAULT_BOT_INSTANCE_ID,
            triggerType: 'message',
            triggerId: resumeRunId ? `resume:${message.id}` : message.id,
            conversationId: message.root_id || message.chat_id,
            chatId: message.chat_id,
            actorId: message.sender_open_id,
            locale: 'zh-CN',
            timezone: 'Asia/Shanghai',
        });
        const safeMessage = { ...message, raw_payload: {} };
        const input: Record<string, unknown> = {
            prompt: message.text || '',
            source,
            message: safeMessage,
            groupId: message.chat_id,
            dayIso: message.sent_at || new Date().toISOString(),
        };
        if (replyContext && typeof replyContext === 'object') input.replyContext = replyContext;
        const trigger = createTriggerEnvelope({
            occurredAt: message.sent_at || new Date().toISOString(),
            scope,
            payload: input,
            trustedContext: {
                source,
                message: structuredClone(safeMessage),
                ...(replyContext && typeof replyContext === 'object' ? { replyContext: structuredClone(replyContext) } : {}),
            },
            replyPolicy: { mode: 'none' },
        });
        const result = resumeRunId
            ? await this.resume(trigger, resumeRunId, input)
            : await this.dispatch(trigger, this.options.conversationCapability, input);
        if (result.status === 'failed') throw Object.assign(new Error(result.claim.error?.message || 'Delivery Ops Agent failed'), result.claim.error || {});
        if (result.status === 'duplicate') {
            const runId = result.claim.runId;
            if (!runId) throw new Error('Duplicate Agent trigger has no Run');
            const details = await this.getRunDetails(runId);
            if (!details) throw new Error(`AgentRun not found: ${runId}`);
            const markdown = details.artifacts.findLast(artifact => artifact.type === 'markdown');
            return {
                runId,
                status: details.run.status === 'waiting_human' ? 'waiting_human' : 'succeeded',
                text: typeof markdown?.content === 'string' ? markdown.content : '该请求已处理。',
            };
        }
        const execution = result.execution!;
        const data = execution.result.data as { text?: unknown } | undefined;
        return {
            runId: execution.run.id,
            status: execution.run.status === 'waiting_human' ? 'waiting_human' : 'succeeded',
            text: typeof data?.text === 'string' && data.text.trim() ? data.text : '请求已处理。',
        };
    }

    private async track<T>(execute: () => Promise<T>): Promise<T> {
        if (this.stopped) throw new Error('Agent Host is stopped');
        const execution = execute();
        this.inFlight.add(execution);
        try {
            return await execution;
        } finally {
            this.inFlight.delete(execution);
        }
    }

    private publicBot(bot: BotInstance): Record<string, unknown> {
        return {
            id: bot.id,
            workspaceId: bot.workspaceId,
            platform: bot.platform,
            name: bot.name,
            appId: bot.appId,
            botOpenId: bot.botOpenId,
            status: bot.status,
            config: bot.config,
            hasSecretRef: Boolean(bot.secretRef),
        };
    }
}
