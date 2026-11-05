import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { deliveryTeamPlugins } from '@/agents/plugins/builtins';
import { workspaceKnowledge } from '@/platform/workspace/knowledge';

test('local plugin configuration stays ignored in every folder while public examples remain visible', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'public-plugin-ignore-'));
    try {
        const ignore = await readFile(path.resolve(import.meta.dir, '../../.gitignore'));
        await writeFile(path.join(directory, '.gitignore'), ignore);
        const initialized = Bun.spawnSync(['git', '-c', 'init.templateDir=', 'init', '--quiet', directory]);
        expect(initialized.exitCode).toBe(0);
        const local = ['backend/profiles/agents/example.local.yaml', 'backend/examples/plugins.context7-http.local.yaml', 'plugins/example.local.yaml'];
        const check = (files: string[]) => Bun.spawnSync(['git', '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--stdin'], { cwd: directory, stdin: Buffer.from(files.join('\n') + '\n') });
        const privateFiles = check(local);
        expect(privateFiles.exitCode).toBe(0);
        expect(privateFiles.stdout.toString().trim().split('\n')).toEqual(local);
        const examples = check(['backend/examples/plugins.context7-http.yaml', 'backend/profiles/agents/team.yaml']);
        expect(examples.exitCode).toBe(1);
        expect(examples.stdout.toString()).toBe('');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('feature index tables retain their shape, unique identities, real Owner cards and declared count', async () => {
    const index = path.resolve(import.meta.dir, '../../docs/features/README.md');
    const markdown = await readFile(index, 'utf8');
    const table = (heading: string, next: string) => markdown.split(heading)[1]!.split(next)[0]!.split('\n')
        .filter(line => /^\| `/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
    const features = table('## 1. 当前功能', '## 2. 当前真实 Agent');
    expect(features.length).toBe(Number(/覆盖 (\d+) 个能力/.exec(markdown)![1]));
    expect(new Set(features.map(row => row[0])).size).toBe(features.length);
    for (const row of features) {
        expect(row).toHaveLength(5);
        const target = /^\[查看\]\(([^)]+\/FEATURE\.md)\)$/.exec(row[4]!);
        expect(target).not.toBeNull();
        const owner = await readFile(path.resolve(path.dirname(index), target![1]!), 'utf8');
        expect(/^feature_id:\s*(.+)$/m.exec(owner)![1]!.trim()).toBe(row[0]!.replace(/`/g, ''));
    }
    const agents = table('## 2. 当前真实 Agent', '## 3. 代码路径');
    for (const row of agents) expect(row).toHaveLength(4);
    expect(new Set(agents.map(row => row[0])).size).toBe(agents.length);
});

test('homepage composition counts match the actual default, GitHub and SDK plugin declarations', async () => {
    const markdown = await readFile(path.resolve(import.meta.dir, '../../README.md'), 'utf8');
    const keys = ['KNOWLEDGE_KIND', 'RELEASE_GITHUB_REPOSITORY', 'RELEASE_GITHUB_BRANCH', 'RELEASE_GITHUB_TOKEN'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        const defaults = [...deliveryTeamPlugins, ...workspaceKnowledge('/tmp/composition-count-test').plugins];
        process.env.RELEASE_GITHUB_REPOSITORY = 'example/project';
        const github = [...deliveryTeamPlugins, ...workspaceKnowledge('/tmp/composition-count-test').plugins];
        for (const [label, plugins] of [['默认 HTTP 工作台', defaults], ['配置 GitHub 后', github], ['团队 SDK', deliveryTeamPlugins]] as const) {
            const row = markdown.split('\n').find(line => line.startsWith(`| ${label} |`));
            expect(row).toBeDefined();
            const cells = row!.split('|').slice(1, -1).map(cell => cell.trim());
            let agents = 0;
            for (const plugin of plugins) agents += plugin.agents?.length || 0;
            expect(cells).toEqual([label, String(plugins.length), String(agents)]);
        }
    } finally {
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
});
