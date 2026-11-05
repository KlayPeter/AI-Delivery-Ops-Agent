import type { FeishuAdapter } from '@/adapters/feishu';
import type { DeliveryAdapter, DeliveryRecord } from './contracts';

export class FeishuDeliveryAdapter implements DeliveryAdapter {
    constructor(private readonly source: FeishuAdapter | (() => FeishuAdapter)) {}

    async deliver(record: DeliveryRecord, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
        if (signal.aborted) throw Object.assign(new Error('Delivery cancelled'), { code: 'DELIVERY_CANCELLED', retryable: true });
        if (record.artifact.type === 'image') return this.deliverImage(record, signal);
        const content = record.artifact.type === 'article_list' ? this.renderArticleList(record.artifact.content) : record.artifact.content;
        if (typeof content !== 'string') throw Object.assign(new Error('Feishu text delivery requires string content'), { code: 'UNSUPPORTED_ARTIFACT', retryable: false });
        if (!['markdown', 'text', 'article_list'].includes(record.artifact.type)) throw Object.assign(new Error(`Unsupported Feishu artifact type: ${record.artifact.type}`), { code: 'UNSUPPORTED_ARTIFACT', retryable: false });

        const feishu = this.feishu();
        const title = typeof record.artifact.metadata.title === 'string' ? record.artifact.metadata.title : undefined;
        const result = record.target.channel === 'group'
            ? await feishu.sendGroupMarkdown(content, record.target.targetId, title, signal)
            : await feishu.sendPrivateMarkdown(record.target.targetId, content, title, signal);
        if (!result.ok) throw Object.assign(new Error(result.error || 'Feishu delivery failed'), {
            code: result.error_code || 'FEISHU_DELIVERY_FAILED',
            retryable: result.retryable !== false,
            retryAfterMs: result.retry_after_ms,
        });
        return { messageId: result.message_id, chatId: result.chat_id };
    }

    private async deliverImage(record: DeliveryRecord, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
        if (record.target.channel !== 'group') throw Object.assign(new Error('Private image delivery is not supported'), { code: 'UNSUPPORTED_TARGET', retryable: false });
        if (!record.artifact.storageRef) throw Object.assign(new Error('Image Artifact storageRef is required'), { code: 'ARTIFACT_STORAGE_REF_MISSING', retryable: false });
        const feishu = this.feishu();
        const uploaded = await feishu.uploadImage(record.artifact.storageRef, signal);
        if (!uploaded.ok || !uploaded.image_key) throw Object.assign(new Error(uploaded.error || 'Feishu image upload failed'), {
            code: uploaded.error_code || 'FEISHU_IMAGE_UPLOAD_FAILED',
            retryable: uploaded.retryable !== false,
            retryAfterMs: uploaded.retry_after_ms,
        });
        const sent = await feishu.sendGroupImageKey(uploaded.image_key, record.target.targetId, signal);
        if (!sent.ok) throw Object.assign(new Error(sent.error || 'Feishu image delivery failed'), {
            code: sent.error_code || 'FEISHU_DELIVERY_FAILED',
            retryable: sent.retryable !== false,
            retryAfterMs: sent.retry_after_ms,
        });
        return { messageId: sent.message_id, chatId: sent.chat_id, imageKey: uploaded.image_key };
    }

    private feishu(): FeishuAdapter {
        return typeof this.source === 'function' ? this.source() : this.source;
    }

    private renderArticleList(content: unknown): string {
        const payload = content && typeof content === 'object' && !Array.isArray(content)
            ? content as Record<string, any>
            : {};
        const articles = Array.isArray(content) ? content : (Array.isArray(payload.articles) ? payload.articles : null);
        if (!articles) throw Object.assign(new Error('article_list content must contain an articles array'), { code: 'INVALID_ARTICLE_LIST', retryable: false });
        const lines = articles.map((article: any, index: number) => {
            const title = String(article?.title || '').replace(/[\[\]]/g, '').trim();
            const rawUrl = String(article?.url || '').trim();
            let url: URL;
            try { url = new URL(rawUrl); } catch { throw Object.assign(new Error(`Invalid article URL at index ${index}`), { code: 'INVALID_ARTICLE_LIST', retryable: false }); }
            if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error(`Unsafe article URL at index ${index}`), { code: 'INVALID_ARTICLE_LIST', retryable: false });
            if (!title) throw Object.assign(new Error(`Article title is required at index ${index}`), { code: 'INVALID_ARTICLE_LIST', retryable: false });
            const source = String(article?.source || '').trim();
            const summary = String(article?.summary || '').trim();
            const publishedAt = this.displayTime(article?.publishedAt);
            const sourceCountValue = Number.isInteger(article?.sourceCount) && article.sourceCount >= 0
                ? article.sourceCount
                : undefined;
            const sourceCount = sourceCountValue !== undefined
                ? `${sourceCountValue} 个来源`
                : '';
            const signalCount = Number.isInteger(article?.signalCount) && article.signalCount >= 0
                ? `${article.signalCount} 条关联信号`
                : '';
            const detail = [source, publishedAt, sourceCount, signalCount].filter(Boolean).join(' · ');
            const sourceNames = Array.isArray(article?.sourceNames)
                ? article.sourceNames.map((name: unknown) => String(name || '').trim()).filter(Boolean)
                : [];
            const sourceHint = sourceNames.length
                ? `\n   信号来源：${sourceNames.slice(0, 5).join('、')}${sourceNames.length > 5 ? `等 ${sourceCountValue || sourceNames.length} 个` : ''}`
                : '';
            return `${index + 1}. [${title}](${url.toString()})${detail ? `\n   ${detail}` : ''}${summary ? `\n   ${summary}` : ''}${sourceHint}`;
        });
        const continuation = payload.hasMore === true
            ? '💡 还有更多，回复「查看更多」继续下一批。'
            : (payload.requestedMore === true && payload.continued !== true
                ? '💡 未找到可续看的上一页，已重新返回最新内容。'
                : '💡 已显示当前可用结果。');
        const guidance = [
            '---',
            continuation,
            '还可以发送：',
            '- 「搜索 Claude」：按任意关键词检索',
            '- 「AI信号」：查看多源热点、信号数和代表来源',
            '- 「来源 IT之家」：按最近 7 天信源筛选',
            '- 「AI论文」/「AI模型」：按分类查看',
            '- 「今天全部 AI 动态」：查看精选之外的更多内容',
        ].join('\n');
        return `${lines.length ? lines.join('\n\n') : '暂无可用的 AI 新闻。'}\n\n${guidance}`;
    }

    private displayTime(value: unknown): string {
        if (typeof value !== 'string') return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(date);
    }
}
