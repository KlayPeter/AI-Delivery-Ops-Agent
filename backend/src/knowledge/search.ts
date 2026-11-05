import { z } from 'zod';
import type { MarkdownNote } from './markdown/parser';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const terms = (text: string) => [...segmenter.segment(text.normalize('NFKC').toLowerCase())].filter(item => item.isWordLike).map(item => item.segment);

export const knowledgeSearchInput = z.object({
    query: z.string().trim().min(1).max(500).refine(text => terms(text).length > 0, 'Query must contain searchable words'),
    limit: z.number().int().min(1).max(10).default(5),
}).strict();

export function rankNotes(notes: readonly MarkdownNote[], query: string, signal?: AbortSignal) {
    const wanted = new Set(terms(query));
    return notes.flatMap(note => note.chunks.map(chunk => {
        signal?.throwIfAborted();
        const words = terms(`${note.title} ${note.aliases.join(' ')} ${note.tags.join(' ')} ${chunk.heading} ${chunk.text}`);
        const frequency = new Map<string, number>();
        for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
        const matching = [...wanted].filter(term => frequency.has(term));
        const title = new Set(terms(`${note.title} ${note.aliases.join(' ')} ${chunk.heading}`));
        const score = matching.reduce((value, term) => value + 1 + Math.log1p(frequency.get(term)!) + (title.has(term) ? 2 : 0), 0) / Math.sqrt(Math.max(1, words.length));
        return { note, chunk, score, matching };
    })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path) || a.chunk.index - b.chunk.index);
}
