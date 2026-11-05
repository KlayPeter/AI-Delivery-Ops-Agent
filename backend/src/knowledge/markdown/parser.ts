import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import * as path from 'node:path';

export interface NoteLink { target: string; label: string; embedded: boolean; line: number; format: 'wiki' | 'markdown' }
export interface NoteChunk { text: string; heading: string; lineStart: number; lineEnd: number; index: number }
export interface MarkdownNote {
    path: string;
    version: string;
    title: string;
    aliases: string[];
    tags: string[];
    headings: string[];
    links: NoteLink[];
    chunks: NoteChunk[];
}

export const contentHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function stringList(value: unknown): string[] {
    const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    return values.filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0, 256)).filter(Boolean).slice(0, 50);
}

export function parseNote(filename: string, raw: Buffer): MarkdownNote {
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r\n?/g, '\n').split('\n');
    if (lines.some(line => line.includes('\0'))) throw new Error('Binary content is not a Markdown note');
    let start = 0;
    let properties: Record<string, unknown> = {};
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
        if (end < 0) throw new Error('Unclosed YAML properties');
        const parsed = parse(lines.slice(1, end).join('\n'), { maxAliasCount: 20 });
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('YAML properties must be an object');
        properties = parsed || {};
        start = end + 1;
    }
    const note: MarkdownNote = {
        path: filename, version: contentHash(raw), title: path.posix.basename(filename, path.posix.extname(filename)),
        aliases: stringList(properties.aliases), tags: stringList(properties.tags), headings: [], links: [], chunks: [],
    };
    let heading = '';
    let fence: { char: string; length: number } | undefined;
    let buffer = '';
    let firstLine = start + 1;
    let lastLine = firstLine;
    function flush() {
        if (buffer.trim()) note.chunks.push({ text: buffer, heading, lineStart: firstLine, lineEnd: lastLine, index: note.chunks.length });
        if (note.chunks.length > 2048) throw new Error('Note exceeds 2048 chunks');
        buffer = '';
    }
    function addLink(link: NoteLink) {
        if (note.links.length >= 256 || link.target.length > 1024 || link.label.length > 256) throw new Error('Note exceeds link budget');
        note.links.push(link);
    }
    for (let index = start; index < lines.length; index++) {
        const line = lines[index]!;
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        const insideCode = !!fence;
        if (marker) {
            if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
            else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]?.trim()) fence = undefined;
        }
        if (!insideCode && !marker) {
            const header = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
            if (header) {
                flush();
                heading = header[1]!.slice(0, 256);
                note.headings.push(heading);
            }
            const prose = line.replace(/(`+)(.*?)\1/g, '');
            const wiki = /(!)?\[\[([^\]\n]+)\]\]/g;
            for (const match of prose.matchAll(wiki)) {
                const [target, ...label] = match[2]!.split('|');
                addLink({ target: target!, label: label.join('|') || target!, embedded: !!match[1], line: index + 1, format: 'wiki' });
            }
            // shortcut: simple inline destinations only; use a Markdown parser for nested/reference links.
            const markdown = /(!)?\[([^\]\n]*)\]\(([^)\n]+)\)/g;
            for (const match of prose.matchAll(markdown)) {
                addLink({ target: match[3]!.trim().replace(/^<|>$/g, ''), label: match[2]!, embedded: !!match[1], line: index + 1, format: 'markdown' });
            }
        }
        for (let offset = 0; offset < Math.max(1, line.length); offset += 2000) {
            const part = line.slice(offset, offset + 2000);
            if (buffer && buffer.length + part.length + 1 > 2000) flush();
            if (!buffer) firstLine = index + 1;
            lastLine = index + 1;
            buffer += `${buffer ? '\n' : ''}${part}`;
        }
    }
    flush();
    const title = stringList(properties.title)[0] || note.headings[0];
    if (title) note.title = title.slice(0, 256);
    return note;
}

export interface ResolvedNoteLink extends NoteLink {
    status: 'resolved' | 'ambiguous' | 'missing' | 'external' | 'attachment' | 'outside_scope' | 'unsupported_block';
    paths: string[];
    heading?: string;
    candidateCount: number;
}

export function resolveNoteLinks(notes: readonly MarkdownNote[]): Map<string, ResolvedNoteLink[]> {
    const byPath = new Map(notes.map(note => [note.path, note]));
    const byName = new Map<string, Set<MarkdownNote>>();
    for (const note of notes) {
        for (const name of [path.posix.basename(note.path, path.posix.extname(note.path)), ...note.aliases]) {
            if (!byName.has(name)) byName.set(name, new Set());
            byName.get(name)!.add(note);
        }
    }
    return new Map(notes.map(note => [note.path, note.links.map(link => {
        const result: ResolvedNoteLink = { ...link, status: 'missing', paths: [], candidateCount: 0 };
        if (/^[a-z][a-z\d+.-]*:/i.test(link.target) || link.target.startsWith('//')) return { ...result, status: 'external' };
        let destination: string;
        try { destination = link.format === 'markdown' ? decodeURIComponent(link.target) : link.target; } catch { return result; }
        const [target = '', anchor] = destination.split('#', 2);
        result.heading = anchor;
        if (anchor?.startsWith('^')) return { ...result, status: 'unsupported_block' };
        const normalized = path.posix.normalize(target.replace(/\\/g, '/'));
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(note.path), normalized));
        if (path.posix.isAbsolute(normalized) || relative === '..' || relative.startsWith('../') || normalized.includes('\0')) return { ...result, status: 'outside_scope' };
        if (target && path.posix.extname(target) && path.posix.extname(target).toLowerCase() !== '.md') return { ...result, status: 'attachment' };
        const withExtension = (name: string) => /\.md$/i.test(name) ? name : `${name}.md`;
        const exact = byPath.get(withExtension(link.format === 'markdown' || target.startsWith('.') ? relative : normalized));
        const candidates = !target ? [note] : link.format === 'markdown' || target.startsWith('.') || normalized.includes('/')
            ? exact ? [exact] : [] : [...(byName.get(normalized.replace(/\.md$/i, '')) || [])];
        result.candidateCount = candidates.length;
        result.paths = candidates.map(candidate => candidate.path).sort().slice(0, 8);
        if (candidates.length > 1) result.status = 'ambiguous';
        else if (candidates.length === 1 && (!anchor || candidates[0]!.headings.includes(anchor))) result.status = 'resolved';
        return result;
    })]));
}
