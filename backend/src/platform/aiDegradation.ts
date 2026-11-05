export type AiFailureCategory = "rate_limited" | "timeout" | "invalid_response" | "unavailable";

export interface AiFailure {
    category: AiFailureCategory;
    error: string;
}

export function classifyAiFailure(error: unknown): AiFailure {
    const message = String(error instanceof Error ? error.message : error || "AI service unavailable").slice(0, 500);
    const category: AiFailureCategory = /too many requests|rate limit|quota|\b429\b/i.test(message)
        ? "rate_limited"
        : /timed out|timeout|abort/i.test(message)
            ? "timeout"
            : /empty_response|invalid_json|invalid response|items_not_list|unexpected token|json parse|syntaxerror/i.test(message)
                ? "invalid_response"
                : "unavailable";
    return { category, error: message };
}

export function aiFailureLabel(category: AiFailureCategory): string {
    if (category === "rate_limited") return "AI 服务当前限流";
    if (category === "timeout") return "AI 服务响应超时";
    if (category === "invalid_response") return "AI 服务返回内容无效";
    return "AI 服务暂时不可用";
}

export function aiDegradationNotice(category: AiFailureCategory, fallback: string): string {
    return `> ℹ️ ${aiFailureLabel(category)}，本次已使用${fallback}继续生成；内容未经过 AI 归纳。`;
}
