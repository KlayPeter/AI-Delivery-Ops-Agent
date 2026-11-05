import { z } from 'zod';
import { statusPanelSchema, type StatusPanel } from '@/platform/plugins/runActions';

const assessmentSchema = z.object({
    runId: z.string().min(1).max(256), checkRunId: z.string().min(1).max(256).optional(), checkedAt: z.string().datetime({ offset: true }).optional(),
    state: z.enum(['current', 'needs_review', 'unverifiable', 'not_applicable']), reason: z.string().optional(),
    references: z.array(z.object({ path: z.string().max(1024), documentVersion: z.string().length(64), currentVersion: z.string().length(64).optional(),
        status: z.enum(['current', 'changed', 'missing', 'unavailable', 'out_of_scope', 'legacy_unverifiable']) })).max(10).default([]),
}).refine(value => !['current', 'needs_review'].includes(value.state) || Boolean(value.checkedAt && value.checkRunId && value.references.length), 'A checked assessment requires its evidence and check time');

const referenceLabels = { current: '版本未变化', changed: '内容已变化', missing: '原路径已缺失', unavailable: '无法读取', out_of_scope: '当前来源范围不匹配', legacy_unverifiable: '历史证据缺少来源身份' };
export function knowledgeReviewPanel(value: unknown): StatusPanel {
    const report = assessmentSchema.parse(value);
    let tone: StatusPanel['tone'] = 'neutral', title = '知识引用尚未检查', description = '检查此结果实际引用的资料版本；检查不调用模型。';
    if (report.state === 'current') {
        tone = 'success'; title = '知识引用版本未变化'; description = '所引用文档的版本与原证据一致，仅表示内容未变化，不代表结论语义已经验证。';
    } else if (report.state === 'needs_review') {
        tone = 'warning'; title = '知识引用需要复核'; description = '至少一份引用资料已更新或原路径已缺失，请对照原回答和资料重新确认。';
    } else if (report.state === 'not_applicable') {
        title = '结果没有实际引用知识'; description = '此结果没有需要检查的知识文档引用。';
    } else if (report.reason !== 'not_checked') {
        tone = 'warning'; title = report.reason === 'check_incomplete' ? '知识引用检查尚未完成' : '暂时无法核验知识引用';
        description = '来源不可读、范围不匹配或历史证据格式不足时，不能确认版本状态。可检查来源配置后重新检查。';
    }
    return statusPanelSchema.parse({ schemaVersion: '1.0', tone, title, description, checkedAt: report.checkedAt,
        items: report.references.map(reference => ({ label: reference.path, value: referenceLabels[reference.status],
            detail: `原版本 ${reference.documentVersion.slice(0, 12)}${reference.currentVersion ? ` · 当前版本 ${reference.currentVersion.slice(0, 12)}` : ''}` })),
        relatedRun: report.checkRunId ? { id: report.checkRunId, label: '查看检查记录' } : undefined,
    });
}
