import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownKnowledgeSource } from '@/knowledge/markdown/source';
import { WebKnowledgeSource } from '@/knowledge/web/source';
import { versionRequest, versionResult, acceptsQuoteChecks, versionInputSchema } from '@/knowledge/versions';

test('quote probes use the full normalized body across current chunk boundaries and keep source scope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'quote-probes-'));
    try {
        const file = path.join(root, 'Rule.md'); await writeFile(file, '# Rule\nStay on version one.');
        const source = new MarkdownKnowledgeSource({ root }), hit = (await source.search('version')).hits[0]!;
        const document = { path: hit.path, sourceKey: hit.sourceKey, documentVersion: hit.documentVersion, quotes: ['Stay on version one.'] };
        expect((await source.versions({ documents: [document] })).documents[0]!.quoteChecks).toEqual([{ quote: 'Stay on version one.', status: 'found' }]);
        await writeFile(file, '# Rule\r\n' + 'x'.repeat(1990) + 'Stay on version one.\r\nOther context.');
        const moved = versionResult.parse(await source.versions({ documents: [document] })).documents[0]!;
        expect(moved.status).toBe('changed'); expect(moved.quoteChecks?.[0]!.status).toBe('found');
        const wrong = (await source.versions({ documents: [{ ...document, sourceKey: '0'.repeat(64) }] })).documents[0]!;
        expect(wrong.status).toBe('out_of_scope'); expect(wrong.quoteChecks).toBeUndefined();
        await writeFile(file, '# Rule\nSwitch to version two.');
        expect((await source.versions({ documents: [document] })).documents[0]!.quoteChecks?.[0]!.status).toBe('not_found');
        await rm(file);
        const missing = (await source.versions({ documents: [document] })).documents[0]!;
        expect(missing.status).toBe('missing'); expect(missing.quoteChecks).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('web quotes refer to extracted current body while failures reveal no quote result or stale content', async () => {
    const url = 'https://example.com/rule'; let text = '# Rule\nStay on version one.', failed = false;
    const source = new WebKnowledgeSource({ urls: [url] }, async () => { if (failed) throw new Error('offline'); return { url, body: Buffer.from(text), contentType: 'text/markdown' }; });
    const hit = (await source.search('version')).hits[0]!;
    const reference = { path: hit.path, sourceKey: hit.sourceKey, documentVersion: hit.documentVersion };
    const old = (await source.versions({ documents: [reference] })).documents[0]!;
    expect(old).toEqual({ ...reference, status: 'current', currentVersion: reference.documentVersion });
    const document = { ...reference, quotes: ['Stay on version one.'] };
    expect((await source.versions({ documents: [document] })).documents[0]!.quoteChecks?.[0]!.status).toBe('found');
    text = '# Rule\nSwitch to version two.';
    expect((await source.versions({ documents: [document] })).documents[0]!.quoteChecks?.[0]!.status).toBe('not_found');
    failed = true;
    const unavailable = versionResult.parse(await source.versions({ documents: [document] })).documents[0]!;
    expect(unavailable.status).toBe('unavailable'); expect(unavailable.quoteChecks).toBeUndefined();
});

test('quote contracts bound per-document/count/UTF-8 bytes before IO and advertise support explicitly', async () => {
    const reference = { path: 'Rule.md', sourceKey: 'a'.repeat(64), documentVersion: 'b'.repeat(64) };
    const source = new MarkdownKnowledgeSource({ root: '/nonexistent-quote-contract-test' });
    for (const quotes of [[], [''], ['same', 'same'], Array.from({ length: 33 }, (_, index) => String(index)), ['x'.repeat(2001)]]) {
        await expect(source.versions({ documents: [{ ...reference, quotes }] })).rejects.toThrow();
    }
    expect(() => versionRequest.parse({ documents: Array.from({ length: 7 }, () => ({ ...reference, quotes: Array.from({ length: 32 }, (_, i) => String(i)) })) })).toThrow('budget');
    expect(() => versionRequest.parse({ documents: [{ ...reference, quotes: Array.from({ length: 32 }, (_, i) => `${i}` + '字'.repeat(1000)) }] })).toThrow('budget');
    expect(acceptsQuoteChecks(versionInputSchema)).toBe(true); expect(acceptsQuoteChecks({ type: 'object' })).toBe(false);
    expect(() => versionResult.parse({ checkedAt: new Date().toISOString(), documents: [{ ...reference, status: 'out_of_scope', quoteChecks: [{ quote: 'private', status: 'found' }] }] })).toThrow();
});
