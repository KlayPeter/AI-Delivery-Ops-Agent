import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const options = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
writeFileSync(options.pidFile, String(process.pid));
const record = (value: unknown) => appendFileSync(options.eventsFile, JSON.stringify(value) + '\n');
record({ event: 'started', explicitSecret: process.env.MCP_EXPLICIT_SECRET, unrelatedSecret: process.env.MCP_UNRELATED_SECRET });
const readTool = { name: 'read_note', description: 'Server text must not become the trusted tool description.',
    inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9./_-]+$' }, tag: { type: ['string', 'null'] } },
        ...(options.mode === 'bad_schema' ? { $ref: 'https://example.invalid/not-loaded' } : {}),
    },
    outputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
    ...(options.mode === 'task' ? { execution: { taskSupport: 'required' } } : {}),
};
const send = (id: string | number, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', async line => {
    const message = JSON.parse(line); record({ event: message.method, params: message.params });
    if (message.method === 'initialize') {
        if (options.mode === 'hang_init') return;
        if (options.mode === 'exit_init') process.exit(0);
        send(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test-fixture', version: '1.0.0' } });
    } else if (message.method === 'tools/list') {
        send(message.id, message.params?.cursor ? { tools: options.mode === 'missing' ? [] : options.mode === 'duplicate' ? [readTool, readTool] : [readTool] } : {
            tools: [{ name: 'unselected_write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], nextCursor: 'second',
        });
    } else if (message.method === 'tools/call') {
        if (options.mode === 'exit_call') process.exit(0);
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
        if (options.mode === 'error') { send(message.id, { isError: true, content: [{ type: 'text', text: 'private-failure-detail' }] }); return; }
        send(message.id, { content: [{ type: 'text', text: options.mode === 'oversize_frame' ? 'x'.repeat(3 * 1024 * 1024) : options.mode === 'oversize' ? 'x'.repeat(5000) : `Note: ${message.params.arguments.path}` }],
            structuredContent: { path: options.mode === 'invalid_output' ? 42 : message.params.arguments.path },
        });
    }
});
