import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    assertSqliteIntegrity,
    createSqliteBackup,
    pruneSqliteBackups,
    safeDeploySqlite,
} from '@/core/sqliteDeployment';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'delivery-ops-sqlite-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    while (temporaryDirectories.length) {
        rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    }
});

describe('safe SQLite deployment', () => {
    test('creates an integrity-checked snapshot that preserves existing data', () => {
        const directory = temporaryDirectory();
        const databasePath = join(directory, 'data.db');
        const database = new Database(databasePath);
        database.run('CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        database.run("INSERT INTO facts (value) VALUES ('kept')");
        database.close();

        const backupPath = createSqliteBackup(databasePath, 5, new Date('2026-07-29T03:30:00Z'));
        expect(backupPath).toBeTruthy();
        expect(statSync(backupPath!).size).toBeGreaterThan(0);
        assertSqliteIntegrity(backupPath!);

        const backup = new Database(backupPath!, { readonly: true });
        expect(backup.query('SELECT value FROM facts').get()).toEqual({ value: 'kept' });
        backup.close();
    });

    test('keeps only the configured number of deployment backups', () => {
        const directory = temporaryDirectory();
        const backupDirectory = join(directory, 'backups');
        mkdirSync(backupDirectory);
        for (let index = 0; index < 4; index++) {
            const path = join(backupDirectory, `data.db.pre-deploy-${index}.bak`);
            writeFileSync(path, String(index));
            const modifiedAt = new Date(2026, 0, index + 1);
            utimesSync(path, modifiedAt, modifiedAt);
        }

        const removed = pruneSqliteBackups(backupDirectory, 'data.db', 2);
        expect(removed).toHaveLength(2);
        expect(readdirSync(backupDirectory).sort()).toEqual([
            'data.db.pre-deploy-2.bak',
            'data.db.pre-deploy-3.bak',
        ]);
    });

    test('rejects a corrupted non-empty database before deployment', () => {
        const directory = temporaryDirectory();
        const databasePath = join(directory, 'data.db');
        writeFileSync(databasePath, 'not-a-sqlite-database');
        expect(() => assertSqliteIntegrity(databasePath)).toThrow();
    });

    test('initializes a new database before running the real Prisma schema push', async () => {
        const directory = temporaryDirectory();
        const databasePath = join(directory, 'data.db');
        const cwd = join(import.meta.dir, '..');

        const first = await safeDeploySqlite({ databasePath, cwd, backupRetention: 2 });
        expect(first.backupPath).toBeUndefined();
        assertSqliteIntegrity(databasePath);

        const database = new Database(databasePath, { readonly: true });
        expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Task'").get()).toEqual({
            name: 'Task',
        });
        database.close();

        const second = await safeDeploySqlite({ databasePath, cwd, backupRetention: 2 });
        expect(second.backupPath).toBeTruthy();
        assertSqliteIntegrity(second.backupPath!);
    }, 20_000);
});
