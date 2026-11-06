import { parse, stringify } from 'yaml';
import { exportMcpProfile } from '@/connectors/mcp-workbench/catalog';
import { sha256 } from '@/connectors/skill-workbench/source';

export const skillModule = './src/connectors/skill-workbench/promptPlugin.ts';
export const rawSkill = '---\nname: writing-helper\ndescription: Write concise summaries\nlicense: MIT\n---\nWrite a short summary.\n';
export const commit = 'a'.repeat(40), root = `https://github.com/example/skills/blob/${commit}`;
export const bundle = { schemaVersion: '1.0', requestedUrl: 'https://github.com/example/skills/blob/main/skills/writing-helper/SKILL.md', owner: 'example', repo: 'skills', commit,
    filePath: 'skills/writing-helper/SKILL.md', skillUrl: `${root}/skills/writing-helper/SKILL.md`, rawUrl: `https://raw.githubusercontent.com/example/skills/${commit}/skills/writing-helper/SKILL.md`, rawSkill,
    sha256: sha256(rawSkill), inspectedAt: '2026-11-06T00:00:00.000Z', license: { path: 'LICENSE', url: `${root}/LICENSE`, text: 'MIT License', sha256: sha256('MIT License') } };
export const selection = { bundle, reviewedSha256: bundle.sha256, confirmedPromptOnly: true, confirmedLicense: true };
export const skill = () => ({ name: 'skills.yaml', yaml: stringify({ apiVersion: '1.0', plugins: [
    ...['openai', 'google', 'ollama'].map(id => ({ module: `./src/platform/models/providers/${id}Plugin.ts` })),
    { module: './src/connectors/skill-workbench/setupPlugin.ts' }, { module: skillModule, config: { skills: [selection] } },
] }) });
export const mcp = (personal = false) => ({ name: 'mcp.yaml', yaml: exportMcpProfile({ serverId: 'docs', url: 'https://mcp.example.com/mcp', tools: [{ name: 'read', alias: 'read' }], reviewedReadOnly: true, includePersonalWorkspace: personal }).yaml });
export const openapiConfig = { serviceId: 'weather', reviewedReadOnly: true, source: { url: 'https://example.com/openapi.yaml', sha256: 'b'.repeat(64), openapi: '3.1.0', title: 'Public weather' },
    operations: [{ key: 'GET /weather', alias: 'read', method: 'GET', path: '/weather', summary: 'Read weather', parameters: [] as never[], serverUrl: 'https://api.example.com' }] };
export const openapi = () => ({ name: 'openapi.yaml', yaml: stringify({ apiVersion: '1.0', base: 'personal', plugins: [
    { module: '../src/connectors/openapi/plugin.ts', config: openapiConfig }, { module: '../src/connectors/openapi/setup.ts' },
] }) });
export const edit = (file: { name: string; yaml: string }, change: (profile: any) => void) => { const profile = parse(file.yaml); change(profile); return { ...file, yaml: stringify(profile, { aliasDuplicateObjects: false }) }; };
