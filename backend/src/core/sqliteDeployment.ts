import { Database } from 'bun:sqlite';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SafeSqliteDeployOptions {
    databasePath: string;
    cwd: string;
    backupRetention?: number;
}

export interface SafeSqliteDeployResult {
    databasePath: string;
    backupPath?: string;
}

type IntegrityRow = { integrity_check?: string };

function sqliteString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

export function assertSqliteIntegrity(databasePath: string): void {
    if (!existsSync(databasePath) || statSync(databasePath).size === 0) return;
    const database = new Database(databasePath, { readonly: true });
    try {
        const rows = database.query('PRAGMA integrity_check').all() as IntegrityRow[];
        if (!rows.length || rows.some(row => row.integrity_check !== 'ok')) {
            const details = rows.map(row => row.integrity_check || 'unknown').join('; ');
            throw new Error(`SQLite integrity check failed: ${details || 'no result'}`);
        }
    } finally {
        database.close();
    }
}

export function pruneSqliteBackups(
    backupDirectory: string,
    databaseFilename: string,
    retention: number,
): string[] {
    if (!existsSync(backupDirectory)) return [];
    const prefix = `${databaseFilename}.pre-deploy-`;
    const candidates = readdirSync(backupDirectory)
        .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
        .map(name => {
            const path = join(backupDirectory, name);
            return { path, modifiedAt: statSync(path).mtimeMs };
        })
        .sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path));
    const removed = candidates.slice(Math.max(0, retention)).map(candidate => candidate.path);
    for (const path of removed) unlinkSync(path);
    return removed;
}

export function createSqliteBackup(
    databasePath: string,
    backupRetention: number = 5,
    now: Date = new Date(),
): string | undefined {
    if (!existsSync(databasePath) || statSync(databasePath).size === 0) return undefined;
    assertSqliteIntegrity(databasePath);

    const backupDirectory = join(dirname(databasePath), 'backups');
    mkdirSync(backupDirectory, { recursive: true });
    const timestamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
    const backupPath = join(
        backupDirectory,
        `${basename(databasePath)}.pre-deploy-${timestamp}-${randomUUID().slice(0, 8)}.bak`,
    );

    const database = new Database(databasePath);
    try {
        database.run('PRAGMA wal_checkpoint(FULL)');
        database.run(`VACUUM INTO ${sqliteString(backupPath)}`);
    } finally {
        database.close();
    }

    assertSqliteIntegrity(backupPath);
    pruneSqliteBackups(backupDirectory, basename(databasePath), Math.max(1, backupRetention));
    return backupPath;
}

export async function safeDeploySqlite(options: SafeSqliteDeployOptions): Promise<SafeSqliteDeployResult> {
    const databasePath = options.databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    const backupPath = createSqliteBackup(databasePath, Math.max(1, options.backupRetention ?? 5));
    if (!existsSync(databasePath) || statSync(databasePath).size === 0) {
        const database = new Database(databasePath);
        try {
            database.run('PRAGMA user_version = 0');
        } finally {
            database.close();
        }
    }

    const child = Bun.spawn({
        cmd: ['bunx', 'prisma', 'db', 'push', '--skip-generate'],
        cwd: options.cwd,
        env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
        stdout: 'inherit',
        stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(`Prisma db push failed with exit code ${exitCode}`);
    }

    assertSqliteIntegrity(databasePath);
    return { databasePath, backupPath };
}
