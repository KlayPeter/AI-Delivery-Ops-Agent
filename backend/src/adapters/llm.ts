import { GoogleGenAI, type HttpOptions } from '@google/genai';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { AIConfig } from '@/core/config';

export interface LLMResult {
    ok: boolean;
    content: string;
    raw?: any;
    error?: string;
}

export interface LLMCallOptions {
    requestTimeoutMs?: number;
    retryCount?: number;
}

export interface LLMDiagnostics {
    hasApiKey: boolean;
    apiBase: string;
    requestUrl: string;
    model: string;
    timeoutMs: number;
    retryAttempts: number;
}

export interface LLMHealthResult extends LLMResult {
    ms: number;
    diagnostics: LLMDiagnostics;
}

export class LLMAdapter {
    private config: AIConfig;
    private dryRun: boolean;

    constructor(config: AIConfig, dryRun: boolean = false) {
        this.config = config;
        this.dryRun = dryRun;
    }

    diagnostics(): LLMDiagnostics {
        const requestUrl = this.isGeminiProvider()
            ? this.geminiGenerateContentUrl()
            : this.openAiResponsesUrl();
        return {
            hasApiKey: !!this.config.api_key,
            apiBase: this.sanitizeUrl(this.isGeminiProvider() ? this.geminiApiBase() : this.apiBase()),
            requestUrl: this.sanitizeUrl(requestUrl),
            model: this.config.model,
            timeoutMs: this.requestTimeoutMs(),
            retryAttempts: this.attempts(),
        };
    }

    async healthCheck(): Promise<LLMHealthResult> {
        const startedAt = Date.now();
        if (!this.config.api_key) {
            return {
                ok: false,
                content: "",
                error: "AI_API_KEY is not configured",
                ms: Date.now() - startedAt,
                diagnostics: this.diagnostics(),
            };
        }
        const result = await this.chat("Reply with exactly OK.", "ping");
        return {
            ...result,
            ms: Date.now() - startedAt,
            diagnostics: this.diagnostics(),
        };
    }

    async chat(systemPrompt: string, userMessage: string, options: LLMCallOptions = {}): Promise<LLMResult> {
        if (this.dryRun || !this.config.api_key) {
            return { ok: true, content: "", raw: { dry_run: true } };
        }

        if (this.isGeminiProvider()) {
            return this.chatWithGeminiSdk(systemPrompt, userMessage, options);
        }

        return this.chatWithOpenAiCompatible(systemPrompt, userMessage, options);
    }

    async summarize(items: any[], task: string): Promise<LLMResult> {
        const system = "你是研发交付中台的摘要助手。只输出可直接发送到飞书群的中文纯文本。";
        const user = JSON.stringify({ task, items }, null, 2);
        return this.chat(system, user);
    }

    private async chatWithGeminiSdk(systemPrompt: string, userMessage: string, options: LLMCallOptions): Promise<LLMResult> {
        const attemptErrors: string[] = [];
        const attempts = this.attempts(options.retryCount);
        const timeoutMs = this.requestTimeoutMs(options.requestTimeoutMs);

        for (let attempt = 0; attempt < attempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const client = this.geminiClient(timeoutMs, attempts);
                const response = await client.models.generateContent({
                    model: this.config.model,
                    contents: userMessage,
                    config: {
                        systemInstruction: systemPrompt,
                        temperature: this.config.temperature,
                        maxOutputTokens: this.config.max_tokens,
                        abortSignal: controller.signal,
                    },
                });

                return {
                    ok: true,
                    content: response.text || "",
                    raw: response,
                };
            } catch (error: any) {
                const lastError = this.formatError(error, timeoutMs);
                attemptErrors.push(lastError);
                if (attempt === attempts - 1) {
                    throw new Error(`LLM API Error (Gemini): ${lastError}`);
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(Math.pow(2, attempt) * 1000, 5000)));
            } finally {
                clearTimeout(timer);
            }
        }

        return {
            ok: false,
            content: "",
            error: attemptErrors.at(-1) || "llm_error",
            raw: { diagnostics: this.diagnostics(), attempts: attemptErrors },
        };
    }

    private async chatWithOpenAiCompatible(systemPrompt: string, userMessage: string, options: LLMCallOptions): Promise<LLMResult> {
        const attemptErrors: string[] = [];
        const timeoutMs = this.requestTimeoutMs(options.requestTimeoutMs);

        try {
            const proxiedFetch = this.getProxiedFetch();
            const provider = createOpenAI({
                apiKey: this.config.api_key,
                baseURL: this.apiBase(),
                name: this.config.provider || "openai",
                ...(proxiedFetch ? { fetch: proxiedFetch } : {}),
            });
            const result = await generateText({
                model: provider(this.config.model),
                system: systemPrompt,
                prompt: userMessage,
                temperature: this.config.temperature,
                maxOutputTokens: this.config.max_tokens,
                maxRetries: Math.max(0, options.retryCount ?? this.config.retry_count ?? 0),
                timeout: timeoutMs,
            });

            return {
                ok: true,
                content: result.text || "",
                raw: {
                    finishReason: result.finishReason,
                    usage: result.usage,
                    warnings: result.warnings,
                },
            };
        } catch (error: any) {
            const lastError = this.formatError(error, timeoutMs);
            attemptErrors.push(lastError);
            throw new Error(`LLM API Error (OpenAI/Compatible): ${lastError}`);
        }
    }

    private attempts(retryCount?: number): number {
        return Math.max(1, (retryCount ?? this.config.retry_count ?? 0) + 1);
    }

    private requestTimeoutMs(override?: number): number {
        return Math.max(1000, Number(override ?? this.config.request_timeout_ms ?? 15000));
    }

    private apiBase(): string {
        let apiBase = (this.config.api_base || "https://api.openai.com/v1").replace(/\/+$/, '');
        if (!apiBase.endsWith('/v1') && apiBase.includes('openai')) {
            apiBase += '/v1';
        }
        return apiBase;
    }

    private openAiResponsesUrl(): string {
        return `${this.apiBase()}/responses`;
    }

    private isGeminiProvider(): boolean {
        const provider = (this.config.provider || "").toLowerCase();
        const model = (this.config.model || "").toLowerCase();
        const apiBase = (this.config.api_base || "").toLowerCase();
        return provider.includes("gemini") || model.includes("gemini") || apiBase.includes("generativelanguage.googleapis.com");
    }

    private geminiClient(timeoutMs: number = this.requestTimeoutMs(), attempts: number = this.attempts()): GoogleGenAI {
        const apiBase = this.geminiApiBase();
        const proxiedFetch = this.getProxiedFetch();

        // Temporarily set global proxy for the Google SDK if needed (Bun automatically respects this in native fetch)
        if (this.config.use_proxy && this.config.proxy_url) {
            process.env.HTTPS_PROXY = this.config.proxy_url;
            process.env.HTTP_PROXY = this.config.proxy_url;
        }

        const httpOptions: any = {
            timeout: timeoutMs,
            retryOptions: { attempts },
            ...(apiBase ? { baseUrl: apiBase } : {}),
            ...(proxiedFetch ? { fetch: proxiedFetch } : {}),
        };

        return new GoogleGenAI({
            apiKey: this.config.api_key,
            httpOptions,
        });
    }

    private geminiApiBase(): string {
        const rawBase = (this.config.api_base || "").replace(/\/+$/, '');
        if (!rawBase || rawBase.includes("api.openai.com")) {
            return "";
        }
        if (rawBase.includes("generativelanguage.googleapis.com")) {
            return "";
        }
        return rawBase;
    }

    private geminiGenerateContentUrl(): string {
        const base = this.geminiApiBase() || "https://generativelanguage.googleapis.com/v1beta";
        return `${base.replace(/\/+$/, '')}/models/${encodeURIComponent(this.config.model)}:generateContent`;
    }

    private sanitizeUrl(rawUrl: string): string {
        if (!rawUrl) return "(default)";
        try {
            const url = new URL(rawUrl);
            return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
        } catch {
            return "(invalid-url)";
        }
    }

    private getProxiedFetch(): typeof globalThis.fetch | undefined {
        if (this.config.use_proxy && this.config.proxy_url) {
            return ((input: any, init?: any) => {
                return fetch(input, {
                    ...init,
                    proxy: this.config.proxy_url,
                } as any);
            }) as unknown as typeof globalThis.fetch;
        }
        return undefined;
    }

    private formatError(error: any, timeoutMs: number): string {
        if (error?.name === "AbortError") {
            return `AI request timed out after ${timeoutMs}ms`;
        }
        return error?.message || String(error);
    }
}
