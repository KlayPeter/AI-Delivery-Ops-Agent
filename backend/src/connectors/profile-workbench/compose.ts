import { isAlias, isMap, isSeq, parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { mcpConfig } from '../mcp/plugin';
import { runnerConfig } from '../mcp-workbench/runner';
import { connectorConfig } from '../openapi/contracts';
import { preparePromptSkills, promptConfig } from '../skill-workbench/catalog';

const inputSchema = z.object({ files: z.array(z.object({
    name: z.string().min(1).max(180).regex(/^[^/\\\x00-\x1f]+\.ya?ml$/i), yaml: z.string().min(1).max(1024 * 1024),
}).strict()).min(1).max(3) }).strict();
const profileSchema = z.object({ apiVersion: z.literal('1.0'), base: z.literal('personal').optional(),
    plugins: z.array(z.object({ module: z.string().max(200), config: z.record(z.string(), z.unknown()).optional() }).strict()).min(2).max(5),
}).strict();
const modules = {
    skillSetup: 'connectors/skill-workbench/setupPlugin.ts', skillPrompt: 'connectors/skill-workbench/promptPlugin.ts',
    mcp: 'connectors/mcp/plugin.ts', mcpRunner: 'connectors/mcp-workbench/runner.ts', mcpSetup: 'connectors/mcp-workbench/plugin.ts',
    openapi: 'connectors/openapi/plugin.ts', openapiSetup: 'connectors/openapi/setup.ts',
};
const providers = ['openai', 'google', 'ollama'].map(id => `platform/models/providers/${id}Plugin.ts`);
type Kind = 'Skill' | 'MCP' | 'OpenAPI';
export class CompositionError extends Error {}
const reject = (message: string): never => { throw new CompositionError(message); };

export const setupAssistantIds = z.array(z.enum(['skills', 'openapi'])).max(2)
    .refine(value => new Set(value).size === value.length, '接入助手不能重复');
const setupInput = z.object({ assistants: setupAssistantIds.refine(value => value.length > 0, '请至少选择一个接入助手') }).strict();
export function exportSetupProfile(value: unknown) {
    const { assistants } = setupInput.parse(value);
    const plugins = assistants.map(id => ({ module: `./src/${id === 'skills' ? modules.skillSetup : modules.openapiSetup}` }));
    return { filename: 'plugins.setup.personal.local.yaml', yaml: stringify({ apiVersion: '1.0', base: 'personal', plugins }),
        summary: [{ kind: '接入助手', file: '内置模块', items: assistants.map(id => id === 'skills' ? 'GitHub Skill：固定提交、指令和许可审查；审查后再导出文本技能' : 'OpenAPI：发现公开规范、审查固定 GET；审查后再导出读取工具') }] };
}

function parseYaml(text: string) {
    const doc = parseDocument(text, { schema: 'core', uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) reject('配置不是有效的单份 YAML，请重新导出。');
    const stack: Array<{ node: unknown; depth: number }> = [{ node: doc.contents, depth: 0 }];
    while (stack.length) {
        const { node, depth } = stack.pop()!;
        if (depth > 40 || isAlias(node)) reject('配置不能使用 YAML 别名或超过 40 层嵌套。');
        if (isMap(node)) for (const item of node.items) stack.push({ node: item.key, depth: depth + 1 }, { node: item.value, depth: depth + 1 });
        else if (isSeq(node)) for (const item of node.items) stack.push({ node: item, depth: depth + 1 });
    }
    return profileSchema.parse(doc.toJS({ maxAliasCount: 0 }));
}

export function composeProfiles(value: unknown) {
    const { files } = inputSchema.parse(value);
    if (files.reduce((total, file) => total + Buffer.byteLength(file.yaml), 0) > 1024 * 1024) reject('配置总量超过 1 MiB，请减少文件或 Skill 内容。');
    const seen = new Set<Kind>(), plugins: Array<{ module: string; config?: Record<string, unknown> }> = [];
    const summary: Array<{ kind: Kind; file: string; items: string[] }> = [];
    const add = (module: string, config?: Record<string, unknown>) => plugins.push({ module: `./src/${module}`, ...(config ? { config } : {}) });
    for (const file of files) {
        const profile = parseYaml(file.yaml), entries = new Map<string, Record<string, unknown> | undefined>();
        for (const entry of profile.plugins) {
            const module = entry.module.replace(/^\.\.?\/src\//, '');
            if (!/^\.\.?\/src\//.test(entry.module) || ![...Object.values(modules), ...providers].includes(module)) reject('只支持本应用导出的 Skill、MCP、OpenAPI 配置；不能导入其他模块。');
            if (entries.has(module)) reject('同一配置内的插件模块不能重复。');
            entries.set(module, entry.config);
        }
        const kind: Kind = entries.has(modules.skillPrompt) ? 'Skill' : entries.has(modules.mcp) ? 'MCP' : entries.has(modules.openapi) ? 'OpenAPI' : reject('文件缺少可组合的插件配置。');
        if (seen.has(kind)) reject(`一次只能选择一份 ${kind} 配置，请先在对应接入页整理选择。`);
        seen.add(kind);
        const required = kind === 'Skill' ? [modules.skillSetup, modules.skillPrompt] : kind === 'MCP' ? [modules.mcp, modules.mcpRunner] : [modules.openapi, modules.openapiSetup];
        const optional = kind === 'Skill' ? providers : kind === 'MCP' ? [modules.mcpSetup] : [];
        if (required.some(module => !entries.has(module)) || [...entries.keys()].some(module => ![...required, ...optional].includes(module))) reject('文件含混合或不完整的插件组合，请使用接入页原始导出文件。');
        const helpers = kind === 'Skill' ? [modules.skillSetup, ...providers] : kind === 'MCP' ? [modules.mcpSetup] : [modules.openapiSetup];
        for (const module of helpers) {
            if (Object.keys(entries.get(module) || {}).length) reject('接入助手与模型提供者不能携带额外配置。');
        }
        let items: string[];
        if (kind === 'Skill') {
            const config = promptConfig.parse(entries.get(modules.skillPrompt)), skills = preparePromptSkills(config);
            add(modules.skillSetup); add(modules.skillPrompt, config);
            items = skills.map(({ skill, bundle }) => `${skill.manifest.name} · ${bundle.skillUrl} · SHA ${bundle.sha256}`);
        } else if (kind === 'MCP') {
            const config = mcpConfig.parse(entries.get(modules.mcp)), runner = runnerConfig.parse(entries.get(modules.mcpRunner));
            if (config.servers.some(server => server.transport !== 'http' || server.tokenRef !== undefined)) reject('组合界面只支持接入页导出的匿名 HTTPS MCP 配置。');
            const grants = config.servers.flatMap(server => server.tools.map(tool => `mcp.${server.id}.${tool.alias}`));
            if (grants.length !== runner.allowedTools.length || grants.some(id => !runner.allowedTools.includes(id))) reject('MCP 连接与运行器的工具授权必须完全一致。');
            add(modules.mcp, config); add(modules.mcpRunner, runner);
            items = config.servers.flatMap(server => [`${server.id} · ${server.transport === 'http' ? server.url : ''}`, ...server.tools.map(tool => `mcp.${server.id}.${tool.alias} → ${tool.name}`)]);
        } else {
            const config = connectorConfig.parse(entries.get(modules.openapi));
            add(modules.openapi, config); add(modules.openapiSetup);
            items = [`${config.serviceId} · ${config.source.url} · SHA ${config.source.sha256}`, ...config.operations.map(operation => `${operation.key} · ${operation.serverUrl}`)];
        }
        summary.push({ kind, file: file.name, items });
    }
    return { filename: 'plugins.combined.personal.local.yaml', yaml: stringify({ apiVersion: '1.0', base: 'personal', plugins }), summary };
}
