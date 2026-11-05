import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function readyPort(line: string, session: string): number | undefined {
    if (line.length > 8192) return;
    try {
        const value = JSON.parse(line);
        if (value?.event === 'local-dev-ready' && value.session === session && value.hostname === '127.0.0.1'
            && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) return value.port;
    } catch {}
}

export async function ensureEnvironment(backend: string): Promise<void> {
    try { await writeFile(path.join(backend, '.env'), await readFile(path.join(backend, '.env.example')), { flag: 'wx', mode: 0o600 }); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
}

async function main() {
    if (process.argv.slice(2).some(argument => argument !== '--setup')) throw new Error('用法：bun run setup:local（首次）或 bun run local');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const backend = path.join(root, 'backend'), frontend = path.join(root, 'frontend');
    const children = new Set<ChildProcess>();
    let interrupted = false, interrupt!: () => void;
    const stopped = new Promise<void>(resolve => { interrupt = resolve; });
    const onSignal = () => { interrupted = true; interrupt(); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    const stop = (child: ChildProcess, force = false) => {
        if (!child.pid) return;
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' }).on('error', () => {});
            } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error: any) { if (error.code !== 'ESRCH') console.error('停止本次子进程失败：', error.message); }
    };
    const alive = (child: ChildProcess) => {
        if (!child.pid) return false;
        if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
        try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const launch = (label: string, command: string[], cwd: string, env = process.env, onLine?: (line: string) => void) => {
        if (interrupted) throw new Error('启动已中止');
        console.log(`[local] ${label}`);
        const executable = command[0]!;
        const child = process.platform === 'win32' && executable === 'pnpm'
            ? spawn('cmd.exe', ['/d', '/s', '/c', ['pnpm', ...command.slice(1)].join(' ')], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] })
            : spawn(executable, command.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
        children.add(child);
        let buffer = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            process.stdout.write(chunk);
            if (!onLine) return;
            const lines = (buffer + chunk).split('\n'); buffer = lines.pop() || '';
            if (buffer.length > 8192) buffer = '';
            for (const line of lines) onLine(line);
        });
        const exited = new Promise<number>((resolve, reject) => {
            child.once('error', error => reject(new Error(`${label} 无法启动：${error.message}。请确认 Bun、Node.js 和 pnpm 10 已安装。`)));
            child.once('exit', code => resolve(code ?? 1));
        });
        return { child, exited };
    };
    const run = async (label: string, command: string[], cwd: string) => {
        const running = launch(label, command, cwd);
        try {
            const code = await Promise.race([running.exited, stopped.then(() => { throw new Error('启动已中止'); })]);
            if (code) throw new Error(`${label}失败（退出码 ${code}），请检查上方输出后重试。`);
        } finally {
            stop(running.child);
            if (!alive(running.child)) children.delete(running.child);
        }
    };
    const bun = process.execPath;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await run('检查 pnpm', ['pnpm', '--version'], root);
        if (process.argv.includes('--setup')) {
            await ensureEnvironment(backend);
            await run('安装后端锁定依赖', [bun, 'install', '--frozen-lockfile'], backend);
            await run('安装前端锁定依赖', ['pnpm', 'install', '--frozen-lockfile'], frontend);
            await run('生成 Prisma Client', [bun, path.join(backend, 'node_modules/prisma/build/index.js'), 'generate'], backend);
            await run('安全同步本地数据库', [bun, 'run', 'db:push'], backend);
        }
        for (const file of ['backend/node_modules/@prisma/client/package.json', 'frontend/node_modules/vite/package.json']) {
            try { await access(path.join(root, file)); } catch { throw new Error('本地依赖未就绪，请先在仓库根目录运行 bun run setup:local'); }
        }
        const session = randomUUID();
        let announce!: (port: number) => void;
        const ready = new Promise<number>(resolve => { announce = resolve; });
        // Run the entry directly so package-script wrappers cannot forward a second stop signal.
        const server = launch('启动本地后端', [bun, 'src/index.ts'], backend, { ...process.env, HOST: '127.0.0.1', LOCAL_DEV_SESSION: session }, line => {
            const port = readyPort(line, session); if (port) announce(port);
        });
        const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('后端在 60 秒内未完成启动；请检查日志、端口与配置。')), 60_000); });
        const port = await Promise.race([ready, timeout, server.exited.then(code => { throw new Error(`后端提前退出（${code}）；首次使用请运行 bun run setup:local。`); }), stopped.then(() => { throw new Error('启动已中止'); })]);
        clearTimeout(timer);
        const api = `http://127.0.0.1:${port}/api`;
        console.log(`[local] 后端已监听 ${api}；前端地址见下方 Vite 输出。Ctrl+C 一起停止。`);
        const client = launch('启动本地前端', ['pnpm', 'dev', '--host', '127.0.0.1'], frontend, { ...process.env, VITE_API_BASE: api });
        const result = await Promise.race([server.exited.then(code => ({ label: '后端', code })), client.exited.then(code => ({ label: '前端', code })), stopped.then((): undefined => undefined)]);
        if (result && !interrupted) throw new Error(`${result.label}意外退出（${result.code}），已停止本次其他服务。`);
    } catch (error) { if (!interrupted) throw error; }
    finally {
        clearTimeout(timer);
        for (const child of children) stop(child);
        // Allow in-flight work to drain; bound shutdown if an owned process hangs.
        const deadline = Date.now() + 10_000;
        while ([...children].some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        for (const child of children) if (alive(child)) stop(child, true);
        process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    }
}

if (import.meta.main) main().catch(error => { console.error(`[local] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
