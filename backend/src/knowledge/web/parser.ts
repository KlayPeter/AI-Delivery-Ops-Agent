/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// LinkeDOM and Readability require DOM types even in a server-only installation.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { contentHash, parseNote } from '../markdown/parser';
import type { PublicPage } from './network';

export function parsePage(originalUrl: string, page: PublicPage) {
    const mediaType = page.contentType.split(';')[0]!.trim().toLowerCase();
    if (!['text/html', 'text/plain', 'text/markdown', 'text/x-markdown'].includes(mediaType)) throw new Error('Knowledge page must be HTML, Markdown or plain text');
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(page.contentType)?.[1]?.toLowerCase();
    if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) throw new Error('Knowledge page charset must be UTF-8 or ASCII');
    let text = new TextDecoder('utf-8', { fatal: true }).decode(page.body);
    if (text.includes('\0')) throw new Error('Binary knowledge page is unsupported');
    let extraction = mediaType === 'text/html' ? 'readability' : 'text';
    let title = '';
    if (mediaType === 'text/html') {
        const { document } = parseHTML(text);
        if (document.querySelectorAll('*').length > 10_000) throw new Error('Knowledge HTML exceeds 10000 elements');
        for (const node of document.querySelectorAll('script,style,noscript,iframe,object,embed,form,nav,footer,header,[hidden],[aria-hidden="true"]')) node.remove();
        title = document.title || document.querySelector('h1')?.textContent || '';
        const main = document.querySelector('main,article')?.cloneNode(true) as Element | undefined;
        let article: ReturnType<Readability['parse']> = null;
        try { article = new Readability(document as unknown as Document, { maxElemsToParse: 10_000, charThreshold: 100, disableJSONLD: true }).parse(); }
        catch (error) { if (!main) throw error; }
        const root = article?.content ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : main;
        if (!root) throw new Error('No readable article or explicit main content found');
        if (!article?.content) extraction = 'main-text';
        title = article?.title || title;
        for (const node of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,section,article,li,pre,blockquote,tr,br')) {
            const heading = /^H[1-6]$/.test(node.tagName) ? `${'#'.repeat(Number(node.tagName[1]))} ` : '';
            node.before(root.ownerDocument!.createTextNode(`\n${heading}`));
            node.after(root.ownerDocument!.createTextNode('\n'));
        }
        text = String(root.textContent || '').split('\n').map(line => line.replace(/[\t\r ]+/g, ' ').trim()).filter(Boolean).join('\n');
    }
    if (!text.trim()) throw new Error('Knowledge page contains no readable text');
    const note = parseNote(originalUrl, Buffer.from(text));
    if (title.trim()) note.title = title.trim().slice(0, 256);
    else if (!note.headings.length) note.title = new URL(page.url).hostname;
    const rawVersion = contentHash(page.body);
    note.version = contentHash(JSON.stringify(['web-extract-1', page.url, mediaType, rawVersion, text, note.title]));
    return { note, rawVersion, mediaType, extraction, text };
}
