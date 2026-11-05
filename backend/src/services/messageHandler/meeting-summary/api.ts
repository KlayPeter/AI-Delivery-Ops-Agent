import { Elysia } from 'elysia';
import { z } from 'zod';
import path from 'node:path';
import { readWorkspaceArtifact } from '@/platform/workspace/artifactFiles';
import type { HandlerContext } from '../types';

const querySchema = z.object({
    groupId: z.string().max(256).optional(), skip: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
const relativeMarkdown = (filename: string) => filename.length <= 1024 && !/[\\\p{Cc}]/u.test(filename)
    && !path.isAbsolute(filename) && filename.split('/').every(part => part && part !== '.' && part !== '..') && path.extname(filename).toLowerCase() === '.md';
type EmailResult = { status: number; body: { success?: true; alreadySent?: true; accepted?: true; error?: string } };
const emailReady = (ctx: HandlerContext) => Boolean(ctx.config.email.enabled && ctx.email && !ctx.email.dryRun
    && ctx.config.email.host && ctx.config.email.user && ctx.config.email.to_addresses.length);

async function sendSummary(getContext: () => HandlerContext, id: string): Promise<EmailResult> {
    const ctx = getContext();
    if (!emailReady(ctx)) return { status: 400, body: { error: '请先配置发件邮箱和收件人；模拟模式不会发送邮件。' } };
    const record = await ctx.store.prisma.meetingSummaryRecord.findUnique({ where: { id } });
    if (!record) return { status: 404, body: { error: '未找到会议纪要' } };
    if (record.email_sent) return { status: 200, body: { success: true, alreadySent: true } };
    const root = path.join(ctx.config.data_path, 'summaries'), attachments = [];
    for (const filename of [record.summary_file, record.timeline_file].filter(Boolean)) {
        const content = relativeMarkdown(filename) ? await readWorkspaceArtifact(root, path.join(root, filename), '.md') : null;
        if (content === null) return { status: 404, body: { error: '纪要附件缺失或路径无效，未发送邮件。' } };
        attachments.push({ filename: path.basename(filename), content });
    }
    if (!attachments.length) return { status: 400, body: { error: '纪要没有可发送的附件' } };
    const subject = `会议纪要 - ${String(record.theme || record.date).replace(/[\r\n]/g, ' ').slice(0, 200)}`;
    const result = await ctx.email!.sendEmail(subject, '<p>会议纪要已归档，详见 Markdown 附件。</p>', attachments);
    try { await ctx.store.appendAuditLog(result.ok ? 'meeting_summary_email_accepted' : 'meeting_summary_email_unconfirmed', { record_id: id, group_id: record.group_id, recipient_count: ctx.config.email.to_addresses.length }); }
    catch { console.warn('Could not write meeting email audit'); }
    if (!result.ok) return { status: 502, body: { error: '邮件服务未确认接收，请检查邮箱后再决定是否重试。' } };
    try { await ctx.store.prisma.meetingSummaryRecord.update({ where: { id }, data: { email_sent: true } }); }
    catch { return { status: 502, body: { accepted: true, error: '邮件服务已接受，但发送标记保存失败。请先查收，当前进程不会重复发送。' } }; }
    return { status: 200, body: { success: true } };
}

export function createMeetingSummaryApi(getContext: () => HandlerContext) {
    const sending = new Map<string, Promise<EmailResult>>();
    return new Elysia({ prefix: '/api/meeting-summaries', name: 'meeting-summary-archive' })
        .onError(({ error, code, set }) => {
            set.status = code === 'NOT_FOUND' ? 404 : error instanceof z.ZodError || code === 'PARSE' ? 400 : 500;
            return { error: set.status === 404 ? '未找到会议纪要' : set.status === 400 ? '纪要请求参数无效' : '会议纪要操作失败' };
        })
        .get('', async ({ query }) => {
            const input = querySchema.parse(query), ctx = getContext(), where = input.groupId ? { group_id: input.groupId } : {};
            const [records, total] = await Promise.all([
                ctx.store.prisma.meetingSummaryRecord.findMany({ where, skip: input.skip, take: input.limit, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] }),
                ctx.store.prisma.meetingSummaryRecord.count({ where }),
            ]);
            return { total, email: { ready: emailReady(ctx), recipients: ctx.config.email.to_addresses }, summaries: records.map(record => ({
                id: record.id, date: record.date, source_message_id: record.source_message_id, created_at: record.created_at, group_id: record.group_id, group_name: ctx.config.groups.find(group => group.chat_id === record.group_id)?.name || '其他群聊',
                theme: record.theme, summary_file: record.summary_file, timeline_file: record.timeline_file, email_sent: record.email_sent,
            })) };
        })
        .get('/file/*', async ({ params, set }) => {
            const filename = params['*'], root = path.join(getContext().config.data_path, 'summaries');
            const markdown = relativeMarkdown(filename) ? await readWorkspaceArtifact(root, path.join(root, filename), '.md') : null;
            if (markdown === null) { set.status = 404; return { error: '未找到纪要文件' }; }
            set.headers['Content-Type'] = 'text/markdown; charset=utf-8';
            return markdown;
        })
        .post('/:id/send-email', async ({ params: { id }, body, set }) => {
            z.object({}).strict().optional().parse(body);
            z.string().min(1).max(256).parse(id);
            if (!sending.has(id)) sending.set(id, sendSummary(getContext, id).then(result => {
                // shortcut: an SMTP acceptance without a saved flag is retained until restart; reconcile mail before retrying after a restart.
                if (!result.body.accepted) sending.delete(id);
                return result;
            }, error => { sending.delete(id); throw error; }));
            const result = await sending.get(id)!; set.status = result.status;
            return result.body;
        });
}
