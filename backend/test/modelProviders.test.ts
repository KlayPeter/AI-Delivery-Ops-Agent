import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateText } from 'ai';
import { buildConfig, type AIConfig } from '@/core/config';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { AiSdkModelGateway } from '@/platform/models/gateway';
import { ModelProviderRegistry, modelProviderId } from '@/platform/models/registry';
import { standardModelPlugins, standardModelProviders, modelProviderPlugin } from '@/platform/models/providers';
import { localModelEndpoint } from '@/platform/models/providers/ollama';
import { LocalConnections } from '@/platform/workspace/connections';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const config = (patch: Partial<AIConfig> = {}): AIConfig => ({ ...buildConfig({}).ai, provider: 'ollama', model: 'fixture-model', api_key: '', api_base: '', ...patch });
const completion = () => Response.json({ id: 'fixture-completion', object: 'chat.completion', created: 0, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
function server(handler: (request: Request) => Response | Promise<Response>) {
    const instance = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler }); cleanup.push(() => instance.stop(true)); return instance;
}

test('provider selection preserves cloud aliases, supports explicit Google and custom plugin IDs', () => {
    for (const provider of ['openai', 'openai-compatible', 'deepseek']) expect(modelProviderId(config({ provider }))).toBe('openai');
    expect(modelProviderId(config({ provider: 'google', model: 'custom-model' }))).toBe('google');
    expect(modelProviderId(config({ provider: 'openai', model: 'gemini-legacy' }))).toBe('google');
    expect(modelProviderId(config({ provider: 'ollama', model: 'gemini-local' }))).toBe('ollama');
    expect(modelProviderId(config({ provider: 'example.custom', model: 'gemini-custom' }))).toBe('example.custom');
    const registry = new ModelProviderRegistry(standardModelProviders);
    expect(registry.configured(config())).toBe(true);
    expect(registry.configured(config({ provider: 'openai' }))).toBe(false);
    expect(registry.configured(config({ provider: 'google' }))).toBe(false);
    const google = registry.resolve(config({ provider: 'google', api_key: 'fixture-key', model: 'custom-model' }));
    expect(typeof google === 'object' && google.provider).toContain('google');
});

test('Host has no implicit providers; model contributions release and roll back with their plugins', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'model-providers-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const context = { config: { ...buildConfig({}), data_path: root, ai: config() }, store: new InMemoryPersistentKeyValueStore(), feishu: {}, tapd: {} } as any;
    const host = new AgentHost(() => context, 1000, undefined, [], { plugins: [] }); cleanup.push(() => host.stop());
    await host.initialize(); expect(host.modelProviders.list()).toEqual([]); expect(host.isModelAvailable()).toBe(false);
    expect(() => host.modelGateway.resolve()).toThrow('not installed');
    const originalAI = context.config.ai; delete context.config.ai; expect(host.isModelAvailable()).toBe(false); context.config.ai = originalAI;
    const configured = new AgentHost(() => context, 1000, undefined, [], { plugins: standardModelPlugins }); cleanup.push(() => configured.stop());
    await configured.initialize(); expect(configured.isModelAvailable()).toBe(true); expect(configured.modelProviders.list()).toHaveLength(3);
    await configured.stop(); expect(configured.modelProviders.list()).toEqual([]); expect(configured.isModelAvailable()).toBe(false);
    const custom = modelProviderPlugin({ ...standardModelProviders[2], id: 'example.custom', name: 'Custom local model' });
    const failure = { manifest: { apiVersion: '1.0' as const, id: 'example.failure', name: 'Failure', version: '1.0.0', description: 'Rollback fixture', requires: ['model.example.custom'] }, apply() { throw new Error('fixture apply failure'); } };
    const failed = new AgentHost(() => context, 1000, undefined, [], { plugins: [custom, failure] }); cleanup.push(() => failed.stop());
    await expect(failed.initialize()).rejects.toThrow('fixture apply failure'); expect(failed.modelProviders.list()).toEqual([]);
});

test('provider registration rejects duplicates and stale disposers cannot remove a replacement', () => {
    const registry = new ModelProviderRegistry(), provider = standardModelProviders[2];
    const dispose = registry.register(provider); expect(() => registry.register(provider)).toThrow('Duplicate'); dispose();
    registry.register(provider); dispose(); expect(registry.list()).toHaveLength(1);
    expect(() => registry.register({ ...provider, id: '../invalid' })).toThrow('Invalid');
});

test('Ollama validates a fixed HTTP loopback endpoint and normalizes localhost without DNS', () => {
    expect(localModelEndpoint('').href).toBe('http://127.0.0.1:11434/v1');
    expect(localModelEndpoint('http://localhost:11434/').href).toBe('http://127.0.0.1:11434/v1');
    expect(localModelEndpoint('http://[::1]:11434/v1/').hostname).toBe('[::1]');
    for (const base of ['https://127.0.0.1/v1', 'http://example.com/v1', 'http://192.168.1.2/v1', 'http://127.0.0.1.evil.test/v1', 'http://key:secret@localhost/v1', 'http://localhost/v1?q=1', 'http://localhost/v1#fragment', 'http://localhost/v1?', 'http://localhost/other']) {
        expect(() => localModelEndpoint(base)).toThrow();
        expect(new AiSdkModelGateway(() => config({ api_base: base })).diagnostics().configured).toBe(false);
    }
});

test('real SDK keyless requests bypass global proxies and never forward a saved cloud key', async () => {
    let direct = 0, proxied = 0;
    const target = server(async request => {
        direct++; expect(request.headers.get('authorization')).toBeNull(); expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
        expect((await request.json() as any).model).toBe('fixture-model'); return completion();
    });
    const proxy = server(() => { proxied++; return new Response('Unexpected proxy use', { status: 502 }); });
    const code = `import { generateText } from 'ai'; import { AiSdkModelGateway } from './src/platform/models/gateway';
const gateway = new AiSdkModelGateway(() => (${JSON.stringify(config({ api_base: `${target.url}v1`, api_key: 'fixture-cloud-key-must-not-leave', use_proxy: true, proxy_url: proxy.url.href }))}));
const result = await generateText({ model: gateway.resolve(), prompt: 'ping', maxRetries: 0 }); console.log(result.text);`;
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', code], { cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env, HTTP_PROXY: proxy.url.href, HTTPS_PROXY: proxy.url.href, ALL_PROXY: proxy.url.href, http_proxy: proxy.url.href, https_proxy: proxy.url.href, all_proxy: proxy.url.href, NO_PROXY: '', no_proxy: '' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(exit).toBe(0); expect(stdout.trim()).toBe('OK'); expect(direct).toBe(1); expect(proxied).toBe(0);
});

for (const mode of ['redirect', 'compressed', 'oversized', 'cancel'] as const) test(`local transport rejects ${mode} responses and closes the connection`, async () => {
    const target = server(() => mode === 'redirect' ? new Response(null, { status: 307, headers: { location: 'https://example.com/' } })
        : mode === 'compressed' ? new Response('compressed', { headers: { 'content-encoding': 'gzip' } })
        : mode === 'oversized' ? new Response('x'.repeat(4 * 1024 * 1024 + 1))
        : new Promise(resolve => setTimeout(() => resolve(completion()), 1500)));
    const gateway = new AiSdkModelGateway(() => config({ api_base: `${target.url}v1` }));
    const started = Date.now();
    await expect(generateText({ model: gateway.resolve(), prompt: 'ping', maxRetries: 0, abortSignal: AbortSignal.timeout(mode === 'cancel' ? 100 : 2000) })).rejects.toThrow(mode === 'redirect' ? /redirects/ : mode === 'compressed' ? /Compressed/ : mode === 'oversized' ? /max size|4 MiB/i : /abort|timed out|timeout/i);
    if (mode === 'cancel') expect(Date.now() - started).toBeLessThan(1000);
});

test('oversized prompts fail before opening a local model connection', async () => {
    let requests = 0; const target = server(() => { requests++; return completion(); });
    const gateway = new AiSdkModelGateway(() => config({ api_base: `${target.url}v1` }));
    await expect(generateText({ model: gateway.resolve(), prompt: 'x'.repeat(4 * 1024 * 1024), maxRetries: 0 })).rejects.toThrow('4 MiB');
    expect(requests).toBe(0);
});

test('connection settings retain cloud credentials while selecting keyless local or installed custom providers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'model-connections-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'connections.json'), connections = new LocalConnections(file);
    await connections.save({ AI_PROVIDER: 'openai', AI_API_KEY: 'fixture-saved-cloud-key', AI_MODEL: 'cloud-model' });
    const local = await connections.save({ AI_PROVIDER: 'ollama', AI_API_BASE: '', AI_MODEL: 'local-model' });
    expect(local.secrets.AI_API_KEY).toBe(true); expect(JSON.stringify(local)).not.toContain('fixture-saved-cloud-key');
    expect(JSON.parse(await readFile(file, 'utf8')).AI_API_KEY).toBe('fixture-saved-cloud-key');
    const before = await readFile(file, 'utf8');
    await expect(connections.save({ AI_API_BASE: 'https://example.com/v1' })).rejects.toThrow('回环');
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(connections.save({ AI_PROVIDER: 'example.custom' })).rejects.toThrow('供应商');
    expect((await connections.save({ AI_PROVIDER: 'example.custom' }, ['example.custom'])).values.AI_PROVIDER).toBe('example.custom');
});

test('a third-party provider plugin executes through Host without modifying its gateway', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'custom-model-provider-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const target = server(() => completion());
    const context = { config: { ...buildConfig({}), data_path: root, ai: config({ provider: 'example.custom', api_base: `${target.url}v1` }) }, store: new InMemoryPersistentKeyValueStore(), feishu: {}, tapd: {} } as any;
    const plugin = modelProviderPlugin({ ...standardModelProviders[2], id: 'example.custom', name: 'Third-party fixture' });
    const host = new AgentHost(() => context, 1000, undefined, [], { plugins: [plugin] }); cleanup.push(() => host.stop());
    await host.initialize(); expect(host.modelProviders.list()).toEqual([{ id: 'example.custom', name: 'Third-party fixture' }]);
    expect((await generateText({ model: host.modelGateway.resolve(), prompt: 'ping', maxRetries: 0 })).text).toBe('OK');
    expect(host.modelGateway.diagnostics()).toMatchObject({ provider: 'example.custom', configured: true });
});
