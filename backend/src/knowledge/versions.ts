import { z } from 'zod';

export const contentVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const versionReference = z.object({
    path: z.string().min(1).max(1024), sourceKey: contentVersion, documentVersion: contentVersion,
}).strict();
export const versionRequest = z.object({ documents: z.array(versionReference).min(1).max(200) }).strict();
export const versionResult = z.object({
    checkedAt: z.string().datetime(),
    documents: z.array(versionReference.extend({
        status: z.enum(['current', 'changed', 'missing', 'unavailable', 'out_of_scope']), currentVersion: contentVersion.optional(),
    })).max(200),
}).refine(result => result.documents.every(document => document.status === 'current' ? document.currentVersion === document.documentVersion
    : document.status === 'changed' ? !!document.currentVersion && document.currentVersion !== document.documentVersion : document.currentVersion === undefined), 'Version status and content hash disagree');
export type VersionReference = z.infer<typeof versionReference>;
