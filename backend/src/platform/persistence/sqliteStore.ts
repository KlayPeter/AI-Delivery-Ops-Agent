import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { PersistentKeyValueStore } from './keyValueStore';

const APPLICATION_ID = 0x444f4153;

async function privateFile(filename: string) {
    const handle = await open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0), 0o600);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('Local state must be a single-link private regular file with mode 0600');
    } finally { await handle.close(); }
}

export class SQLitePersistentKeyValueStore implements PersistentKeyValueStore {
    private closed = false;
    private constructor(readonly filename: string, private readonly db: Database, private readonly lock: Database) {}

    static async open(filename: string): Promise<SQLitePersistentKeyValueStore> {
        if (!filename.trim() || filename.includes('\0')) throw new Error('A local state filename is required');
        const resolved = path.resolve(filename);
        await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
        const canonical = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
        await privateFile(canonical);
        await privateFile(`${canonical}.lock`);
        const lock = new Database(`${canonical}.lock`, { strict: true });
        let db: Database | undefined;
        try {
            // A separate SQLite transaction holds an OS-backed session lock without delaying state commits.
            lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
            db = new Database(canonical, { strict: true });
            const id = db.query<{ application_id: number }, []>('PRAGMA application_id').get()!.application_id;
            const objects = db.query<{ count: number }, []>('SELECT count(*) AS count FROM sqlite_master').get()!.count;
            const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
            if (id !== APPLICATION_ID && !(id === 0 && objects === 0 && version === 0)) throw new Error('Local state file belongs to another application');
            if (id === APPLICATION_ID && version !== 1) throw new Error('Unsupported local state schema version');
            if (id === 0) db.transaction(() => {
                db!.exec(`CREATE TABLE agent_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
            })();
            db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
            return new SQLitePersistentKeyValueStore(canonical, db, lock);
        } catch (error: any) {
            db?.close(); lock.close();
            if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') throw new Error('Local state is already in use by another session');
            throw error;
        }
    }

    async claimIdempotencyKey(key: string, value: unknown): Promise<boolean> {
        return this.db.query('INSERT OR IGNORE INTO agent_kv (key,value) VALUES (?,?)').run(key, this.encode(value)).changes === 1;
    }
    async setIdempotencyKey(key: string, value: unknown): Promise<void> {
        this.db.query('INSERT INTO agent_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, this.encode(value));
    }
    async getIdempotencyValue<T = unknown>(key: string): Promise<T | null> {
        const row = this.db.query<{ value: string }, [string]>('SELECT value FROM agent_kv WHERE key=?').get(key);
        return row ? JSON.parse(row.value) as T : null;
    }
    async listIdempotencyEntries<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>> {
        return this.db.query<{ key: string; value: string }, [string, string]>('SELECT key,value FROM agent_kv WHERE substr(key,1,length(?))=? ORDER BY key').all(prefix, prefix)
            .map(row => ({ key: row.key, value: JSON.parse(row.value) as T }));
    }
    async compareAndSetIdempotencyKey(key: string, expected: unknown, next: unknown): Promise<boolean> {
        return this.db.query('UPDATE agent_kv SET value=? WHERE key=? AND value=?').run(this.encode(next), key, this.encode(expected)).changes === 1;
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { this.db.close(); } finally { this.lock.close(); }
    }
    private encode(value: unknown): string {
        const json = JSON.stringify(value);
        if (json === undefined) throw new Error('Local state values must be JSON serializable');
        return json;
    }
}
