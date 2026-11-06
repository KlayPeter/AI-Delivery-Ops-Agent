import { z } from 'zod';
import type { ToolDefinition } from '@/platform/tools/contracts';

export const contentVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const versionReference = z.object({
    path: z.string().min(1).max(1024), sourceKey: contentVersion, documentVersion: contentVersion,
}).strict();
export const quoteBudget = { perDocument: 32, count: 200, bytes: 64 * 1024 };
const quote = z.string().trim().min(1).max(2000);
export const quoteCheck = z.object({ quote, status: z.enum(['found', 'not_found']) }).strict();
export const versionRequest = z.object({ documents: z.array(versionReference.extend({ quotes: z.array(quote).min(1).max(quoteBudget.perDocument).refine(items => new Set(items).size === items.length).optional() })).min(1).max(200) }).strict()
    .refine(input => { const quotes = input.documents.flatMap(document => document.quotes || []); return quotes.length <= quoteBudget.count && quotes.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= quoteBudget.bytes; }, 'Quote probes exceed the request budget');
export const versionInputSchema = z.toJSONSchema(versionRequest) as unknown as ToolDefinition['inputSchema'];
export const acceptsQuoteChecks = (schema: any): boolean => Boolean(schema?.properties?.documents?.items?.properties?.quotes);
export function checkQuotes(quotes: string[] | undefined, text: string) {
    return quotes ? { quoteChecks: quotes.map(quote => ({ quote, status: text.includes(quote) ? 'found' as const : 'not_found' as const })) } : {};
}
export const versionResult = z.object({
    checkedAt: z.string().datetime(),
    documents: z.array(versionReference.extend({
        status: z.enum(['current', 'changed', 'missing', 'unavailable', 'out_of_scope']), currentVersion: contentVersion.optional(),
        quoteChecks: z.array(quoteCheck).min(1).max(quoteBudget.perDocument).optional(),
    })).max(200),
}).refine(result => result.documents.every(document => document.status === 'current' ? document.currentVersion === document.documentVersion
    : document.status === 'changed' ? !!document.currentVersion && document.currentVersion !== document.documentVersion : document.currentVersion === undefined && document.quoteChecks === undefined), 'Version status and content hash disagree');
export type VersionReference = z.infer<typeof versionReference>;
export type VersionResult = z.infer<typeof versionResult>;
