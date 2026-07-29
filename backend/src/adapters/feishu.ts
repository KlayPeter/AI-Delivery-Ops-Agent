import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { FeishuConfig } from '@/core/config';
import { SourceMessage, Mention, utcNowIso } from '@/models/types';

const execFileAsync = promisify(execFile);

export const WORKING_REACTION_EMOJI_TYPES = ["Typing", "OnIt"];
export const WORKING_REACTION_EMOJI_TYPE = WORKING_REACTION_EMOJI_TYPES[0];

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
}

export function isPermanentFeishuSendFailure(result: Pick<SendResult, "ok" | "raw" | "error" | "retryable">): boolean {
    if (result.ok) return false;
    if (result.retryable === false) return true;
    const code = Number(result.raw?.code ?? result.raw?.error?.code);
    if (code === 230001) return true;
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

    constructor(config: FeishuConfig, dryRun: boolean = false, knownNames: Record<string, string> = {}) {
        this.config = config;
        this.dryRun = dryRun;
        this.knownNames = knownNames;
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
            const resp = await axios.post(url, {
                app_id: this.config.app_id,
                app_secret: this.config.app_secret
            });
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
            const resp = await axios.get(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (resp.data.code === 0 && resp.data.data?.user?.name) {
                return resp.data.data.user.name;
            }
        } catch (e) {
            // Ignore errors (like lack of permission or cross app)
        }
        return null;
    }

    async sendGroupText(text: string, chatId: string): Promise<SendResult> {
        const result = await this._sendMessage("chat_id", chatId, text);
        this._auditSend("group", chatId, result);
        return result;
    }

    async sendGroupMarkdown(text: string, chatId: string, title?: string): Promise<SendResult> {
        const result = await this._sendInteractive("chat_id", chatId, text, title);
        this._auditSend("group_markdown", chatId, result);
        return result;
    }

    async sendPrivateText(openId: string, text: string): Promise<SendResult> {
        const result = await this._sendMessage("open_id", openId, text);
        this._auditSend("private", openId, result);
        return result;
    }

    async sendPrivateMarkdown(openId: string, text: string, title?: string): Promise<SendResult> {
        const result = await this._sendInteractive("open_id", openId, text, title);
        this._auditSend("private_markdown", openId, result);
        return result;
    }

    async sendReplyText(messageId: string, text: string): Promise<SendResult> {
        if (!messageId) {
            const res = { ok: false, raw: {}, error: "message_id is required for reply" };
            this._auditSend("reply", messageId, res);
            return res;
        }
        const result = await this._sendReply(messageId, text);
        this._auditSend("reply", messageId, result);
        return result;
    }

    async sendReplyMarkdown(messageId: string, text: string, title?: string): Promise<SendResult> {
        if (!messageId) {
            const res = { ok: false, raw: {}, error: "message_id is required for reply" };
            this._auditSend("reply_markdown", messageId, res);
            return res;
        }
        const result = await this._sendReplyInteractive(messageId, text, title);
        this._auditSend("reply_markdown", messageId, result);
        return result;
    }

    async uploadImage(imagePath: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, imagePath }, image_key: "dry-run-image-key" };
        try {
            const token = await this._getTenantAccessToken();
            const imageData = fs.readFileSync(path.resolve(imagePath));
            const formData = new FormData();
            formData.append('image_type', 'message');
            formData.append('image', new Blob([imageData]), path.basename(imagePath));
            const response = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData,
                signal: AbortSignal.timeout(60000),
            });
            const raw: any = await response.json();
            if (raw?.code !== 0 || !raw?.data?.image_key) {
                return { ok: false, raw, error: raw?.msg || raw?.message || 'Feishu image upload failed' };
            }
            return { ok: true, raw, image_key: raw.data.image_key };
        } catch (error: any) {
            return { ok: false, raw: {}, error: error?.message || String(error) };
        }
    }

    async sendGroupImageKey(imageKey: string, chatId: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, imageKey, chatId }, chat_id: chatId };
        return this._sendImageKey("chat_id", chatId, imageKey);
    }

    async sendReplyImageKey(imageKey: string, messageId: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, imageKey, messageId } };
        try {
            const token = await this._getTenantAccessToken();
            const response = await axios.post(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
                msg_type: "image",
                content: JSON.stringify({ image_key: imageKey }),
            }, {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
                timeout: 60000,
            });
            return this._resultFromApi(response.data, "chat_id", "");
        } catch (error: any) {
            const raw = error.response?.data || {};
            return { ok: false, raw, error: raw.msg || raw.message || error.message || String(error) };
        }
    }



    private async _sendMessage(receiveIdType: "open_id" | "chat_id", receiveId: string, text: string): Promise<SendResult> {
        if (!String(receiveId || "").trim()) {
            return { ok: false, raw: {}, error: "receive_id is required", retryable: false };
        }
        if (this.dryRun) return { ok: true, raw: { dry_run: true, receiveIdType, receiveId, text }, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
            const resp = await axios.post(url, {
                receive_id: receiveId,
                msg_type: "text",
                content: JSON.stringify({ text }),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
            });
            return this._resultFromApi(resp.data, receiveIdType, receiveId);
        } catch (e: any) {
            if (axios.isAxiosError(e)) {
                if (!e.response || e.response.status >= 500) {
                    throw new Error(`Feishu API Error (Network/5xx): ${e.message}`);
                }
            }
            const raw = e.response?.data || {};
            const result: SendResult = { ok: false, raw, chat_id: receiveIdType === "chat_id" ? receiveId : undefined, error: raw.msg || raw.message || e.message || String(e) };
            result.retryable = !isPermanentFeishuSendFailure(result);
            return result;
        }
    }

    private async _sendImageKey(receiveIdType: "open_id" | "chat_id", receiveId: string, imageKey: string): Promise<SendResult> {
        if (!String(receiveId || "").trim()) {
            return { ok: false, raw: {}, error: "receive_id is required", retryable: false };
        }
        try {
            const token = await this._getTenantAccessToken();
            const response = await axios.post(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
                receive_id: receiveId,
                msg_type: "image",
                content: JSON.stringify({ image_key: imageKey }),
            }, {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
                timeout: 60000,
            });
            return this._resultFromApi(response.data, receiveIdType, receiveId);
        } catch (error: any) {
            const raw = error.response?.data || {};
            return { ok: false, raw, chat_id: receiveIdType === "chat_id" ? receiveId : undefined, error: raw.msg || raw.message || error.message || String(error) };
        }
    }

    private async _sendInteractive(receiveIdType: "open_id" | "chat_id", receiveId: string, text: string, title?: string): Promise<SendResult> {
        if (!String(receiveId || "").trim()) {
            return { ok: false, raw: {}, error: "receive_id is required", retryable: false };
        }
        if (this.dryRun) return { ok: true, raw: { dry_run: true, receiveIdType, receiveId, text }, chat_id: receiveIdType === "chat_id" ? receiveId : undefined };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
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
            const resp = await axios.post(url, {
                receive_id: receiveId,
                msg_type: "interactive",
                content: JSON.stringify(card),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
            });
            return this._resultFromApi(resp.data, receiveIdType, receiveId);
        } catch (e: any) {
            if (axios.isAxiosError(e)) {
                if (!e.response || e.response.status >= 500) {
                    throw new Error(`Feishu API Error (Network/5xx): ${e.message}`);
                }
            }
            const raw = e.response?.data || {};
            return { ok: false, raw, chat_id: receiveIdType === "chat_id" ? receiveId : undefined, error: raw.msg || raw.message || e.message || String(e) };
        }
    }

    private _resultFromApi(raw: any, receiveIdType: "open_id" | "chat_id", receiveId: string): SendResult {
        const { chatId, messageId } = this._extractResultFields(raw);
        if (raw?.code !== 0) {
            const result: SendResult = {
                ok: false,
                raw,
                chat_id: chatId || (receiveIdType === "chat_id" ? receiveId : undefined),
                message_id: messageId,
                error: raw?.msg || raw?.message || JSON.stringify(raw),
            };
            result.retryable = !isPermanentFeishuSendFailure(result);
            return result;
        }

        return {
            ok: true,
            raw,
            chat_id: chatId || (receiveIdType === "chat_id" ? receiveId : undefined),
            message_id: messageId,
        };
    }

    private async _sendReply(messageId: string, text: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, text }, chat_id: undefined };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
            const resp = await axios.post(url, {
                msg_type: "text",
                content: JSON.stringify({ text }),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
            });
            return this._resultFromApi(resp.data, "chat_id", "");
        } catch (e: any) {
            if (axios.isAxiosError(e)) {
                if (!e.response || e.response.status >= 500) {
                    throw new Error(`Feishu API Error (Network/5xx): ${e.message}`);
                }
            }
            const raw = e.response?.data || {};
            return { ok: false, raw, chat_id: undefined, error: raw.msg || raw.message || e.message || String(e) };
        }
    }

    private async _sendReplyInteractive(messageId: string, text: string, title?: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, text, title }, chat_id: undefined };
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

            const resp = await axios.post(url, {
                msg_type: "interactive",
                content: JSON.stringify(card),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
            });
            return this._resultFromApi(resp.data, "chat_id", "");
        } catch (e: any) {
            if (axios.isAxiosError(e)) {
                if (!e.response || e.response.status >= 500) {
                    throw new Error(`Feishu API Error (Network/5xx): ${e.message}`);
                }
            }
            const raw = e.response?.data || {};
            return { ok: false, raw, chat_id: undefined, error: raw.msg || raw.message || e.message || String(e) };
        }
    }

    async sendReplyFile(messageId: string, filePath: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, filePath }, chat_id: undefined };
        const resolvedPath = path.resolve(filePath);
        try {
            const token = await this._getTenantAccessToken();

            const fileData = fs.readFileSync(resolvedPath);
            const formData = new FormData();
            formData.append('file_type', 'stream');
            formData.append('file_name', path.basename(resolvedPath));
            formData.append('file', new Blob([fileData]));

            const uploadUrl = `https://open.feishu.cn/open-apis/im/v1/files`;
            const uploadResp = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    "Authorization": `Bearer ${token}`
                },
                body: formData
            });
            const uploadJson: any = await uploadResp.json();

            if (uploadJson.code !== 0) {
                return { ok: false, raw: uploadJson, error: uploadJson.msg };
            }

            const fileKey = uploadJson.data.file_key;

            const replyUrl = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`;
            const replyResp = await axios.post(replyUrl, {
                msg_type: "file",
                content: JSON.stringify({ file_key: fileKey }),
            }, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                timeout: 60000,
            });

            if (replyResp.data.code !== 0) {
                return { ok: false, raw: replyResp.data, error: replyResp.data.msg };
            }

            return { ok: true, raw: replyResp.data, message_id: replyResp.data.data.message_id };
        } catch (e: any) {
            if (axios.isAxiosError(e)) {
                if (!e.response || e.response.status >= 500) {
                    throw new Error(`Feishu API Error (Network/5xx): ${e.message}`);
                }
            }
            const raw = e.response?.data || {};
            return { ok: false, raw, error: raw.msg || raw.message || e.message || String(e) };
        }
    }

    async addReaction(messageId: string, emojiType: string = WORKING_REACTION_EMOJI_TYPE): Promise<string | null> {
        this.lastReactionError = null;
        if (this.dryRun || !messageId) return null;

        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`;
            const resp = await axios.post(url, { reaction_type: { emoji_type: emojiType } }, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 5000
            });
            if (resp.data.code === 0) {
                return resp.data.data?.reaction_id || null;
            }
            this.lastReactionError = `API returned: ${JSON.stringify(resp.data)}`;
        } catch (e) {
            this.lastReactionError = String(e);
        }
        return null;
    }

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
        if (this.dryRun || !messageId || !reactionId) return;
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
            await axios.delete(url, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 5000
            });
        } catch (e) {}
    }

    async getMessageImageKeys(messageId: string): Promise<string[]> {
        if (this.dryRun || !messageId) return [];
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`;
            const response = await axios.get(url, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 30000
            });
            if (response.data?.code !== 0) return [];
            return extractFeishuImageKeys(response.data?.data?.items || response.data?.data);
        } catch (e) {
            console.error(`[FeishuAdapter] getMessageImageKeys error:`, e);
            return [];
        }
    }

    async downloadResourceWithMetadata(messageId: string, fileKey: string, type: 'file' | 'image', destPath: string): Promise<DownloadResourceResult> {
        if (this.dryRun) return { ok: false, error: "dry_run" };
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
            const response = await axios.get(url, {
                headers: { "Authorization": `Bearer ${token}` },
                responseType: 'stream',
                timeout: 30000
            });
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
            console.error(`[FeishuAdapter] downloadResource error:`, e);
            return { ok: false, error: String(e) };
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
            const resp = await axios.get(`https://open.feishu.cn/open-apis/contact/v3/departments/${depId}?department_id_type=open_department_id`, {
                headers: { Authorization: `Bearer ${token}` }
            });
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
                    const resp = await axios.get(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}?department_id_type=open_department_id&user_id_type=open_id`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
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

        try {
            // 1. Fetch all departments recursively (assuming root is '0')
            let allDepartments: any[] = [];
            let hasMore = true;
            let pageToken = "";
            while (hasMore) {
                const url = `https://open.feishu.cn/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true${pageToken ? `&page_token=${pageToken}` : ''}`;
                const resp = await axios.get(url, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (resp.data.code === 0 && Array.isArray(resp.data.data?.items)) {
                    allDepartments.push(...resp.data.data.items);
                    console.log(`Fetched ${resp.data.data.items.length} departments. has_more: ${resp.data.data.has_more}`);
                    hasMore = resp.data.data.has_more;
                    pageToken = resp.data.data.page_token || "";
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
                while (depHasMore) {
                    const url = `https://open.feishu.cn/open-apis/contact/v3/users/find_by_department?department_id=${dep.open_department_id}&department_id_type=open_department_id&user_id_type=open_id${depPageToken ? `&page_token=${depPageToken}` : ''}`;
                    try {
                        const resp = await axios.get(url, {
                            headers: { Authorization: `Bearer ${token}` }
                        });
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
                            depHasMore = resp.data.data.has_more;
                            depPageToken = resp.data.data.page_token || "";
                        } else {
                            throw new Error(`Fetch users for department ${dep.open_department_id} failed: ${resp.data?.msg || JSON.stringify(resp.data)}`);
                        }
                    } catch (e: any) {
                        throw new Error(`Fetch users for department ${dep.open_department_id} failed: ${e?.message || String(e)}`);
                    }
                }
            }
        } catch (e: any) {
            throw new Error(`Feishu fetchAllCompanyMembers failed: ${e.message || String(e)}`);
        }

        return results;
    }

    async listGroups(): Promise<any[]> {
        if (this.dryRun) return [];
        const token = await this._getTenantAccessToken();
        const url = `https://open.feishu.cn/open-apis/im/v1/chats?page_size=100`;
        return this._getPagedItems(url, token, "Feishu list groups failed");
    }

    async fetchChatHistory(chatId: string, startTime: Date, endTime: Date): Promise<SourceMessage[]> {
        if (this.dryRun || !chatId) return [];

        const token = await this._getTenantAccessToken();
        const parser = new FeishuEventParser(this.config.bot_open_id || "", this.knownNames);
        const messages: SourceMessage[] = [];
        let pageToken = "";

        do {
            try {
                const response = await axios.get("https://open.feishu.cn/open-apis/im/v1/messages", {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        container_id_type: "chat",
                        container_id: chatId,
                        start_time: String(Math.floor(startTime.getTime() / 1000)),
                        end_time: String(Math.floor(endTime.getTime() / 1000)),
                        sort_type: "ByCreateTimeAsc",
                        page_size: 50,
                        ...(pageToken ? { page_token: pageToken } : {}),
                    },
                });
                if (response.data?.code !== 0) {
                    throw new Error(`Feishu fetch chat history failed: ${JSON.stringify(response.data)}`);
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

                pageToken = data.has_more ? String(data.page_token || "") : "";
            } catch (error: any) {
                if (axios.isAxiosError(error) && error.response?.data) {
                    throw new Error(`Feishu fetch chat history failed: ${JSON.stringify(error.response.data)}`);
                }
                throw error;
            }
        } while (pageToken);

        return messages;
    }

    async listGroupMembers(chatId: string): Promise<any[]> {
        if (this.dryRun || !chatId) return [];
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
                try {
                    const response = await axios.get(
                        `https://open.feishu.cn/open-apis/contact/v3/users/${member.open_id}?user_id_type=open_id`,
                        { headers: { Authorization: `Bearer ${token}` } },
                    );
                    if (response.data?.code === 0) {
                        member.job_title = response.data?.data?.user?.job_title || undefined;
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
        let pageToken = "";

        do {
            const pageUrl = pageToken ? `${url}&page_token=${encodeURIComponent(pageToken)}` : url;
            try {
                const resp = await axios.get(pageUrl, {
                    headers: { "Authorization": `Bearer ${token}` }
                });
                if (resp.data?.code !== 0) {
                    throw new Error(`${errorPrefix}: ${JSON.stringify(resp.data)}`);
                }

                const data = resp.data?.data || {};
                items.push(...(Array.isArray(data.items) ? data.items : []));
                pageToken = data.has_more ? String(data.page_token || "") : "";
            } catch (e: any) {
                if (axios.isAxiosError(e) && e.response?.data) {
                    throw new Error(`${errorPrefix}: ${JSON.stringify(e.response.data)}`);
                }
                throw e;
            }
        } while (pageToken);

        return items;
    }
}
