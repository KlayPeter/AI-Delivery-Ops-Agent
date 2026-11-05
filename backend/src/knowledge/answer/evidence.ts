import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const retrievalEvidence = z.object({
    retrieval: z.literal('keyword'),
    source: z.object({ sourceId: z.string().min(1), version: hash, partial: z.boolean(), indexed: z.number().int().min(0), syncedAt: z.string(),
        sources: z.array(z.object({ kind: z.enum(['markdown', 'web']), status: z.enum(['available', 'unavailable']), indexed: z.number().int().nonnegative(), partial: z.boolean(), version: hash.optional() })).max(2).optional(),
    }),
    hits: z.array(z.object({
        citationId: hash, sourceId: z.string().min(1), path: z.string().min(1).max(1024), title: z.string().max(256),
        documentVersion: hash, heading: z.string().max(256), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(),
        excerpt: z.string().min(1).max(2000), openUri: z.string().optional(),
        sourceKind: z.enum(['web', 'markdown']).optional(), lineBasis: z.literal('extracted_text').optional(), fetchedAt: z.string().optional(),
        sourceKey: hash.optional(),
    }).refine(hit => hit.lineEnd >= hit.lineStart, 'Invalid source line range')).max(10),
});
export type RetrievalEvidence = z.infer<typeof retrievalEvidence>;
export type EvidenceHit = RetrievalEvidence['hits'][number];

export const citationReference = z.object({ citationId: hash, quote: z.string().trim().min(1).max(2000) }).strict();
const draftSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('answered'), claims: z.array(z.object({
        text: z.string().trim().min(1).max(2000), citations: z.array(citationReference).min(1).max(4),
    }).strict()).min(1).max(8) }).strict(),
    z.object({ status: z.literal('insufficient_evidence'), reason: z.string().trim().min(1).max(1000) }).strict(),
]);

export function selectEvidence(hits: readonly EvidenceHit[]): EvidenceHit[] {
    let chars = 0;
    const selected: EvidenceHit[] = [];
    if (new Set(hits.map(hit => hit.citationId)).size !== hits.length) throw new Error('Duplicate evidence citation ID');
    for (const hit of hits) {
        const size = hit.excerpt.length + hit.title.length + hit.heading.length;
        if (chars + size > 12_000) break;
        chars += size;
        selected.push(hit);
    }
    return selected;
}

export function verifyDraft(text: string, evidence: readonly EvidenceHit[]) {
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Model answer exceeds 64 KiB');
    const raw = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
    const draft = draftSchema.parse(JSON.parse(raw));
    if (draft.status === 'insufficient_evidence') return draft;
    verifyCitations(draft.claims, evidence);
    return draft;
}

export function verifyCitations(claims: readonly { citations: readonly z.infer<typeof citationReference>[] }[], evidence: readonly { citationId: string; excerpt: string }[]): void {
    const sources = new Map(evidence.map(hit => [hit.citationId, hit]));
    if (sources.size !== evidence.length) throw new Error('Duplicate evidence citation ID');
    for (const claim of claims) {
        for (const reference of claim.citations) {
            const source = sources.get(reference.citationId);
            if (!source) throw new Error('Answer cites evidence that was not supplied to the model');
            if (!source.excerpt.includes(reference.quote)) throw new Error('Answer quote is not present in the cited excerpt');
        }
    }
}
