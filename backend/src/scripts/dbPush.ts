import { join } from 'node:path';
import { loadConfig } from '../core/config';
import { safeDeploySqlite } from '../core/sqliteDeployment';

const config = loadConfig();
const databasePath = join(config.data_path, 'data.db');
const configuredRetention = Number(process.env.SQLITE_DEPLOY_BACKUP_RETENTION || 5);
const backupRetention = Number.isInteger(configuredRetention) && configuredRetention > 0
    ? configuredRetention
    : 5;

try {
    const result = await safeDeploySqlite({
        databasePath,
        backupRetention,
        cwd: process.cwd(),
    });
    console.info(JSON.stringify({
        event: 'sqlite_deploy_succeeded',
        database_path: result.databasePath,
        backup_path: result.backupPath || null,
    }));
} catch (error: any) {
    console.error(JSON.stringify({
        event: 'sqlite_deploy_failed',
        database_path: databasePath,
        error: error?.message || String(error),
    }));
    process.exit(1);
}
