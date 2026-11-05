import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { FeishuConfig } from '@/core/config';
import { SourceMessage, Mention, utcNowIso } from '@/models/types';
import {
    externalApiCircuit,
    normalizeExternalApiOperation,
    observeExternalApiCall,
    openExternalApiCircuit,
} from '@/platform/observability/externalApiHealth';

const execFileAsync = promisify(execFile);

export const WORKING_REACTION_EMOJI_TYPES = ["Typing", "OnIt"];
export const WORKING_REACTION_EMOJI_TYPE = WORKING_REACTION_EMOJI_TYPES[0];
export const FEISHU_HISTORY_PAGE_SIZE = 50;
export const FEISHU_HISTORY_MAX_PAGES = 100;
export const FEISHU_HISTORY_SYNC_TIMEOUT_MS = 30_000;
export const FEISHU_LIST_MAX_PAGES = 100;
export const FEISHU_DIRECTORY_MAX_REQUESTS = 200;
const FEISHU_LIST_SYNC_TIMEOUT_MS = 30_000;
const FEISHU_DIRECTORY_SYNC_TIMEOUT_MS = 60_000;
const FEISHU_PAGE_REQUEST_TIMEOUT_MS = 10_000;

function feishuGuardError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code, retryable: false });
}

export interface SendResult {
    ok: boolean;
    raw: any;
    chat_id?: string;
    message_id?: string;
    file_token?: string;
    url?: string;
    error?: string;
    warning?: string;
    image_key?: string;
    retryable?: boolean;
    error_code?: string;
    retry_after_ms?: number;
}

export interface FeishuFailureClassification {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    quotaExhausted: boolean;
    raw: any;
}

function retryAfterMs(value: unknown, now: number = Date.now()): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === null || raw === undefined || raw === '') return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const date = Date.parse(String(raw));
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function nextShanghaiMonthStart(now: Date = new Date()): Date {
    const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return new Date(Date.UTC(shanghaiTime.getUTCFullYear(), shanghaiTime.getUTCMonth() + 1, 1) - 8 * 60 * 60 * 1000);
}

export function classifyFeishuFailure(error: any): FeishuFailureClassification {
    const raw = error?.response?.data || error?.raw || {};
    const status = Number(error?.response?.status || error?.status || 0);
    const businessCode = Number(raw?.code ?? raw?.error?.code);
    const quotaExhausted = businessCode === 99991403;
    const rateLimited = status === 429 || businessCode === 99991400 || businessCode === 99991403;
    const permanent = quotaExhausted || businessCode === 230001 || status === 400 || status === 401 || status === 403 || status === 404;
    const headers = error?.response?.headers || {};
    const retryDelay = retryAfterMs(headers['retry-after'] ?? headers['Retry-After']);
    return {
        code: quotaExhausted ? 'FEISHU_MONTHLY_QUOTA_EXHAUSTED' : rateLimited ? 'FEISHU_RATE_LIMITED' : permanent ? 'FEISHU_PERMANENT_ERROR' : 'FEISHU_API_ERROR',
        message: raw?.msg || raw?.message || error?.message || String(error),
        retryable: !permanent,
        retryAfterMs: rateLimited && !quotaExhausted ? retryDelay : undefined,
        quotaExhausted,
        raw,
    };
}

export function isPermanentFeishuSendFailure(result: Pick<SendResult, "ok" | "raw" | "error" | "retryable">): boolean {
    if (result.ok) return false;
    if (result.retryable === false) return true;
    const code = Number(result.raw?.code ?? result.raw?.error?.code);
    if (code === 230001 || code === 99991403) return true;
    const text = [
        result.error,
        result.raw?.msg,
        result.raw?.message,
        result.raw?.error?.message,
    ].filter(Boolean).join(" ").toLowerCase();
    return /invalid receive_id|invalid request parameter.*receive_id|receiver not in scope|user not found|invalid open_id/.test(text);
}

export interface DownloadResourceResult {
    ok: boolean;
    contentType?: string;
    fileName?: string;
    error?: string;
}

export function extractFeishuImageKeys(value: any): string[] {
    const imageKeys = new Set<string>();
    const visited = new Set<any>();

    const visit = (current: any): void => {
        if (!current) return;
        if (typeof current === "string") {
            const trimmed = current.trim();
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
            try {
                visit(JSON.parse(trimmed));
            } catch {}
            return;
        }
        if (typeof current !== "object" || visited.has(current)) return;
        visited.add(current);

        if (typeof current.image_key === "string" && current.image_key) {
            imageKeys.add(current.image_key);
        }
        for (const nested of Array.isArray(current) ? current : Object.values(current)) {
            visit(nested);
        }
    };

    visit(value);
    return [...imageKeys];
}

function normalizeFeishuTimestamp(value: unknown): string {
    const raw = String(value || "").trim();
    if (/^\d{10,16}$/.test(raw)) {
        const numeric = Number(raw);
        const milliseconds = raw.length <= 10 ? numeric * 1000 : numeric;
        const parsed = new Date(milliseconds);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    if (raw) {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return utcNowIso();
}

export class FeishuEventParser {
    private botOpenId: string;
    private knownNames: Record<string, string>;

    constructor(botOpenId: string, knownNames: Record<string, string> = {}) {
        this.botOpenId = botOpenId;
        this.knownNames = knownNames;
    }

    parse(payload: any): SourceMessage | null {
        const event = payload?.event || {};
        const message = event.message || {};
        const sender = event.sender || {};
        if (Object.keys(message).length === 0) return null;

        const messageId = message.message_id || message.message_id_v2 || message.root_id || utcNowIso();
        const senderOpenId = sender.sender_id?.open_id || "";
        const senderName = this.knownNames[senderOpenId] || senderOpenId || "unknown";

        const mentionsRaw: any[] = message.mentions || [];
        const mentions: Mention[] = mentionsRaw
            .map(m => this._parseMention(m))
            .filter(m => !!m.open_id || !!m.name || !!m.key);

        let rawText = this._extractText(message.content || "");
        for (const mention of mentions) {
            if (mention.key && mention.name) {
                // Feishu keys usually look like "@_user_1", replace them with "@name"
                const key = mention.key.startsWith("@") ? mention.key : `@${mention.key}`;
                rawText = rawText.split(key).join(`@${mention.name}`);
            }
        }

        let fileKey: string | undefined;
        let imageKey: string | undefined = extractFeishuImageKeys(message.content || "")[0];
        if (message.message_type === "file" || message.message_type === "image") {
            try {
                const parsedContent = JSON.parse(message.content || "{}");
                fileKey = parsedContent.file_key;
                imageKey = parsedContent.image_key || imageKey;
            } catch (e) {}
        }

        return {
            id: messageId,
            chat_id: message.chat_id || "",
            chat_type: message.chat_type || "private",
            sender_open_id: senderOpenId,
            sender_name: senderName,
            text: rawText,
            message_type: message.message_type || "text",
            sent_at: normalizeFeishuTimestamp(message.create_time),
            raw_payload: payload,
            mentions,
            parent_id: message.parent_id,
            root_id: message.root_id,
            file_key: fileKey,
            image_key: imageKey
        };
    }

    private _extractText(content: string): string {
        if (!content) return "";
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            return content;
        }

        if (parsed.text) return parsed.text;

        if (parsed.content && Array.isArray(parsed.content)) {
            const lines: string[] = [];
            if (parsed.title) lines.push(parsed.title);
            for (const lineElements of parsed.content) {
                if (Array.isArray(lineElements)) {
                    let lineText = "";
                    for (const el of lineElements) {
                        if (el.tag === 'text' || el.tag === 'a') {
                            lineText += el.text || "";
                        } else if (el.tag === 'at') {
                            let name = el.user_name || el.name || "";
                            if (this.knownNames[el.user_id] && (!name || name.startsWith('_user_') || name === 'User')) {
                                name = this.knownNames[el.user_id];
                            } else if (!name || name.startsWith('_user_')) {
                                name = "未知成员";
                            }
                            lineText += `@${name} `;
                        }
                    }
                    lines.push(lineText);
                }
            }
            if (lines.length > 0) return lines.join('\n');
        }

        return parsed.title || content;
    }

    private _parseMention(raw: any): Mention {
        const mentionId = raw.id || {};
        const openId = raw.open_id || mentionId.open_id || raw.user_id || "";
        const key = raw.key || "";
        let name = raw.name || key || "";
        if ((!name || name.startsWith("_user_")) && this.knownNames[openId]) {
            name = this.knownNames[openId];
        } else if (!name || name.startsWith("_user_")) {
            name = "未知成员";
        }
        return { open_id: openId, name, key };
    }
}

export class FeishuAdapter {
    private config: FeishuConfig;
    public dryRun: boolean;
    public lastReactionError: string | null = null;
    private auditCallback?: (eventType: string, payload: any) => void;
    private tokenCache: string | null = null;
    private tokenExpires: number = 0;
    private tokenRequest: Promise<string> | null = null;

    private knownNames: Record<string, string>;
    private readonly memberJobTitleCache = new Map<string, { jobTitle?: string; expiresAt: number }>();

    constructor(config: FeishuConfig, dryRun: boolean = false, knownNames: Record<string, string> = {}) {
        this.config = config;
        this.dryRun = dryRun;
        this.knownNames = knownNames;
    }

    private async _observe<T>(
        method: string,
        url: string,
        request: () => Promise<T>,
        options: { metered?: boolean; isSuccess?: (result: T) => boolean } = {},
    ): Promise<T> {
        return observeExternalApiCall({
            provider: 'feishu',
            scope: this.config.app_id || 'unconfigured',
            operation: normalizeExternalApiOperation(method, url),
            metered: options.metered,
            request,
            isSuccess: options.isSuccess,
        });
    }

    private _quotaCircuitFailure(): SendResult | null {
        const circuit = externalApiCircuit('feishu', this.config.app_id || 'unconfigured');
        if (!circuit) return null;
        return {
            ok: false,
            raw: { code: 99991403 },
            error: 'Feishu monthly API quota is exhausted',
            error_code: 'FEISHU_MONTHLY_QUOTA_EXHAUSTED',
            retryable: false,
        };
    }

    private _assertMeteredApiAvailable(): void {
        const failure = this._quotaCircuitFailure();
        if (!failure) return;
        throw Object.assign(new Error(failure.error), {
            code: failure.error_code,
            retryable: false,
        });
    }

    private _classifyFailure(error: any): FeishuFailureClassification {
        const failure = classifyFeishuFailure(error);
        if (failure.quotaExhausted) {
            openExternalApiCircuit('feishu', failure.code, nextShanghaiMonthStart(), this.config.app_id || 'unconfigured');
        }
        return failure;
    }

    private _sendFailure(error: any, chatId?: string): SendResult {
        const failure = this._classifyFailure(error);
        return {
            ok: false,
            raw: failure.raw,
            chat_id: chatId,
            error: failure.message,
            error_code: failure.code,
            retryable: failure.retryable,
            retry_after_ms: failure.retryAfterMs,
        };
    }

    private _apiError(error: any, prefix: string): Error {
        const failure = this._classifyFailure(error);
        return Object.assign(new Error(`${prefix}: ${failure.message}`), {
            code: failure.code,
            retryable: failure.retryable,
            retryAfterMs: failure.retryAfterMs,
        });
    }

    private async _getTenantAccessToken(): Promise<string> {
        if (this.tokenCache && this.tokenExpires > Date.now()) {
            return this.tokenCache;
        }

        if (this.tokenRequest) return this.tokenRequest;
        this.tokenRequest = this._fetchTenantAccessToken();
        try {
            return await this.tokenRequest;
        } finally {
            this.tokenRequest = null;
        }
    }

    private async _fetchTenantAccessToken(): Promise<string> {
        const url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
        try {
            const resp = await this._observe('POST', url, () => axios.post(url, {
                app_id: this.config.app_id,
                app_secret: this.config.app_secret
            }), { metered: false, isSuccess: result => result.data?.code === 0 });
            if (resp.data.code === 0) {
                this.tokenCache = resp.data.tenant_access_token;
                this.tokenExpires = Date.now() + (resp.data.expire * 1000) - 60000;
                return this.tokenCache!;
            }
            throw new Error(`Token Error: ${JSON.stringify(resp.data)}`);
        } catch (e) {
            throw new Error(`Network error getting token: ${e}`);
        }
    }

    setAuditCallback(callback: (eventType: string, payload: any) => void) {
        this.auditCallback = callback;
    }

    async getUserName(openId: string): Promise<string | null> {
        if (this.knownNames[openId]) return this.knownNames[openId];
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/contact/v3/users/${openId}`;
            const resp = await this._observe('GET', url, () => axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            }), { metered: false, isSuccess: result => result.data?.code === 0 });
            if (resp.data.code === 0 && resp.data.data?.user?.name) {
                return resp.data.data.user.name;
            }
        } catch (e) {
            // Ignore errors (like lack of permission or cross app)
        }
        return null;
    }

    async sendGroupText(text: string, chatId: string, signal?: AbortSignal): Promise<SendResult> {
        const result = await this._sendMessage("chat_id", chatId, text, signal);
        this._auditSend("group", chatId, result);
        return result;
    }

    async sendGroupMarkdown(text: string, chatId: string, title?: string, signal?: AbortSignal): Promise<SendResult> {
        const result = await this._sendInteractive("chat_id", chatId, text, title, signal);
        this._auditSend("group_markdown", chatId, result);
        return result;
    }

    async sendGroupCard(card: Record<string, unknown>, chatId: string, title?: string, signal?: AbortSignal): Promise<SendResult> {
        const result = await this._sendInteractiveCard("chat_id", chatId, card, title, signal);
        this._auditSend("group_card", chatId, result);
        return result;
    }

    async sendPrivateText(openId: string, text: string, signal?: AbortSignal): Promise<SendResult> {
        const result = await this._sendMessage("open_id", openId, text, signal);
        this._auditSend("private", openId, result);
        return result;
    }

    async sendPrivateMarkdown(openId: string, text: string, title?: string, signal?: AbortSignal): Promise<SendResult> {
        const result = await this._sendInteractive("open_id", openId, text, title, signal);
        this._auditSend("private_markdown", openId, result);
        return result;
    }

    async sendReplyText(messageId: string, text: string, signal?: AbortSignal): Promise<SendResult> {
        if (!messageId) {
            const res = { ok: false, raw: {}, error: "message_id is required for reply" };
            this._auditSend("reply", messageId, res);
            return res;
        }
        const result = await this._sendReply(messageId, text, signal);
        this._auditSend("reply", messageId, result);
        return result;
    }

    async sendReplyMarkdown(messageId: string, text: string, title?: string, signal?: AbortSignal): Promise<SendResult> {
        if (!messageId) {
            const res = { ok: false, raw: {}, error: "message_id is required for reply" };
            this._auditSend("reply_markdown", messageId, res);
            return res;
        }
        const result = await this._sendReplyInteractive(messageId, text, title, signal);
        this._auditSend("reply_markdown", messageId, result);
        return result;
    }

    async uploadImage(imagePath: string, signal?: AbortSignal): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, imagePath }, image_key: "dry-run-image-key" };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return circuitFailure;
        try {
            const token = await this._getTenantAccessToken();
            const imageData = fs.readFileSync(path.resolve(imagePath));
            const formData = new FormData();
            formData.append('image_type', 'message');
            formData.append('image', new Blob([imageData]), path.basename(imagePath));
            const url = 'https://open.feishu.cn/open-apis/im/v1/images';
            const response = await this._observe('POST', url, () => fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData,
                signal: signal || AbortSignal.timeout(60000),
            }), { isSuccess: result => result.ok });
            const raw: any = await response.json();
            if (raw?.code !== 0 || !raw?.data?.image_key) {
                if (raw?.code !== 0) return this._resultFromApi(raw, 'chat_id', '');
                return { ok: false, raw, error: raw?.msg || raw?.message || 'Feishu image upload failed', retryable: true };
            }
            return { ok: true, raw, image_key: raw.data.image_key };
        } catch (error: any) {
            return this._sendFailure(error);
        }
    }

    async sendGroupImageKey(imageKey: string, chatId: string, signal?: AbortSignal): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, imageKey, chatId }, chat_id: chatId };
        return this._sendImageKey("chat_id", chatId, imageKey, signal);
    }

    async sendReplyImageKey(imageKey: string, messageId: string, signal?: AbortSignal): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, imageKey, messageId } };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return circuitFailure;
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
            const response = await this._observe('POST', url, () => axios.post(url, {
                msg_type: "image",
                content: JSON.stringify({ image_key: imageKey }),
            }, {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
                timeout: 60000,
                signal,
            }), { isSuccess: result => result.data?.code === 0 });
            return this._resultFromApi(response.data, "chat_id", "");
        } catch (error: any) {
            return this._sendFailure(error);
        }
    }



    private async _sendMessage(receiveIdType: "open_id" | "chat_id", receiveId: string, text: string, signal?: AbortSignal): Promise<SendResult> {
        if (!String(receiveId || "").trim()) {
            return { ok: false, raw: {}, error: "receive_id is required", retryable: false };
        }
        if (this.dryRun) return { ok: true, raw: { dry_run: true, receiveIdType, receiveId, text }, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return { ...circuitFailure, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
            const resp = await this._observe('POST', url, () => axios.post(url, {
                receive_id: receiveId,
                msg_type: "text",
                content: JSON.stringify({ text }),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
                signal,
            }), { isSuccess: result => result.data?.code === 0 });
            return this._resultFromApi(resp.data, receiveIdType, receiveId);
        } catch (e: any) {
            return this._sendFailure(e, receiveIdType === "chat_id" ? receiveId : undefined);
        }
    }

    private async _sendImageKey(receiveIdType: "open_id" | "chat_id", receiveId: string, imageKey: string, signal?: AbortSignal): Promise<SendResult> {
        if (!String(receiveId || "").trim()) {
            return { ok: false, raw: {}, error: "receive_id is required", retryable: false };
        }
        if (this.dryRun) return { ok: true, raw: { dry_run: true, receiveIdType, receiveId, imageKey }, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return { ...circuitFailure, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
            const response = await this._observe('POST', url, () => axios.post(url, {
                receive_id: receiveId,
                msg_type: "image",
                content: JSON.stringify({ image_key: imageKey }),
            }, {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
                timeout: 60000,
                signal,
            }), { isSuccess: result => result.data?.code === 0 });
            return this._resultFromApi(response.data, receiveIdType, receiveId);
        } catch (error: any) {
            return this._sendFailure(error, receiveIdType === "chat_id" ? receiveId : undefined);
        }
    }

    private async _sendInteractive(receiveIdType: "open_id" | "chat_id", receiveId: string, text: string, title?: string, signal?: AbortSignal): Promise<SendResult> {
        return this._sendInteractiveCard(receiveIdType, receiveId, {
            elements: [{ tag: "markdown", content: text }],
        }, title, signal);
    }

    private async _sendInteractiveCard(
        receiveIdType: "open_id" | "chat_id",
        receiveId: string,
        input: Record<string, unknown>,
        title?: string,
        signal?: AbortSignal,
    ): Promise<SendResult> {
        if (!String(receiveId || "").trim()) {
            return { ok: false, raw: {}, error: "receive_id is required", retryable: false };
        }
        if (this.dryRun) return { ok: true, raw: { dry_run: true, receiveIdType, receiveId, card: input, title }, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return { ...circuitFailure, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
            const card: any = {
                ...input,
                config: { wide_screen_mode: true },
            };
            if (input.config && typeof input.config === "object") {
                card.config = { ...(input.config as Record<string, unknown>), wide_screen_mode: true };
            }
            if (title) {
                card.header = {
                    title: { tag: "plain_text", content: title },
                    template: "blue"
                };
            }
            const resp = await this._observe('POST', url, () => axios.post(url, {
                receive_id: receiveId,
                msg_type: "interactive",
                content: JSON.stringify(card),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
                signal,
            }), { isSuccess: result => result.data?.code === 0 });
            return this._resultFromApi(resp.data, receiveIdType, receiveId);
        } catch (e: any) {
            return this._sendFailure(e, receiveIdType === "chat_id" ? receiveId : undefined);
        }
    }

    private _resultFromApi(raw: any, receiveIdType: "open_id" | "chat_id", receiveId: string): SendResult {
        const { chatId, messageId } = this._extractResultFields(raw);
        if (raw?.code !== 0) {
            const failure = this._classifyFailure({ raw });
            const result: SendResult = {
                ok: false,
                raw,
                chat_id: chatId || (receiveIdType === "chat_id" ? receiveId : undefined),
                message_id: messageId,
                error: failure.message || JSON.stringify(raw),
                error_code: failure.code,
                retry_after_ms: failure.retryAfterMs,
            };
            result.retryable = failure.retryable && !isPermanentFeishuSendFailure(result);
            return result;
        }

        return {
            ok: true,
            raw,
            chat_id: chatId || (receiveIdType === "chat_id" ? receiveId : undefined),
            message_id: messageId,
        };
    }

    private async _sendReply(messageId: string, text: string, signal?: AbortSignal): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, text }, chat_id: undefined };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return circuitFailure;
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
            const resp = await this._observe('POST', url, () => axios.post(url, {
                msg_type: "text",
                content: JSON.stringify({ text }),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
                signal,
            }), { isSuccess: result => result.data?.code === 0 });
            return this._resultFromApi(resp.data, "chat_id", "");
        } catch (e: any) {
            return this._sendFailure(e);
        }
    }

    private async _sendReplyInteractive(messageId: string, text: string, title?: string, signal?: AbortSignal): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, text, title }, chat_id: undefined };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return circuitFailure;
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;

            const card: any = {
                config: { wide_screen_mode: true },
                elements: [
                    { tag: "markdown", content: text }
                ]
            };
            if (title) {
                card.header = {
                    title: { tag: "plain_text", content: title },
                    template: "blue"
                };
            }

            const resp = await this._observe('POST', url, () => axios.post(url, {
                msg_type: "interactive",
                content: JSON.stringify(card),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
                signal,
            }), { isSuccess: result => result.data?.code === 0 });
            return this._resultFromApi(resp.data, "chat_id", "");
        } catch (e: any) {
            return this._sendFailure(e);
        }
    }

    async sendReplyFile(messageId: string, filePath: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, filePath }, chat_id: undefined };
        const circuitFailure = this._quotaCircuitFailure();
        if (circuitFailure) return circuitFailure;
        const resolvedPath = path.resolve(filePath);
        try {
            const token = await this._getTenantAccessToken();

            const fileData = fs.readFileSync(resolvedPath);
            const formData = new FormData();
            formData.append('file_type', 'stream');
            formData.append('file_name', path.basename(resolvedPath));
            formData.append('file', new Blob([fileData]));

            const uploadUrl = `https://open.feishu.cn/open-apis/im/v1/files`;
            const uploadResp = await this._observe('POST', uploadUrl, () => fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    "Authorization": `Bearer ${token}`
                },
                body: formData
            }), { isSuccess: result => result.ok });
            const uploadJson: any = await uploadResp.json();

            if (uploadJson.code !== 0) {
                return this._resultFromApi(uploadJson, 'chat_id', '');
            }

            const fileKey = uploadJson.data.file_key;

            const replyUrl = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`;
            const replyResp = await this._observe('POST', replyUrl, () => axios.post(replyUrl, {
                msg_type: "file",
                content: JSON.stringify({ file_key: fileKey }),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
            }), { isSuccess: result => result.data?.code === 0 });

            if (replyResp.data.code !== 0) {
                return this._resultFromApi(replyResp.data, 'chat_id', '');
            }

            return { ok: true, raw: replyResp.data, message_id: replyResp.data.data.message_id };
        } catch (e: any) {
            return this._sendFailure(e);
        }
    }

    async addReaction(messageId: string, emojiType: string = WORKING_REACTION_EMOJI_TYPE): Promise<string | null> {
        this.lastReactionError = null;
        if (this.dryRun || !messageId) return null;
        if (this._quotaCircuitFailure()) {
            this.lastReactionError = 'Feishu monthly API quota is exhausted';
            return null;
        }

        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`;
            const resp = await this._observe('POST', url, () => axios.post(url, { reaction_type: { emoji_type: emojiType } }, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 5000
            }), { isSuccess: result => result.data?.code === 0 });
            if (resp.data.code === 0) {
                return resp.data.data?.reaction_id || null;
            }
            const failure = this._classifyFailure({ raw: resp.data });
            this.lastReactionError = failure.message;
        } catch (e) {
            this.lastReactionError = this._classifyFailure(e).message;
        }
        return null;
    }

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
        if (this.dryRun || !messageId || !reactionId) return;
        if (this._quotaCircuitFailure()) return;
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
            const response = await this._observe('DELETE', url, () => axios.delete(url, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 5000
            }), { isSuccess: result => result.data?.code === 0 });
            if (response.data?.code !== 0) {
                this._classifyFailure({ raw: response.data });
            }
        } catch (e) {
            this._classifyFailure(e);
        }
    }

    async getMessageImageKeys(messageId: string): Promise<string[]> {
        if (this.dryRun || !messageId) return [];
        if (this._quotaCircuitFailure()) return [];
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`;
            const response = await this._observe('GET', url, () => axios.get(url, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 30000
            }), { isSuccess: result => result.data?.code === 0 });
            if (response.data?.code !== 0) {
                this._classifyFailure({ raw: response.data });
                return [];
            }
            return extractFeishuImageKeys(response.data?.data?.items || response.data?.data);
        } catch (e) {
            this._classifyFailure(e);
            console.error(`[FeishuAdapter] getMessageImageKeys error:`, e);
            return [];
        }
    }

    async downloadResourceWithMetadata(messageId: string, fileKey: string, type: 'file' | 'image', destPath: string): Promise<DownloadResourceResult> {
        if (this.dryRun) return { ok: false, error: "dry_run" };
        if (this._quotaCircuitFailure()) return { ok: false, error: 'Feishu monthly API quota is exhausted' };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
            const response = await this._observe('GET', url, () => axios.get(url, {
                headers: { "Authorization": `Bearer ${token}` },
                responseType: 'stream',
                timeout: 30000
            }), { isSuccess: () => true });
            const writer = fs.createWriteStream(destPath);
            response.data.pipe(writer);
            const ok = await new Promise<boolean>((resolve) => {
                writer.on('finish', () => resolve(true));
                writer.on('error', () => resolve(false));
                response.data.on('error', () => resolve(false));
            });
            if (!ok) return { ok: false, error: "resource_stream_failed" };
            const contentType = response.headers?.["content-type"];
            const contentDisposition = response.headers?.["content-disposition"];
            return {
                ok: true,
                contentType: typeof contentType === "string" ? contentType : undefined,
                fileName: this._resourceFileName(typeof contentDisposition === "string" ? contentDisposition : undefined),
            };
        } catch (e) {
            const failure = this._classifyFailure(e);
            console.error(`[FeishuAdapter] downloadResource error:`, e);
            return { ok: false, error: failure.message };
        }
    }

    async downloadResource(messageId: string, fileKey: string, type: 'file' | 'image', destPath: string): Promise<boolean> {
        return (await this.downloadResourceWithMetadata(messageId, fileKey, type, destPath)).ok;
    }

    private _resourceFileName(contentDisposition?: string): string | undefined {
        if (!contentDisposition) return undefined;
        const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        if (encoded) {
            try {
                return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
            } catch {}
        }
        return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1];
    }



    private async _runWithRetry(cmd: string[], timeoutMs: number, cwd?: string): Promise<{stdout: string, stderr: string, code: number}> {
        const attempts = Math.max(1, (this.config.send_retry_count || 1) + 1);
        let lastResult = { stdout: "", stderr: "", code: 1 };

        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const [executable, ...args] = cmd;
                const { stdout, stderr } = await execFileAsync(executable, args, { timeout: timeoutMs, cwd });
                return { stdout, stderr, code: 0 };
            } catch (e: any) {
                lastResult = { stdout: e.stdout || "", stderr: e.stderr || String(e), code: e.code || 1 };
                if (attempt === attempts - 1) return lastResult;
                await new Promise(r => setTimeout(r, Math.min(Math.pow(2, attempt) * 1000, 5000)));
            }
        }
        return lastResult;
    }

    private _resultFromProcess(proc: {stdout: string, stderr: string, code: number}): SendResult {
        let raw: any = {};
        if (proc.stdout.trim()) raw = this._parseJsonOutput(proc.stdout);
        if (Object.keys(raw).length === 0 && proc.stderr.trim()) raw = this._parseJsonOutput(proc.stderr);

        const { chatId, messageId, fileToken, url } = this._extractResultFields(raw);
        const apiCode = raw?.code ?? raw?.error?.code;
        if (apiCode !== undefined && Number(apiCode) !== 0) {
            return { ok: false, raw, chat_id: chatId, message_id: messageId, file_token: fileToken, url, error: raw?.msg || raw?.message || raw?.error?.message || JSON.stringify(raw) };
        }
        if (proc.code !== 0) {
            return { ok: false, raw, chat_id: chatId, message_id: messageId, file_token: fileToken, url, error: proc.stderr.trim() || proc.stdout.trim() };
        }
        return { ok: true, raw, chat_id: chatId, message_id: messageId, file_token: fileToken, url };
    }

    private _parseJsonOutput(stdout: string): any {
        const text = stdout.trim();
        try { return JSON.parse(text); } catch {}
        const start = text.indexOf('{');
        if (start >= 0) {
            try { return JSON.parse(text.slice(start)); } catch {}
        }
        return { stdout };
    }

    private _extractResultFields(raw: any) {
        const scopes: any[] = [];
        if (typeof raw?.data === 'object' && raw.data !== null) scopes.push(raw.data);
        scopes.push(raw);
        return {
            chatId: this._firstValue(scopes, ["chat_id"]),
            messageId: this._firstValue(scopes, ["message_id"]),
            fileToken: this._firstValue(scopes, ["file_token", "token"]),
            url: this._firstValue(scopes, ["url", "file_url", "link"])
        };
    }

    private _firstValue(scopes: any[], keys: string[]): string | undefined {
        for (const scope of scopes) {
            for (const key of keys) {
                if (typeof scope[key] === 'string' && scope[key]) return scope[key];
            }
            for (const nestedKey of ["file", "item", "document"]) {
                const nested = scope[nestedKey];
                if (typeof nested === 'object' && nested !== null) {
                    const nestedValue = this._firstValue([nested], keys);
                    if (nestedValue) return nestedValue;
                }
            }
        }
        return undefined;
    }

    private _auditSend(channel: string, target: string, result: SendResult) {
        if (!this.auditCallback) return;
        try {
            this.auditCallback("bot_message_sent", {
                channel, target, ok: result.ok, message_id: result.message_id,
                chat_id: result.chat_id, error: result.error
            });
        } catch {}
    }



    explainError(result: SendResult): string {
        const error = result.raw?.error || {};
        const missing = error.missing_scopes || [];
        if (missing.length > 0) return `请在飞书开放平台为应用开通以下权限：${missing.join('、')}`;
        if (error.message) return String(error.message);
        if (result.error) {
            const lines = result.error.split('\n');
            return lines[lines.length - 1];
        }
        return "未知错误";
    }

    parseEvent(payload: any): SourceMessage | null {
        const parser = new FeishuEventParser(this.config.bot_open_id || "", this.knownNames);
        return parser.parse(payload);
    }

    private _departmentNameCache: Record<string, string> = {};

    async getDepartmentName(depId: string, token: string): Promise<string> {
        if (this._departmentNameCache[depId]) return this._departmentNameCache[depId];
        try {
            const url = `https://open.feishu.cn/open-apis/contact/v3/departments/${depId}?department_id_type=open_department_id`;
            const resp = await this._observe('GET', url, () => axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            }), { metered: false, isSuccess: result => result.data?.code === 0 });
            if (resp.data.code === 0 && resp.data.data?.department?.name) {
                this._departmentNameCache[depId] = resp.data.data.department.name;
                return this._departmentNameCache[depId];
            }
        } catch (e) {
            console.error(`Feishu get department ${depId} failed:`, e);
        }
        return depId;
    }

    async syncCompanyMembers(openIds: string[]): Promise<Array<{ open_id: string; name: string; department: string | null }>> {
        if (this.dryRun || openIds.length === 0) return [];
        const token = await this._getTenantAccessToken();
        const results: Array<{ open_id: string; name: string; department: string | null }> = [];

        const BATCH_SIZE = 5;
        for (let i = 0; i < openIds.length; i += BATCH_SIZE) {
            const batch = openIds.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (openId) => {
                try {
                    const url = `https://open.feishu.cn/open-apis/contact/v3/users/${openId}?department_id_type=open_department_id&user_id_type=open_id`;
                    const resp = await this._observe('GET', url, () => axios.get(url, {
                        headers: { Authorization: `Bearer ${token}` }
                    }), { metered: false, isSuccess: result => result.data?.code === 0 });
                    if (resp.data.code === 0 && resp.data.data?.user) {
                        const user = resp.data.data.user;
                        let department = null;
                        if (user.department_ids && user.department_ids.length > 0) {
                            const depNames = await Promise.all(user.department_ids.map((id: string) => this.getDepartmentName(id, token)));
                            department = depNames.join("/");
                        }
                        return {
                            open_id: openId,
                            name: user.name || openId,
                            department
                        };
                    }
                } catch (e: any) {
                    const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : (e.message || String(e));
                    console.error(`Feishu fetch user ${openId} failed:`, errorDetail);
                }
                return null;
            });
            const batchResults = await Promise.all(promises);
            for (const r of batchResults) {
                if (r) results.push(r);
            }
        }
        return results;
    }

    async fetchAllCompanyMembers(): Promise<Array<{ open_id: string; name: string; department: string | null }>> {
        if (this.dryRun) return [];
        const token = await this._getTenantAccessToken();
        const results: Array<{ open_id: string; name: string; department: string | null }> = [];
        const seenOpenIds = new Set<string>();
        const deadlineAt = Date.now() + FEISHU_DIRECTORY_SYNC_TIMEOUT_MS;
        let requestCount = 0;

        const beforePageRequest = (scope: string, pageToken: string, pageCount: number, requestedTokens: Set<string>): number => {
            if (requestedTokens.has(pageToken)) {
                throw feishuGuardError('FEISHU_DIRECTORY_REPEATED_PAGE_TOKEN', `${scope} repeated page_token after ${pageCount} pages`);
            }
            if (pageCount >= FEISHU_LIST_MAX_PAGES) {
                throw feishuGuardError('FEISHU_DIRECTORY_PAGE_LIMIT_EXCEEDED', `${scope} exceeded ${FEISHU_LIST_MAX_PAGES} pages`);
            }
            if (requestCount >= FEISHU_DIRECTORY_MAX_REQUESTS) {
                throw feishuGuardError('FEISHU_DIRECTORY_REQUEST_LIMIT_EXCEEDED', `Feishu directory sync exceeded ${FEISHU_DIRECTORY_MAX_REQUESTS} requests`);
            }
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                throw feishuGuardError('FEISHU_DIRECTORY_SYNC_TIMEOUT', `Feishu directory sync exceeded ${FEISHU_DIRECTORY_SYNC_TIMEOUT_MS}ms`);
            }
            requestedTokens.add(pageToken);
            requestCount++;
            return remainingMs;
        };

        const nextPageToken = (scope: string, data: any, pageCount: number, requestedTokens: Set<string>): string => {
            if (!data?.has_more) return "";
            const next = String(data.page_token || "");
            if (!next) {
                throw feishuGuardError('FEISHU_DIRECTORY_MISSING_PAGE_TOKEN', `${scope} returned has_more without page_token after ${pageCount} pages`);
            }
            if (requestedTokens.has(next)) {
                throw feishuGuardError('FEISHU_DIRECTORY_REPEATED_PAGE_TOKEN', `${scope} repeated page_token after ${pageCount} pages`);
            }
            return next;
        };

        try {
            // 1. Fetch all departments recursively (assuming root is '0')
            let allDepartments: any[] = [];
            let hasMore = true;
            let pageToken = "";
            let departmentPageCount = 0;
            const departmentPageTokens = new Set<string>();
            while (hasMore) {
                const remainingMs = beforePageRequest('Feishu department pagination', pageToken, departmentPageCount, departmentPageTokens);
                departmentPageCount++;
                const url = `https://open.feishu.cn/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
                const resp = await this._observe('GET', url, () => axios.get(url, {
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: Math.max(1, Math.min(FEISHU_PAGE_REQUEST_TIMEOUT_MS, remainingMs)),
                }), { metered: false, isSuccess: result => result.data?.code === 0 });
                if (resp.data.code === 0 && Array.isArray(resp.data.data?.items)) {
                    allDepartments.push(...resp.data.data.items);
                    console.log(`Fetched ${resp.data.data.items.length} departments. has_more: ${resp.data.data.has_more}`);
                    pageToken = nextPageToken('Feishu department pagination', resp.data.data, departmentPageCount, departmentPageTokens);
                    hasMore = Boolean(pageToken);
                } else {
                    throw new Error(`Fetch departments failed: ${resp.data?.msg || JSON.stringify(resp.data)}`);
                }
            }

            // Also need to fetch root department users (department_id = 0)
            allDepartments.push({ open_department_id: "0", name: "Root" });

            // Cache department names and parent relationships
            const depMap: Record<string, any> = {};
            for (const dep of allDepartments) {
                depMap[dep.open_department_id] = dep;
                if (dep.name && dep.open_department_id !== "0") {
                    this._departmentNameCache[dep.open_department_id] = dep.name;
                }
            }

            // Helper to get full path
            const getFullPath = (depId: string): string => {
                const path: string[] = [];
                let currentId = depId;
                const visited = new Set<string>(); // Prevent infinite loops
                while (currentId && currentId !== "0" && !visited.has(currentId)) {
                    visited.add(currentId);
                    const dep = depMap[currentId];
                    if (dep) {
                        path.unshift(dep.name);
                        currentId = dep.parent_department_id;
                    } else {
                        break;
                    }
                }
                return path.join('/');
            };

            // 2. Fetch users for each department
            for (const dep of allDepartments) {
                let depHasMore = true;
                let depPageToken = "";
                let depPageCount = 0;
                const depPageTokens = new Set<string>();
                while (depHasMore) {
                    const scope = `Feishu department ${dep.open_department_id} user pagination`;
                    const remainingMs = beforePageRequest(scope, depPageToken, depPageCount, depPageTokens);
                    depPageCount++;
                    const url = `https://open.feishu.cn/open-apis/contact/v3/users/find_by_department?department_id=${encodeURIComponent(dep.open_department_id)}&department_id_type=open_department_id&user_id_type=open_id${depPageToken ? `&page_token=${encodeURIComponent(depPageToken)}` : ''}`;
                    try {
                        const resp = await this._observe('GET', url, () => axios.get(url, {
                            headers: { Authorization: `Bearer ${token}` },
                            timeout: Math.max(1, Math.min(FEISHU_PAGE_REQUEST_TIMEOUT_MS, remainingMs)),
                        }), { metered: false, isSuccess: result => result.data?.code === 0 });
                        if (resp.data.code === 0 && Array.isArray(resp.data.data?.items)) {
                            for (const user of resp.data.data.items) {
                                if (seenOpenIds.has(user.open_id)) continue;
                                seenOpenIds.add(user.open_id);

                                let department = null;
                                if (user.department_ids && user.department_ids.length > 0) {
                                    // Use the full hierarchical path of the first department
                                    department = getFullPath(user.department_ids[0]);
                                } else {
                                    // Fallback to the current department we are iterating over
                                    department = getFullPath(dep.open_department_id);
                                }

                                results.push({
                                    open_id: user.open_id,
                                    name: user.name || user.open_id,
                                    department
                                });
                            }
                            depPageToken = nextPageToken(scope, resp.data.data, depPageCount, depPageTokens);
                            depHasMore = Boolean(depPageToken);
                        } else {
                            throw new Error(`Fetch users for department ${dep.open_department_id} failed: ${resp.data?.msg || JSON.stringify(resp.data)}`);
                        }
                    } catch (e: any) {
                        if (axios.isAxiosError(e) && e.code === 'ECONNABORTED') {
                            throw feishuGuardError('FEISHU_DIRECTORY_REQUEST_TIMEOUT', `Fetch users for department ${dep.open_department_id} timed out`);
                        }
                        throw Object.assign(new Error(`Fetch users for department ${dep.open_department_id} failed: ${e?.message || String(e)}`), {
                            code: e?.code,
                            retryable: e?.retryable,
                            retryAfterMs: e?.retryAfterMs,
                        });
                    }
                }
            }
        } catch (e: any) {
            if (axios.isAxiosError(e) && e.code === 'ECONNABORTED') {
                throw feishuGuardError('FEISHU_DIRECTORY_REQUEST_TIMEOUT', 'Feishu department pagination timed out');
            }
            throw Object.assign(new Error(`Feishu fetchAllCompanyMembers failed: ${e.message || String(e)}`), {
                code: e?.code,
                retryable: e?.retryable,
                retryAfterMs: e?.retryAfterMs,
            });
        }

        return results;
    }

    async listGroups(): Promise<any[]> {
        if (this.dryRun) return [];
        this._assertMeteredApiAvailable();
        const token = await this._getTenantAccessToken();
        const url = `https://open.feishu.cn/open-apis/im/v1/chats?page_size=100`;
        return this._getPagedItems(url, token, "Feishu list groups failed");
    }

    async fetchChatHistory(chatId: string, startTime: Date, endTime: Date): Promise<SourceMessage[]> {
        if (this.dryRun || !chatId) return [];
        this._assertMeteredApiAvailable();

        const token = await this._getTenantAccessToken();
        const parser = new FeishuEventParser(this.config.bot_open_id || "", this.knownNames);
        const messages: SourceMessage[] = [];
        const requestedPageTokens = new Set<string>();
        const deadlineAt = Date.now() + FEISHU_HISTORY_SYNC_TIMEOUT_MS;
        let pageToken = "";
        let pageCount = 0;

        do {
            if (requestedPageTokens.has(pageToken)) {
                throw feishuGuardError(
                    'FEISHU_HISTORY_REPEATED_PAGE_TOKEN',
                    `Feishu chat history pagination repeated page_token after ${pageCount} pages`,
                );
            }
            if (pageCount >= FEISHU_HISTORY_MAX_PAGES) {
                throw feishuGuardError(
                    'FEISHU_HISTORY_PAGE_LIMIT_EXCEEDED',
                    `Feishu chat history exceeded ${FEISHU_HISTORY_MAX_PAGES} pages`,
                );
            }
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                throw feishuGuardError(
                    'FEISHU_HISTORY_SYNC_TIMEOUT',
                    `Feishu chat history exceeded ${FEISHU_HISTORY_SYNC_TIMEOUT_MS}ms`,
                );
            }
            requestedPageTokens.add(pageToken);
            pageCount++;

            try {
                const url = "https://open.feishu.cn/open-apis/im/v1/messages";
                const response = await this._observe('GET', url, () => axios.get(url, {
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: Math.max(1, Math.min(FEISHU_PAGE_REQUEST_TIMEOUT_MS, remainingMs)),
                    params: {
                        container_id_type: "chat",
                        container_id: chatId,
                        start_time: String(Math.floor(startTime.getTime() / 1000)),
                        end_time: String(Math.floor(endTime.getTime() / 1000)),
                        sort_type: "ByCreateTimeAsc",
                        page_size: FEISHU_HISTORY_PAGE_SIZE,
                        ...(pageToken ? { page_token: pageToken } : {}),
                    },
                }), { isSuccess: result => result.data?.code === 0 });
                if (response.data?.code !== 0) {
                    const failure = classifyFeishuFailure({ raw: response.data });
                    if (failure.quotaExhausted) openExternalApiCircuit('feishu', failure.code, nextShanghaiMonthStart(), this.config.app_id || 'unconfigured');
                    throw Object.assign(new Error(`Feishu fetch chat history failed: ${failure.message}`), {
                        code: failure.code,
                        retryable: failure.retryable,
                        retryAfterMs: failure.retryAfterMs,
                    });
                }

                const data = response.data?.data || {};
                for (const item of Array.isArray(data.items) ? data.items : []) {
                    if (item.deleted === true) continue;
                    if (item.msg_type === "system") continue;
                    if (item.sender?.sender_type && item.sender.sender_type !== "user") continue;

                    const source = parser.parse({
                        event: {
                            sender: { sender_id: { open_id: item.sender?.id || "" } },
                            message: {
                                message_id: item.message_id,
                                chat_id: item.chat_id || chatId,
                                chat_type: "group",
                                message_type: item.msg_type || "text",
                                content: item.body?.content || "",
                                mentions: (item.mentions || []).map((mention: any) => ({
                                    key: mention.key || "",
                                    name: mention.name || "",
                                    id: { open_id: mention.id || mention.open_id || "" },
                                })),
                                create_time: item.create_time,
                                parent_id: item.parent_id,
                                root_id: item.root_id,
                            },
                        },
                    });
                    if (!source) continue;

                    const placeholders: Record<string, string> = {
                        image: "[图片消息]",
                        file: "[文件消息]",
                        audio: "[语音消息]",
                        media: "[视频消息]",
                        sticker: "[表情消息]",
                    };
                    if (placeholders[source.message_type || ""]) {
                        source.text = placeholders[source.message_type || ""];
                    }
                    source.raw_payload = item;
                    messages.push(source);
                }

                const nextPageToken = data.has_more ? String(data.page_token || "") : "";
                if (data.has_more && !nextPageToken) {
                    throw feishuGuardError(
                        'FEISHU_HISTORY_MISSING_PAGE_TOKEN',
                        `Feishu chat history returned has_more without page_token after ${pageCount} pages`,
                    );
                }
                if (nextPageToken && requestedPageTokens.has(nextPageToken)) {
                    throw feishuGuardError(
                        'FEISHU_HISTORY_REPEATED_PAGE_TOKEN',
                        `Feishu chat history pagination repeated page_token after ${pageCount} pages`,
                    );
                }
                pageToken = nextPageToken;
            } catch (error: any) {
                if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
                    throw feishuGuardError(
                        'FEISHU_HISTORY_REQUEST_TIMEOUT',
                        `Feishu chat history page ${pageCount} timed out`,
                    );
                }
                if (axios.isAxiosError(error) && error.response?.data) {
                    throw this._apiError(error, 'Feishu fetch chat history failed');
                }
                throw error;
            }
        } while (pageToken);

        return messages;
    }

    async listGroupMembers(chatId: string): Promise<any[]> {
        if (this.dryRun || !chatId) return [];
        this._assertMeteredApiAvailable();
        const token = await this._getTenantAccessToken();
        const url = `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?member_id_type=open_id&page_size=100`;
        const items = await this._getPagedItems(url, token, "Feishu list group members failed");
        const members = items.map((item: any) => {
            const openId = item.open_id || item.member_id || item.user_id || "";
            return {
                ...item,
                open_id: openId,
                name: item.name || item.user_name || item.en_name || openId,
            };
        });
        for (let index = 0; index < members.length; index += 5) {
            const batch = members.slice(index, index + 5);
            await Promise.all(batch.map(async (member: any) => {
                if (!member.open_id) return;
                const cached = this.memberJobTitleCache.get(member.open_id);
                if (cached && cached.expiresAt > Date.now()) {
                    member.job_title = cached.jobTitle;
                    return;
                }
                try {
                    const userUrl = `https://open.feishu.cn/open-apis/contact/v3/users/${member.open_id}?user_id_type=open_id`;
                    const response = await this._observe('GET', userUrl, () => axios.get(
                        userUrl,
                        { headers: { Authorization: `Bearer ${token}` } },
                    ), { metered: false, isSuccess: result => result.data?.code === 0 });
                    if (response.data?.code === 0) {
                        const jobTitle = response.data?.data?.user?.job_title || undefined;
                        member.job_title = jobTitle;
                        this.memberJobTitleCache.set(member.open_id, { jobTitle, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
                        while (this.memberJobTitleCache.size > 5_000) {
                            const oldest = this.memberJobTitleCache.keys().next().value;
                            if (!oldest) break;
                            this.memberJobTitleCache.delete(oldest);
                        }
                    }
                } catch {
                    // 群成员同步仍可继续，职务暂时沿用本地已有值。
                }
            }));
        }
        return members;
    }

    private async _getPagedItems(url: string, token: string, errorPrefix: string): Promise<any[]> {
        const items: any[] = [];
        const requestedPageTokens = new Set<string>();
        const deadlineAt = Date.now() + FEISHU_LIST_SYNC_TIMEOUT_MS;
        let pageToken = "";
        let pageCount = 0;

        do {
            if (requestedPageTokens.has(pageToken)) {
                throw feishuGuardError('FEISHU_LIST_REPEATED_PAGE_TOKEN', `${errorPrefix}: repeated page_token after ${pageCount} pages`);
            }
            if (pageCount >= FEISHU_LIST_MAX_PAGES) {
                throw feishuGuardError('FEISHU_LIST_PAGE_LIMIT_EXCEEDED', `${errorPrefix}: exceeded ${FEISHU_LIST_MAX_PAGES} pages`);
            }
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                throw feishuGuardError('FEISHU_LIST_SYNC_TIMEOUT', `${errorPrefix}: exceeded ${FEISHU_LIST_SYNC_TIMEOUT_MS}ms`);
            }
            requestedPageTokens.add(pageToken);
            pageCount++;
            const pageUrl = pageToken ? `${url}&page_token=${encodeURIComponent(pageToken)}` : url;
            try {
                const resp = await this._observe('GET', pageUrl, () => axios.get(pageUrl, {
                    headers: { "Authorization": `Bearer ${token}` },
                    timeout: Math.max(1, Math.min(FEISHU_PAGE_REQUEST_TIMEOUT_MS, remainingMs)),
                }), { isSuccess: result => result.data?.code === 0 });
                if (resp.data?.code !== 0) {
                    const failure = classifyFeishuFailure({ raw: resp.data });
                    if (failure.quotaExhausted) openExternalApiCircuit('feishu', failure.code, nextShanghaiMonthStart(), this.config.app_id || 'unconfigured');
                    throw Object.assign(new Error(`${errorPrefix}: ${failure.message}`), {
                        code: failure.code,
                        retryable: failure.retryable,
                        retryAfterMs: failure.retryAfterMs,
                    });
                }

                const data = resp.data?.data || {};
                items.push(...(Array.isArray(data.items) ? data.items : []));
                const nextPageToken = data.has_more ? String(data.page_token || "") : "";
                if (data.has_more && !nextPageToken) {
                    throw feishuGuardError('FEISHU_LIST_MISSING_PAGE_TOKEN', `${errorPrefix}: returned has_more without page_token after ${pageCount} pages`);
                }
                if (nextPageToken && requestedPageTokens.has(nextPageToken)) {
                    throw feishuGuardError('FEISHU_LIST_REPEATED_PAGE_TOKEN', `${errorPrefix}: repeated page_token after ${pageCount} pages`);
                }
                pageToken = nextPageToken;
            } catch (e: any) {
                if (axios.isAxiosError(e) && e.code === 'ECONNABORTED') {
                    throw feishuGuardError('FEISHU_LIST_REQUEST_TIMEOUT', `${errorPrefix}: page ${pageCount} timed out`);
                }
                if (axios.isAxiosError(e) && e.response?.data) {
                    throw this._apiError(e, errorPrefix);
                }
                throw e;
            }
        } while (pageToken);

        return items;
    }
}
