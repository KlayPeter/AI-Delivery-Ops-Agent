import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseNote, resolveNoteLinks } from '@/knowledge/markdown/parser';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import { knowledgeMarkdownPlugin, KNOWLEDGE_MARKDOWN_CAPABILITY } from '@/knowledge/markdown/plugin';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';
import { loadPluginConfiguration } from '@/platform/plugins/configuration';

const folders: string[] = [];
async function folder() { const name = await mkdtemp(path.join(tmpdir(), 'knowledge-test-')); folders.push(name); return name; }
afterEach(async () => { await Promise.all(folders.splice(0).map(name => rm(name, { recursive: true, force: true }))); });
const note = (name: string, text: string) => parseNote(name, Buffer.from(text));

describe('personal Markdown knowledge', () => {
    test('preserves properties, line references and headings while excluding fenced code links', () => {
        const parsed = note('Release.md', '---\r\ntitle: 发布规则\r\naliases: [发布规范]\r\ntags: [release]\r\n---\r\n# 检查\r\n必须提供迁移说明。\r\n```md\r\n# not a heading\r\n[[NotANote]]\r\n```\r\n## 下一步\r\n`[[IgnoreInline]]` 参考 [[Project#范围|项目]]。');
        expect(parsed).toMatchObject({ title: '发布规则', aliases: ['发布规范'], tags: ['release'], headings: ['检查', '下一步'] });
        expect(parsed.chunks[0]).toMatchObject({ lineStart: 6, lineEnd: 11, heading: '检查' });
        expect(parsed.chunks[0]!.text).not.toContain('aliases:');
        expect(parsed.links).toHaveLength(1);
        expect(parsed.links[0]).toMatchObject({ target: 'Project#范围', label: '项目', line: 13 });
        expect(note('Long.md', 'a'.repeat(4500)).chunks.every(chunk => chunk.text.length <= 2000)).toBe(true);
        expect(() => note('Links.md', '[[Target]] '.repeat(257))).toThrow('link budget');
        expect(() => note('Bad.md', '---\ntags: [broken\n---\nhello')).toThrow();
    });

    test('distinguishes aliases, relative links, ambiguous names, attachments and scope escapes', () => {
        const notes = [
            note('folder/Entry.md', '[[Alias]] [[Duplicate]] ![[picture.png]] [[Missing]] [relative](../Policy.md#Rules) [[../../outside]] [[Policy#^block]] [[100%]]'),
            note('Policy.md', '---\naliases: [Alias]\n---\n# Rules\nPolicy'),
            note('a/Duplicate.md', '# First'), note('b/Duplicate.md', '# Second'),
            note('100%.md', '# Percent'),
        ];
        const links = resolveNoteLinks(notes).get('folder/Entry.md')!;
        expect(links.find(link => link.target === 'Alias')).toMatchObject({ status: 'resolved', paths: ['Policy.md'] });
        expect(links.find(link => link.target === 'Duplicate')).toMatchObject({ status: 'ambiguous', candidateCount: 2 });
        expect(links.find(link => link.target === 'picture.png')?.status).toBe('attachment');
        expect(links.find(link => link.target === 'Missing')?.status).toBe('missing');
        expect(links.find(link => link.format === 'markdown')).toMatchObject({ status: 'resolved', paths: ['Policy.md'], heading: 'Rules' });
        expect(links.find(link => link.target === '../../outside')?.status).toBe('outside_scope');
        expect(links.find(link => link.target === 'Policy#^block')?.status).toBe('unsupported_block');
        expect(links.find(link => link.target === '100%')?.status).toBe('resolved');
    });

    test('syncs additions, modifications, deletions and renames with stable citations', async () => {
        const root = await folder();
        await writeFile(path.join(root, 'Rule.md'), '# 发布规则\nAPI 变更必须提供迁移说明。');
        const source = new MarkdownKnowledgeSource({ root, vaultName: 'My Notes' });
        const first = await source.search('迁移说明 API');
        expect(first.hits[0]).toMatchObject({ path: 'Rule.md', lineStart: 1, lineEnd: 2 });
        expect(first.hits[0]!.openUri).toBe('obsidian://open?vault=My%20Notes&file=Rule.md');
        const same = await source.search('迁移说明 API');
        expect(same.hits[0]!.citationId).toBe(first.hits[0]!.citationId);
        expect(same.source.changedCount).toBe(0);
        await writeFile(path.join(root, 'Rule.md'), '# 发布规则\nAPI 变更无需迁移说明，需要人工确认。');
        const changed = await source.search('API');
        expect(changed.source.changed).toEqual(['Rule.md']);
        expect(changed.hits[0]!.documentVersion).not.toBe(first.hits[0]!.documentVersion);
        await rename(path.join(root, 'Rule.md'), path.join(root, 'Renamed.md'));
        const renamed = await source.sync();
        expect(renamed.added).toEqual(['Renamed.md']);
        expect(renamed.removed).toEqual(['Rule.md']);
        await rm(path.join(root, 'Renamed.md'));
        expect((await source.search('API')).hits).toEqual([]);
    });

    test('never indexes hidden paths, excluded folders or symlink targets', async () => {
        const root = await folder(), outside = await folder();
        await mkdir(path.join(root, 'private'));
        await mkdir(path.join(root, '.obsidian'));
        await writeFile(path.join(root, 'Public.md'), '# Public\nallowedword');
        await writeFile(path.join(root, 'private/Secret.md'), 'secretword');
        await writeFile(path.join(root, '.obsidian/Secret.md'), 'secretword');
        await writeFile(path.join(outside, 'Secret.md'), 'secretword');
        await symlink(path.join(outside, 'Secret.md'), path.join(root, 'Alias.md'));
        await symlink(outside, path.join(root, 'Other'));
        const source = new MarkdownKnowledgeSource({ root, exclude: ['private'] });
        const result = await source.search('secretword');
        expect(result.source.indexed).toBe(1);
        expect(result.source.skipped).toBe(4);
        expect(result.hits).toEqual([]);
        for (const exclude of ['../outside', '/private', '\\private', 'private/*', '.']) {
            expect(() => new MarkdownKnowledgeSource({ root, exclude: [exclude] })).toThrow();
        }
    });

    test('a failed scan cannot silently return stale or partially indexed notes', async () => {
        const root = await folder();
        await writeFile(path.join(root, 'First.md'), 'oldword');
        const source = new MarkdownKnowledgeSource({ root, maxFiles: 1 });
        await source.sync();
        await writeFile(path.join(root, 'Second.md'), 'newword');
        await expect(source.search('oldword')).rejects.toThrow('file budget');
        await rm(path.join(root, 'Second.md'));
        expect((await source.search('oldword')).hits).toHaveLength(1);
        await rm(root, { recursive: true });
        await expect(source.search('oldword')).rejects.toThrow();
    });

    test('reports invalid or oversized notes and drops their previous indexed versions', async () => {
        const root = await folder();
        await writeFile(path.join(root, 'First.md'), 'oldword');
        const source = new MarkdownKnowledgeSource({ root, maxFileBytes: 100 });
        await source.sync();
        await writeFile(path.join(root, 'First.md'), 'x'.repeat(101));
        const result = await source.search('oldword');
        expect(result.source.failed).toBe(1);
        expect(result.source.partial).toBe(true);
        expect(result.source.removed).toEqual(['First.md']);
        expect(result.hits).toEqual([]);
        await writeFile(path.join(root, 'First.md'), '---\nnot an object\n---\noldword');
        expect((await source.sync()).failures[0]!.reason).toContain('object');
        await writeFile(path.join(root, 'First.md'), 'a'.repeat(50));
        await writeFile(path.join(root, 'Second.md'), 'b'.repeat(50));
        await expect(new MarkdownKnowledgeSource({ root, maxTotalBytes: 60 }).sync()).rejects.toThrow('total byte budget');
    });

    test('validates queries before IO and honors cancellation', async () => {
        const source = new MarkdownKnowledgeSource({ root: '/not-a-real-knowledge-root' });
        await expect(source.search(' ')).rejects.toThrow();
        await expect(source.search('word', 11)).rejects.toThrow();
        const controller = new AbortController();
        controller.abort(new Error('cancel knowledge'));
        await expect(source.search('word', 5, controller.signal)).rejects.toThrow('cancel knowledge');
    });

    test('the shipped profile executes through a real Host and retains versioned JSON evidence', async () => {
        const selected = await loadPluginConfiguration(`${import.meta.dir}/../profiles/agents/knowledge-demo.yaml`);
        expect(selected.plugins[0]!.manifest.id).toBe('knowledge.markdown');
        const store = new InMemoryPersistentKeyValueStore();
        const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local' }, groups: [] } }) as any,
            10, undefined, [], { plugins: selected.plugins, pluginConfig: selected.config });
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: 'knowledge-test' });
        const input = { operation: 'search', query: '迁移说明 API' };
        const result = await host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), KNOWLEDGE_MARKDOWN_CAPABILITY, input);
        expect(result.execution!.run.status).toBe('succeeded');
        const data = result.execution!.result.data as any;
        expect(data.retrieval).toBe('keyword');
        expect(data.hits[0].path).toBe('Release.md');
        const runId = result.execution!.run.id;
        await host.stop();
        const artifacts = await new PersistentAgentRunStore(store).listArtifacts(runId);
        expect(artifacts[0]).toMatchObject({ type: 'json', metadata: { privateKnowledge: true } });
        expect((artifacts[0]!.content as any).hits[0].citationId).toBe(data.hits[0].citationId);
        expect(host.toolRegistry.list()).toEqual([]);
        expect(host.registry.listBindings()).toEqual([]);
    });

    test('private source operations reject chat scopes and caller-controlled filesystem paths', async () => {
        const store = new InMemoryPersistentKeyValueStore();
        const host = new AgentHost(() => ({ store, config: { feishu: { bot_name: 'Local' }, groups: [] } }) as any,
            10, undefined, [], { plugins: [knowledgeMarkdownPlugin], pluginConfig: { 'knowledge.markdown': { root: '/not-a-real-knowledge-root' } } });
        try {
            for (const [id, extra, input, expected] of [
                ['group', { chatId: 'group-1' }, { operation: 'sync' }, 'local manual scope'],
                ['path', {}, { operation: 'search', query: 'word', root: '/etc' }, 'Unrecognized key'],
            ] as const) {
                const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'manual', triggerId: id, ...extra });
                const result = await host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: input, replyPolicy: { mode: 'none' } }), KNOWLEDGE_MARKDOWN_CAPABILITY, input);
                expect(result.status).toBe('failed');
                expect(result.claim.error?.message).toContain(expected);
            }
        } finally { await host.stop(); }
    });

    test('the local CLI returns real citations without changing its source files', async () => {
        const root = await folder();
        const content = '# Release\nMigration notes are mandatory.';
        await writeFile(path.join(root, 'Release.md'), content);
        const command = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../src/scripts/knowledge.ts`, '--root', root, '--query', 'migration'], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exit] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
        expect(stderr).toBe('');
        expect(exit).toBe(0);
        expect(JSON.parse(stdout).result.hits[0].excerpt).toContain('Migration notes');
        expect(await readFile(path.join(root, 'Release.md'), 'utf8')).toBe(content);
    });
});
