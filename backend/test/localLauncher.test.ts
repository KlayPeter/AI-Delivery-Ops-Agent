import { afterEach, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ensureEnvironment, readyPort } from '../../scripts/local/launcher';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const temporary = async () => { const directory = await mkdtemp(path.join(tmpdir(), 'agent-launcher-')); directories.push(directory); return directory; };
const waitFor = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 6000;
    while (!await condition()) { if (Date.now() > deadline) throw new Error('launcher fixture timed out'); await Bun.sleep(30); }
};
const exists = async (file: string) => { try { await stat(file); return true; } catch { return false; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('readiness accepts only this launch, a loopback host and a valid actual port', () => {
    const event = { event: 'local-dev-ready', session: 'owned', hostname: '127.0.0.1', port: 18090 };
    expect(readyPort(JSON.stringify(event), 'owned')).toBe(18090);
    for (const value of [{ ...event, session: 'other' }, { ...event, hostname: '0.0.0.0' }, { ...event, port: 0 }, { ...event, port: 65536 }, { ...event, port: '8090' }, null]) expect(readyPort(JSON.stringify(value), 'owned')).toBeUndefined();
    expect(readyPort('ordinary log', 'owned')).toBeUndefined();
    expect(readyPort(' '.repeat(8193) + JSON.stringify(event), 'owned')).toBeUndefined();
});

test('initialization creates private configuration and preserves an existing file byte for byte', async () => {
    const directory = await temporary();
    await writeFile(path.join(directory, '.env.example'), 'PORT=0\n');
    await ensureEnvironment(directory);
    expect(await readFile(path.join(directory, '.env'), 'utf8')).toBe('PORT=0\n');
    if (process.platform !== 'win32') expect((await stat(path.join(directory, '.env'))).mode & 0o777).toBe(0o600);
    await writeFile(path.join(directory, '.env'), 'CUSTOM=keep\n');
    await ensureEnvironment(directory);
    expect(await readFile(path.join(directory, '.env'), 'utf8')).toBe('CUSTOM=keep\n');
});

async function fixture(extra: Record<string, string> = {}) {
    const directory = await temporary();
    for (const subdirectory of ['scripts/local', 'backend/node_modules/@prisma/client', 'frontend/node_modules/vite', 'bin']) await mkdir(path.join(directory, subdirectory), { recursive: true });
    await copyFile(path.resolve(import.meta.dir, '../../scripts/local/launcher.ts'), path.join(directory, 'scripts/local/launcher.ts'));
    for (const file of ['backend/node_modules/@prisma/client/package.json', 'frontend/node_modules/vite/package.json']) await writeFile(path.join(directory, file), '{}');
    await writeFile(path.join(directory, 'backend/package.json'), JSON.stringify({ scripts: { start: 'bun run server.ts' } }));
    await writeFile(path.join(directory, 'backend/server.ts'), `
import { writeFileSync } from 'node:fs';
writeFileSync('../backend.pid', String(process.pid));
if (process.env.BACKEND_FAIL) process.exit(7);
const server = Bun.serve({ hostname: process.env.HOST, port: 0, fetch: () => new Response('owned backend') });
console.log(JSON.stringify({ event: 'local-dev-ready', session: 'unrelated', hostname: '127.0.0.1', port: 12345 }));
if (!process.env.WRONG_MARKER) console.log(JSON.stringify({ event: 'local-dev-ready', session: process.env.LOCAL_DEV_SESSION, hostname: server.hostname, port: server.port }));
process.once('SIGTERM', () => setTimeout(() => { writeFileSync('../drained', 'yes'); process.exit(0); }, 700));
`);
    const pnpm = path.join(directory, 'bin/pnpm');
    await writeFile(pnpm, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
    if (process.env.HOLD_CHECK) { writeFileSync('checking.pid', String(process.pid)); setInterval(() => {}, 1000); }
    else console.log('10.33.2');
} else {
    writeFileSync('../frontend.pid', String(process.pid));
    Bun.spawn([process.execPath, '-e', "require('node:fs').writeFileSync('../descendant.pid', String(process.pid)); setInterval(() => {}, 1000)"], { stdout: 'inherit', stderr: 'inherit' });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(process.env.VITE_API_BASE) });
    console.log('FRONTEND_READY ' + server.port);
    if (process.env.FRONTEND_FAIL) setTimeout(() => process.exit(9), 200);
}
`);
    await chmod(pnpm, 0o755);
    const processHandle = Bun.spawn([process.execPath, '--no-env-file', 'scripts/local/launcher.ts'], {
        cwd: directory, env: { PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: directory, VITE_API_BASE: 'http://stale.invalid/api', ...extra }, stdout: 'pipe', stderr: 'pipe',
    });
    let output = '';
    const collect = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader(), decoder = new TextDecoder();
        while (true) { const chunk = await reader.read(); if (chunk.done) break; output += decoder.decode(chunk.value, { stream: true }); }
    };
    const streams = Promise.all([collect(processHandle.stdout), collect(processHandle.stderr)]);
    const stop = async () => { processHandle.kill('SIGINT'); await processHandle.exited; await streams; };
    return { directory, processHandle, streams, stop, output: () => output };
}

const processTest = process.platform === 'win32' ? test.skip : test;
processTest('starts frontend after owned backend, overrides stale API and drains both process groups on Ctrl+C', async () => {
    const f = await fixture();
    try {
        await waitFor(() => /FRONTEND_READY (\d+)/.test(f.output()));
        await waitFor(() => exists(path.join(f.directory, 'descendant.pid')));
        const port = Number(/FRONTEND_READY (\d+)/.exec(f.output())![1]);
        const api = await (await fetch(`http://127.0.0.1:${port}`)).text();
        expect(api).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api$/);
        expect(api).not.toContain('12345');
        expect(await (await fetch(api)).text()).toBe('owned backend');
    } finally { await f.stop(); }
    expect(await f.processHandle.exited).toBe(0);
    expect(await readFile(path.join(f.directory, 'drained'), 'utf8')).toBe('yes');
    for (const name of ['backend', 'frontend', 'descendant']) expect(alive(Number(await readFile(path.join(f.directory, `${name}.pid`), 'utf8')))).toBe(false);
}, 15000);

processTest('a failed frontend stops the backend and returns an error', async () => {
    const f = await fixture({ FRONTEND_FAIL: '1' });
    try {
        await waitFor(() => f.output().includes('意外退出'));
        expect(await f.processHandle.exited).toBe(1);
        expect(await exists(path.join(f.directory, 'drained'))).toBe(true);
        expect(alive(Number(await readFile(path.join(f.directory, 'backend.pid'), 'utf8')))).toBe(false);
    } finally { await f.stop(); }
}, 15000);

processTest('a backend failure never starts frontend or stops an unrelated local server', async () => {
    const unrelated = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unrelated') });
    const f = await fixture({ BACKEND_FAIL: '1' });
    try {
        expect(await f.processHandle.exited).toBe(1);
        await f.streams;
        expect(f.output()).toContain('后端提前退出');
        expect(await exists(path.join(f.directory, 'frontend.pid'))).toBe(false);
        expect(await (await fetch(unrelated.url)).text()).toBe('unrelated');
    } finally { await f.stop(); unrelated.stop(true); }
});

processTest('an unrelated readiness marker cannot start frontend', async () => {
    const f = await fixture({ WRONG_MARKER: '1' });
    try {
        await waitFor(() => f.output().includes('unrelated'));
        expect(await exists(path.join(f.directory, 'frontend.pid'))).toBe(false);
    } finally { await f.stop(); }
});

processTest('interrupting a prerequisite command stops that process too', async () => {
    const f = await fixture({ HOLD_CHECK: '1' });
    try { await waitFor(() => exists(path.join(f.directory, 'checking.pid'))); }
    finally { await f.stop(); }
    expect(alive(Number(await readFile(path.join(f.directory, 'checking.pid'), 'utf8')))).toBe(false);
    expect(await exists(path.join(f.directory, 'backend.pid'))).toBe(false);
});
