import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

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
