import { z } from 'zod';
import type { Artifact, AgentRun } from '@/platform/agents/contracts';
import { PersistentAgentRunStore } from '@/platform/agents/persistentRunStore';
import type { PersistentKeyValueStore } from '@/platform/persistence/keyValueStore';
import { citationReference, verifyCitations } from '../answer/evidence';
import { contentVersion } from '../versions';

type Scope = { workspaceId: string; botInstanceId: string };
export interface ImpactReference {
    path: string; documentVersion: string; sourceKey?: string; sourceKind?: 'markdown' | 'web'; citationIds: string[];
}
export interface ImpactTarget { run: AgentRun; artifactIds: string[]; references: ImpactReference[]; problem?: string }
export interface ImpactReport {
    runId: string; checkRunId: string; artifactIds: string[]; checkedAt: string;
    state: 'current' | 'needs_review' | 'unverifiable' | 'not_applicable'; reason?: string;
    references: Array<ImpactReference & { status: 'current' | 'changed' | 'missing' | 'unavailable' | 'out_of_scope' | 'legacy_unverifiable'; currentVersion?: string }>;
    semanticImpact: 'not_assessed';
}
const evidence = z.object({ citationId: contentVersion, excerpt: z.string().max(8192), path: z.string().min(1).max(1024), documentVersion: contentVersion,
    sourceKey: contentVersion.optional(), sourceKind: z.enum(['markdown', 'web']).optional(), kind: z.string().optional() });
const claims = z.array(z.object({ citations: z.array(citationReference).min(1).max(4) })).max(200);

function references(capability: string, artifacts: Artifact[]): ImpactReference[] {
    const json = artifacts.filter(artifact => artifact.type === 'json' && artifact.metadata.privateKnowledge === true);
    if (json.length !== 1) throw new Error('Expected one supported private knowledge JSON artifact');
    const content = z.object({ evidence: z.array(evidence).max(250), status: z.string(), claims: z.unknown().optional(), draft: z.unknown().optional() }).parse(json[0]!.content);
    let cited: z.infer<typeof claims>;
    if (capability === 'knowledge.answer') {
        if (!['answered', 'insufficient_evidence'].includes(content.status)) throw new Error('Unsupported answer state');
        cited = content.status === 'answered' ? claims.min(1).parse(content.claims) : [];
    }
    else if (capability === 'release.prepare') {
        if (!['draft', 'needs_review', 'evidence_only', 'insufficient_evidence'].includes(content.status)) throw new Error('Unsupported release state');
        if (content.status === 'draft' && !content.draft) throw new Error('Missing release draft');
        if (!content.draft) return [];
        const draft = z.object({ entries: claims.min(1), findings: claims }).parse(content.draft);
        cited = [...draft.entries, ...draft.findings];
    } else return [];
    verifyCitations(cited, content.evidence);
    const ids = new Set(cited.flatMap(claim => claim.citations.map(reference => reference.citationId)));
    const grouped = new Map<string, ImpactReference>();
    for (const item of content.evidence) {
        if (!ids.has(item.citationId) || (capability === 'release.prepare' && item.kind !== 'knowledge')) continue;
        const key = JSON.stringify([item.sourceKind, item.sourceKey, item.path, item.documentVersion]);
        const current = grouped.get(key) || { path: item.path, documentVersion: item.documentVersion, sourceKey: item.sourceKey, sourceKind: item.sourceKind, citationIds: [] };
        current.citationIds.push(item.citationId);
        grouped.set(key, current);
    }
    if (grouped.size > 10) throw new Error('Artifact exceeds knowledge reference budget');
    return [...grouped.values()];
}

const reservation = z.object({ revision: z.number().int().positive(), checkRunId: z.string(), phase: z.enum(['checking', 'complete']), report: z.unknown().optional() });
export class KnowledgeImpactService {
    private readonly runs: PersistentAgentRunStore;
    constructor(private readonly store: PersistentKeyValueStore) { this.runs = new PersistentAgentRunStore(store); }

    async targets(scope: Scope, runIds: readonly string[]): Promise<ImpactTarget[]> {
        const runs = await Promise.all(runIds.map(id => this.runs.get(id)));
        if (runs.some(run => !run || run.workspaceId !== scope.workspaceId || run.botInstanceId !== scope.botInstanceId)) throw new Error('Target run not found in this scope');
        const targets: ImpactTarget[] = [];
        for (const run of runs as AgentRun[]) {
            const artifacts = await this.runs.listArtifacts(run.id);
            const target: ImpactTarget = { run, artifactIds: artifacts.map(artifact => artifact.id), references: [] };
            if (run.status !== 'succeeded') target.problem = 'target_run_not_succeeded';
            else if (!['knowledge.answer', 'release.prepare'].includes(run.capability)) target.problem = 'unsupported_capability';
            else {
                try { target.references = references(run.capability, artifacts); }
                catch { target.problem = 'unsupported_or_invalid_artifact'; }
            }
            targets.push(target);
        }
        return targets;
    }

    async begin(scope: Scope, runId: string, checkRunId: string): Promise<number> {
        const key = this.key(scope, runId);
        for (let attempt = 0; attempt < 5; attempt++) {
            const prior = await this.store.getIdempotencyValue(key);
            const revision = prior === null ? 1 : reservation.parse(prior).revision + 1;
            const next = { revision, checkRunId, phase: 'checking' };
            if (prior === null ? await this.store.claimIdempotencyKey(key, next) : await this.store.compareAndSetIdempotencyKey(key, prior, next)) return revision;
        }
        throw new Error('Knowledge assessment reservation conflicted');
    }

    async finish(scope: Scope, report: ImpactReport, revision: number): Promise<boolean> {
        const key = this.key(scope, report.runId), current = await this.store.getIdempotencyValue(key);
        if (!current) throw new Error('Knowledge assessment reservation disappeared');
        const parsed = reservation.parse(current);
        if (parsed.revision !== revision || parsed.checkRunId !== report.checkRunId) return false;
        return this.store.compareAndSetIdempotencyKey(key, current, { revision, checkRunId: report.checkRunId, phase: 'complete', report });
    }

    async latest(scope: Scope, runId: string) {
        const value = await this.store.getIdempotencyValue(this.key(scope, runId));
        if (!value) return { runId, state: 'unverifiable', reason: 'not_checked' };
        const current = reservation.parse(value);
        return current.phase === 'checking' ? { runId, state: 'unverifiable', reason: 'check_incomplete', checkRunId: current.checkRunId } : current.report;
    }

    private key(scope: Scope, runId: string) {
        return `knowledge:impact:${[scope.workspaceId, scope.botInstanceId, runId].map(encodeURIComponent).join(':')}`;
    }
}
