import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SQLitePersistentKeyValueStore } from '@/platform/persistence/sqliteStore';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function filename() {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-local-state-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    return path.join(root, 'state.sqlite');
}
describe('private local runtime state', () => {
    test('persists the KV contract across restart, with atomic claims and comparisons', async () => {
        const file = await filename(), store = await SQLitePersistentKeyValueStore.open(file);
        cleanup.push(() => store.close());
        expect(await store.claimIdempotencyKey('prefix:%_a', { version: 1 })).toBe(true);
        expect(await store.claimIdempotencyKey('prefix:%_a', { version: 2 })).toBe(false);
        expect(await store.compareAndSetIdempotencyKey('prefix:%_a', { version: 2 }, { version: 3 })).toBe(false);
        expect(await store.compareAndSetIdempotencyKey('prefix:%_a', { version: 1 }, { version: 3 })).toBe(true);
        await store.setIdempotencyKey('prefix:other', null);
        expect(await store.listIdempotencyEntries('prefix:%_')).toEqual([{ key: 'prefix:%_a', value: { version: 3 } }]);
        expect((await Promise.all(Array.from({ length: 10 }, (_, index) => store.claimIdempotencyKey('race', index)))).filter(Boolean)).toHaveLength(1);
        await expect(store.setIdempotencyKey('bad', undefined)).rejects.toThrow('JSON serializable');
        for (const name of await readdir(path.dirname(file))) expect((await stat(path.join(path.dirname(file), name))).mode & 0o077).toBe(0);
        store.close(); store.close();
        const reopened = await SQLitePersistentKeyValueStore.open(file); cleanup.push(() => reopened.close());
        expect(await reopened.getIdempotencyValue<{ version: number }>('prefix:%_a')).toEqual({ version: 3 });
        expect(await reopened.getIdempotencyValue('missing')).toBeNull();
    });

    test('an overlapping session cannot trigger recovery of another live host', async () => {
        const file = await filename(), store = await SQLitePersistentKeyValueStore.open(file); cleanup.push(() => store.close());
        for (let attempt = 0; attempt < 3; attempt++) await expect(SQLitePersistentKeyValueStore.open(file)).rejects.toThrow('already in use');
        await Promise.all(Array.from({ length: 3 }, () => expect(SQLitePersistentKeyValueStore.open(file)).rejects.toThrow('already in use')));
        const module = `${import.meta.dir}/../src/platform/persistence/sqliteStore.ts`;
        const child = Bun.spawn([process.execPath, '-e', `import {SQLitePersistentKeyValueStore} from ${JSON.stringify(module)}; try {await SQLitePersistentKeyValueStore.open(Bun.argv[1]); process.exitCode=2;} catch(error) {console.error(error.message); process.exitCode=1;}`, file], { stdout: 'pipe', stderr: 'pipe' });
        const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        expect(exit).toBe(1); expect(stderr).toContain('already in use');
        await store.setIdempotencyKey('still-active', true);
        expect(await store.getIdempotencyValue<boolean>('still-active')).toBe(true);
    });

    test('refuses symlinks, shared permissions and unrelated databases without replacing their contents', async () => {
        const file = await filename(), original = `${file}.original`;
        await writeFile(original, 'do not replace', { mode: 0o600 }); await symlink(original, file);
        await expect(SQLitePersistentKeyValueStore.open(file)).rejects.toThrow();
        expect(await readFile(original, 'utf8')).toBe('do not replace');
        await rm(file); await link(original, file);
        await expect(SQLitePersistentKeyValueStore.open(file)).rejects.toThrow('single-link');
        await rm(file); await writeFile(file, '', { mode: 0o644 }); await chmod(file, 0o644);
        await expect(SQLitePersistentKeyValueStore.open(file)).rejects.toThrow('0600');
        await chmod(file, 0o600);
        const foreign = new Database(file); foreign.exec('CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'keep\')'); foreign.close();
        await expect(SQLitePersistentKeyValueStore.open(file)).rejects.toThrow('another application');
        const check = new Database(file); expect(check.query<{ value: string }, []>('SELECT value FROM unrelated').get()!.value).toBe('keep'); check.close();
    });

    test('process death releases the session lock while preserving committed records', async () => {
        const file = await filename();
        const module = `${import.meta.dir}/../src/platform/persistence/sqliteStore.ts`;
        const script = `import {SQLitePersistentKeyValueStore} from ${JSON.stringify(module)}; const store=await SQLitePersistentKeyValueStore.open(Bun.argv[1]); await store.setIdempotencyKey('saved',{ok:true}); console.log('ready'); setInterval(()=>{},1000);`;
        const child = Bun.spawn([process.execPath, '-e', script, file], { stdout: 'pipe', stderr: 'pipe' });
        cleanup.push(() => { child.kill(); });
        const reader = child.stdout.getReader(); const first = await reader.read(); reader.releaseLock();
        expect(new TextDecoder().decode(first.value)).toContain('ready');
        child.kill('SIGKILL'); await child.exited;
        const reopened = await SQLitePersistentKeyValueStore.open(file); cleanup.push(() => reopened.close());
        expect(await reopened.getIdempotencyValue<{ ok: boolean }>('saved')).toEqual({ ok: true });
    });
});
