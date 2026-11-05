import { expect, test } from 'bun:test';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createWebCapturePlugin, CAPTURE_CAPABILITY } from '@/knowledge/capture/plugin';
import { buildConfig } from '@/core/config';
import { createTriggerEnvelope, createTriggerScope } from '@/platform/runtime/scope';

const context = () => ({ store: new InMemoryPersistentKeyValueStore(), config: buildConfig({}), feishu: {}, tapd: {}, intentParser: {} } as any);
test('web capture collects actual extracted text, versions and Markdown through a governed tool without a model', async () => {
    let calls = 0;
    const plugin = createWebCapturePlugin(async (url, maxBytes, timeout, signal) => {
        calls++; expect(maxBytes).toBe(512 * 1024); expect(timeout).toBe(10_000); expect(signal).toBeDefined();
        return { url, contentType: 'text/html; charset=utf-8', body: Buffer.from('<html><title>Capture test</title><nav>HIDDEN NAV</nav><main><h1>API rules</h1><p>Keep migration notes for every API change.</p><script>UNTRUSTED_SCRIPT</script></main></html>') };
    });
    const fixtureContext = context();
    const host = new AgentHost(() => fixtureContext, 1000, undefined, [], { plugins: [plugin] });
    try {
        const first = await host.runLocal(CAPTURE_CAPABILITY, { url: 'https://example.com/article#part' }, 'capture-first');
        expect(first.execution!.run).toMatchObject({ status: 'succeeded' });
        const data = first.execution!.result.data as any;
        expect(data.url).toBe('https://example.com/article'); expect(data.text).toContain('Keep migration notes');
        expect(data.text).not.toContain('HIDDEN NAV'); expect(data.text).not.toContain('UNTRUSTED_SCRIPT');
        expect(data.documentVersion).toHaveLength(64); expect(data.markdown).toContain('来源：');
        expect(data.markdown).toContain(data.documentVersion); expect(first.execution!.artifacts.map(artifact => artifact.type).sort()).toEqual(['json', 'markdown']);
        expect(first.execution!.result.metrics).toMatchObject({ modelCalls: 0, toolCalls: 1 });
        expect(host.web.pages()[0]?.path).toBe('/capture');
        await host.runLocal(CAPTURE_CAPABILITY, { url: 'https://example.com/article#part' }, 'capture-first'); expect(calls).toBe(1);
        for (const url of ['http://127.0.0.1/', 'https://user:secret@example.com/', 'file:///etc/passwd']) {
            expect((await host.runLocal(CAPTURE_CAPABILITY, { url }, crypto.randomUUID())).status).toBe('failed');
        }
        expect(calls).toBe(1);
    } finally { await host.stop(); }
    expect(host.web.pages()).toEqual([]);
});

test('capture rejects oversized or unreadable content and chat scopes without publishing false success', async () => {
    let calls = 0;
    const fixtureContext = context();
    const host = new AgentHost(() => fixtureContext, 1000, undefined, [], { plugins: [createWebCapturePlugin(async url => {
        calls++; return { url, contentType: 'text/plain', body: Buffer.from('x'.repeat(256 * 1024 + 1)) };
    })] });
    try {
        const scope = createTriggerScope({ workspaceId: 'workspace-default', botInstanceId: 'bot-default', triggerType: 'message', triggerId: 'chat', chatId: 'group' });
        expect((await host.dispatch(createTriggerEnvelope({ scope, occurredAt: new Date().toISOString(), payload: {}, replyPolicy: { mode: 'none' } }), CAPTURE_CAPABILITY, { url: 'https://example.com/' })).status).toBe('failed');
        expect(calls).toBe(0);
        const result = await host.runLocal(CAPTURE_CAPABILITY, { url: 'https://example.com/' }, crypto.randomUUID());
        expect(result.status).toBe('failed'); expect(result.execution?.artifacts || []).toEqual([]);
    } finally { await host.stop(); }
});
