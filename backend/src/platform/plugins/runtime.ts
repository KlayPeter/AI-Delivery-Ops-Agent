import { Context } from '@deepseek-ai/cordis';
import * as path from 'node:path';
import { z } from 'zod';
import { SkillPackageLoader } from '@/platform/skills/packageLoader';
import { DEFAULT_BOT_INSTANCE_ID, DEFAULT_WORKSPACE_ID } from '@/platform/runtime/scope';
import type { FeaturePlugin, PluginHostServices } from './contracts';

const pluginId = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const manifestSchema = z.object({
    apiVersion: z.literal('1.0'),
    id: pluginId,
    name: z.string().trim().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    description: z.string().trim().min(1),
    requires: z.array(pluginId).optional(),
}).strict();

export function orderPlugins(plugins: readonly FeaturePlugin[]): FeaturePlugin[] {
    const byId = new Map<string, FeaturePlugin>();
    for (const plugin of plugins) {
        manifestSchema.parse(plugin.manifest);
        if (typeof plugin.apply !== 'function') throw new Error(`Plugin apply is required: ${plugin.manifest.id}`);
        if (byId.has(plugin.manifest.id)) throw new Error(`Duplicate plugin id: ${plugin.manifest.id}`);
        for (const name of plugin.skillPackages || []) {
            if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid plugin skill package: ${name}`);
        }
        byId.set(plugin.manifest.id, plugin);
    }
    const ordered: FeaturePlugin[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    function visit(id: string): void {
        if (visiting.has(id)) throw new Error(`Plugin dependency cycle: ${id}`);
        if (visited.has(id)) return;
        const plugin = byId.get(id);
        if (!plugin) throw new Error(`Required plugin is missing: ${id}`);
        visiting.add(id);
        for (const dependency of plugin.manifest.requires || []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
        ordered.push(plugin);
    }
    for (const id of byId.keys()) visit(id);
    return ordered;
}

export class PluginRuntime {
    private readonly context = new Context();
    private readonly plugins: readonly FeaturePlugin[];
    private startPromise?: Promise<void>;
    private disposePromise?: Promise<void>;
    private disposed = false;

    constructor(
        plugins: readonly FeaturePlugin[],
        private readonly services: PluginHostServices,
        private readonly config: Readonly<Record<string, Record<string, unknown>>> = {},
    ) {
        this.plugins = orderPlugins(plugins);
        this.context.provide('delivery', services);
    }

    start(): Promise<void> {
        if (this.disposed) return Promise.reject(new Error('Plugin runtime is disposed'));
        this.startPromise ??= this.mount();
        return this.startPromise;
    }

    async restored(): Promise<void> {
        await this.start();
        try {
            await this.context.serial('delivery/restored');
        } catch (error) {
            await this.dispose();
            throw error;
        }
    }

    dispose(): Promise<void> {
        this.disposed = true;
        return this.disposePromise ??= this.context.fiber.dispose();
    }

    private async mount(): Promise<void> {
        try {
            for (const plugin of this.plugins) {
                await this.context.plugin({
                    name: plugin.manifest.id,
                    inject: ['delivery', ...(plugin.manifest.requires || []).map(id => `plugin:${id}`)],
                    Config: plugin.Config,
                    apply: async (ctx: Context, config: Record<string, unknown>) => {
                        const services = this.services;
                        const scoped: PluginHostServices = {
                            ...services,
                            tools: { register: (...args) => ctx.effect(() => services.tools.register(...args)) },
                            nativeAgents: { register: (...args) => ctx.effect(() => services.nativeAgents.register(...args)) },
                            modelAgents: { register: (...args) => ctx.effect(() => services.modelAgents.register(...args)) },
                            skills: { register: (...args) => ctx.effect(() => services.skills.register(...args)) },
                            messageRoutes: { register: (...args) => ctx.effect(() => services.messageRoutes.register(...args)) },
                            schedules: { register: (...args) => ctx.effect(() => services.schedules.register(...args)) },
                            runActions: { register: (...args) => ctx.effect(() => services.runActions.register(...args)) },
                            web: { register: (...args) => ctx.effect(() => services.web.register(...args)) },
                        };
                        for (const route of plugin.messageRoutes || []) scoped.messageRoutes.register(route);
                        for (const schedule of plugin.schedules || []) scoped.schedules.register(schedule);
                        for (const check of plugin.checks || []) ctx.effect(() => services.checks.register(plugin, check));
                        for (const agent of plugin.agents || []) {
                            ctx.effect(() => services.agents.register(agent.manifest));
                            ctx.effect(() => services.agents.install({
                                id: agent.installationId, workspaceId: DEFAULT_WORKSPACE_ID,
                                agentId: agent.manifest.id, version: agent.manifest.version,
                                status: 'active', config: {}, secretRefs: {},
                            }));
                            ctx.effect(() => services.agents.bind({
                                id: `bind-${agent.manifest.id}-default`, botInstanceId: DEFAULT_BOT_INSTANCE_ID,
                                agentInstallationId: agent.installationId, enabled: true, priority: 1,
                                capabilities: agent.manifest.capabilities, routingConfig: {}, configOverride: {},
                            }));
                        }
                        const loader = new SkillPackageLoader(scoped.skills);
                        for (const name of plugin.skillPackages || []) {
                            await ctx.effect(async () => {
                                const dispose = await loader.loadPackage(path.join(services.skillRoot, name));
                                if (!dispose) throw new Error(`Plugin skill package not found: ${name}`);
                                return dispose;
                            });
                        }
                        await plugin.apply(ctx.extend({ delivery: scoped }), config);
                        ctx.provide(`plugin:${plugin.manifest.id}`, { version: plugin.manifest.version });
                    },
                }, this.config[plugin.manifest.id] || {});
            }
        } catch (error) {
            await this.dispose();
            throw error;
        }
    }
}
