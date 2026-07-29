const AI_TOPIC = /(?:\bAI\b|AI\s*圈|人工智能|大模型|基础模型|OpenAI|Anthropic|Claude|Gemini|DeepSeek|通义|千问|豆包|Kimi|智谱)/i;
const NEWS_TOPIC = /(?:新闻|热点|资讯|快讯|头条|日报|动态|新鲜事|发生了什么)/i;
const NEGATED_REQUEST = /(?:不要|不用|别|无需|取消|停止).{0,12}(?:新闻|热点|资讯|快讯|日报|动态|信号)/i;
const META_QUESTION = /(?:怎么用|如何配置|是否支持|能不能用|功能介绍|权限|配置方法)/i;
const QUERY_CUE = /(?:今天|昨日|昨天|最近|本周|这周|过去|给我|帮我|查|看|来一份|有什么)/i;
const NON_NEWS_WORK = /(?:创建|开发|实现|接入|修复|需求|任务|助手|系统)/i;
const AI_NEWS_DIRECT_QUERY = /(?:AI\s*信号|多源热点|多源信号|搜索\s*[：:]?\s*(?:OpenAI|Anthropic|Claude|Gemini|DeepSeek|Kimi|Qwen|GPT|Sora|RAG)|AI\s*(?:论文|模型|产品|行业))/i;
const AI_NEWS_FOLLOW_UP = /^(?:(?:请)?(?:继续|查看更多|看更多|更多|再来(?:一点|一些|点)?|再给(?:一点|一些|点)?|下一页|下页)(?:新闻|资讯|动态|内容)?|(?:搜索|检索|查找|搜一下|查一下)\s*[：:]?\s*.+|(?:来源|信源)\s*[：:]?\s*.+|AI\s*(?:信号|论文|模型|产品|行业))[。！!？?]?$/i;

export function isAiNewsIntent(text: string): boolean {
    const prompt = String(text || '').trim();
    if (!prompt) return false;
    if (NEGATED_REQUEST.test(prompt)) return false;
    if (META_QUESTION.test(prompt) && !QUERY_CUE.test(prompt)) return false;
    if (NON_NEWS_WORK.test(prompt) && !QUERY_CUE.test(prompt)) return false;
    if (AI_NEWS_DIRECT_QUERY.test(prompt)) return true;
    return AI_TOPIC.test(prompt) && NEWS_TOPIC.test(prompt);
}

export function isAiNewsFollowUp(text: string): boolean {
    return AI_NEWS_FOLLOW_UP.test(String(text || '').trim());
}

export function createAiNewsIntentRouter(
    ttlMs: number = 30 * 60_000,
    maxConversations: number = 500,
): (message: { chat_id?: string; sender_open_id?: string; text?: string }) => boolean {
    const active = new Map<string, number>();
    return message => {
        const now = Date.now();
        for (const [key, expiresAt] of active) {
            if (expiresAt <= now) active.delete(key);
        }
        const key = String(message.chat_id || message.sender_open_id || '').trim();
        const direct = isAiNewsIntent(message.text || '');
        const followUp = !!key && active.has(key) && isAiNewsFollowUp(message.text || '');
        if (!direct && !followUp) return false;
        if (key) {
            active.delete(key);
            active.set(key, now + Math.max(1, ttlMs));
            while (active.size > Math.max(1, maxConversations)) {
                const oldest = active.keys().next().value;
                if (!oldest) break;
                active.delete(oldest);
            }
        }
        return true;
    };
}
