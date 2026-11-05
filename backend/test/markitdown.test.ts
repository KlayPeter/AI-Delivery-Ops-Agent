import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentHost } from '@/platform/bootstrap/agentHost';
import { InMemoryPersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { createPluginApi } from '@/platform/workspace/api';
import { buildConfig } from '@/core/config';
import { markItDownPlugin, DOCUMENT_CAPABILITY } from '@/connectors/markitdown/plugin';
import { DocumentUploads } from '@/connectors/markitdown/uploads';
import { runMarkItDown } from '@/connectors/markitdown/process';

const python = process.env.MARKITDOWN_PYTHON || path.resolve('.data/markitdown/bin/python');
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(enabled = true) {
    const root = await mkdtemp(path.join(tmpdir(), 'document-plugin-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const ctx: any = { store: new InMemoryPersistentKeyValueStore(), config: { ...buildConfig({}), data_path: root }, feishu: {}, tapd: {}, intentParser: {} };
    const host = new AgentHost(() => ctx, 1000, undefined, [], { plugins: enabled ? [markItDownPlugin] : [], pluginConfig: { 'community.markitdown': { python } } });
    cleanup.push(() => host.stop()); await host.initialize();
    return { root, host, app: createPluginApi(host) };
}
const request = (name: string, bytes: Buffer, origin = 'http://localhost:15173') => new Request('http://localhost/api/documents/uploads', {
    method: 'POST', headers: { 'x-document-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', origin }, body: new Uint8Array(bytes),
});
function pdfFixture() {
    const content = 'BT /F1 12 Tf 72 720 Td (Public knowledge import fixture) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
    let result = '%PDF-1.4\n'; const offsets = [0];
    for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const start = Buffer.byteLength(result);
    result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return Buffer.from(result);
}
function docxFixture() {
    const code = `import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Personal knowledge document fixture</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`;
    const generated = Bun.spawnSync([python, '-I', '-c', code], { stdout: 'pipe', stderr: 'pipe' });
    expect(generated.exitCode).toBe(0); return Buffer.from(generated.stdout);
}
function officeFixture(extension: 'xlsx' | 'pptx') {
    const code = extension === 'xlsx' ? 'import io,sys; from openpyxl import Workbook; w=Workbook(); w.active.append(["Spreadsheet knowledge fixture"]); b=io.BytesIO(); w.save(b); sys.stdout.buffer.write(b.getvalue())'
        : 'import io,sys; from pptx import Presentation; from pptx.util import Inches; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(5),Inches(1)).text="Presentation knowledge fixture"; b=io.BytesIO(); p.save(b); sys.stdout.buffer.write(b.getvalue())';
    const generated = Bun.spawnSync([python, '-I', '-c', code], { stdout: 'pipe', stderr: 'pipe' });
    expect(generated.exitCode).toBe(0); return Buffer.from(generated.stdout);
}

for (const [name, content, text] of [
    ['example.pdf', pdfFixture, 'Public knowledge import fixture'],
    ['示例.docx', docxFixture, 'Personal knowledge document fixture'],
    ['example.xlsx', () => officeFixture('xlsx'), 'Spreadsheet knowledge fixture'],
    ['example.pptx', () => officeFixture('pptx'), 'Presentation knowledge fixture'],
] as const) test(`real upstream MarkItDown converts ${name} through upload, Tool and Agent artifacts`, async () => {
    const f = await fixture();
    const status = await (await f.app.handle(new Request('http://localhost/api/documents/status'))).json() as any;
    expect(status).toMatchObject({ available: true, version: '0.1.9' });
    const uploaded = await f.app.handle(request(name, content())); expect(uploaded.status).toBe(201);
    const input = await uploaded.json() as any, trigger = crypto.randomUUID();
    const result = await f.host.runLocal(DOCUMENT_CAPABILITY, { documentId: input.documentId }, trigger);
    expect(result.execution!.run).toMatchObject({ status: 'succeeded' });
    const data = result.execution!.result.data as any;
    expect(data.markdown).toContain(text); expect(data.source).toMatchObject({ name, sha256: input.sha256 });
    expect(result.execution!.result.metrics).toMatchObject({ modelCalls: 0, toolCalls: 1 });
    expect(result.execution!.artifacts.map(artifact => artifact.type).sort()).toEqual(['json', 'markdown']);
    expect(await readdir(path.join(f.root, 'document-uploads'))).toEqual([]);
    expect((await f.host.runLocal(DOCUMENT_CAPABILITY, { documentId: input.documentId }, trigger)).status).toBe('duplicate');
    expect(f.host.web.pages()[0]!.path).toBe('/documents');
}, 30_000);

test('document uploads reject unsafe names, scopes, symlinks and changed contents without crossing paths', async () => {
    const f = await fixture(), root = path.join(f.root, 'uploads'), uploads = new DocumentUploads(root);
    const saved = await uploads.save('note.txt', Buffer.from('original'));
    expect((await stat(path.join(root, `${saved.id}.bin`))).mode & 0o777).toBe(0o600);
    await expect(uploads.load(saved.id, { workspaceId: 'foreign', botInstanceId: 'bot-default' })).rejects.toThrow('工作区');
    await writeFile(path.join(root, `${saved.id}.bin`), 'changed');
    await expect(uploads.load(saved.id, { workspaceId: 'workspace-default', botInstanceId: 'bot-default' })).rejects.toThrow('变化');
    await rm(path.join(root, `${saved.id}.bin`)); await symlink(path.join(f.root, 'outside'), path.join(root, `${saved.id}.bin`));
    await expect(uploads.load(saved.id, { workspaceId: 'workspace-default', botInstanceId: 'bot-default' })).rejects.toThrow();
    for (const name of ['../private.pdf', 'folder/file.docx', 'https://example.com/document.pdf', 'macro.exe']) expect((await f.app.handle(request(name, Buffer.from('bad')))).status).toBe(400);
    expect((await f.app.handle(request('test.txt', Buffer.from('bad'), 'https://foreign.example'))).status).toBe(403);
    expect((await (await fixture(false)).app.handle(request('test.txt', Buffer.from('safe')))).status).toBe(404);
    expect(await readFile(path.join(root, `${saved.id}.json`), 'utf8')).toContain('note.txt');
}, 30_000);

test('real converter cancellation and output budgets fail explicitly', async () => {
    const controller = new AbortController();
    const converting = runMarkItDown(python, pdfFixture(), '.pdf', controller.signal);
    controller.abort(new Error('fixture cancellation'));
    await expect(converting).rejects.toThrow('fixture cancellation');
    await expect(runMarkItDown(python, Buffer.from('x'.repeat(600_000)), '.txt')).rejects.toThrow();
}, 30_000);
