import axios from 'axios';
import { TapdConfig } from '@/core/config';

export interface TapdResult {
    ok: boolean;
    raw: any;
    story_id?: string;
    attachment_id?: string;
    url?: string;
    error?: string;
}

export class TapdAdapter {
    private config: TapdConfig;
    private dryRun: boolean;

    constructor(config: TapdConfig, dryRun: boolean = false) {
        this.config = config;
        this.dryRun = dryRun;
    }

    async createStory(
        title: string,
        owner: string,
        priority_label: string,
        due_date: string | null,
        description: string,
        parent_id?: string | null,
        creator?: string | null
    ): Promise<TapdResult> {
        const payload: any = {
            workspace_id: this.config.workspace_id,
            name: title,
            entity_type: "stories",
            workitem_type_id: this.config.workitem_type_id,
            status: "status_2",
            owner,
            priority_label,
            description,
        };
        if (due_date) payload.due = due_date;
        if (parent_id) payload.parent_id = parent_id;
        if (creator) payload.creator = creator;

        if (this.dryRun) {
            const fakeId = `dry-${Math.floor(Math.random() * 1000000000)}`;
            return {
                ok: true,
                raw: { dry_run: true, payload, data: { Story: { id: fakeId } } },
                story_id: fakeId,
                url: this.storyUrl(fakeId)
            };
        }

        const result = await this._post("/stories?s=mcp", payload);
        const storyId = this._extractStoryId(result.raw);
        if (result.ok && storyId) {
            result.story_id = storyId;
            result.url = this.storyUrl(storyId);
        }
        return result;
    }

    async updateStoryStatus(storyId: string, status: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            status
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryDueDate(storyId: string, dueDate: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            due: dueDate
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryTitle(storyId: string, title: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            name: title
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryDescription(storyId: string, description: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            description
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryPriority(storyId: string, priorityLabel: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            priority_label: priorityLabel
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryOwner(storyId: string, owner: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            owner
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async addStoryComment(storyId: string, description: string, author?: string): Promise<TapdResult> {
        const payload: any = {
            workspace_id: this.config.workspace_id,
            entry_type: "stories",
            entry_id: storyId,
            description
        };
        if (author) payload.author = author;
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/comments?s=mcp", payload);
    }

    async uploadAttachment(
        storyId: string,
        filePath: string,
        fileName: string,
        owner?: string,
        contentType?: string
    ): Promise<TapdResult> {
        const customField = this.config.attachment_custom_field?.trim();

        const source = Bun.file(filePath);
        if (source.size >= 150 * 1024 * 1024) {
            return { ok: false, raw: {}, error: "TAPD attachment exceeds the 150MB limit" };
        }
        const payload = new FormData();
        payload.append("workspace_id", String(this.config.workspace_id));
        payload.append("type", customField ? "story_custom_field" : "story");
        if (customField) payload.append("custom_field", customField);
        payload.append("entry_id", storyId);
        if (owner) payload.append("owner", owner);
        payload.append("file", new File([source], fileName, { type: contentType || source.type }));

        if (this.dryRun) {
            return {
                ok: true,
                raw: {
                    dry_run: true,
                    story_id: storyId,
                    file_name: fileName,
                    type: customField ? "story_custom_field" : "story",
                    custom_field: customField,
                },
                story_id: storyId,
                attachment_id: "dry-run-attachment",
                url: this.storyUrl(storyId),
            };
        }

        const url = `${this.config.api_base.replace(/\/$/, '')}/files/upload_attachment`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.config.api_token}`,
                    "Via": "mcp",
                },
                body: payload,
                signal: controller.signal,
            });
            const body: any = await response.json();
            const ok = response.ok && (body?.status === 1 || body?.status === "1");
            const attachment = body?.data?.Attachment;
            return {
                ok,
                raw: body,
                story_id: storyId,
                attachment_id: attachment?.id ? String(attachment.id) : undefined,
                url: this.storyUrl(storyId),
                error: ok ? undefined : (body?.info || `HTTP ${response.status}: TAPD attachment upload failed`),
            };
        } catch (error: any) {
            const timedOut = error?.name === "AbortError";
            return {
                ok: false,
                raw: {},
                error: timedOut
                    ? "TAPD attachment upload timed out after 60000ms"
                    : `TAPD attachment upload network error: ${error?.message || String(error)}`,
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    storyUrl(storyId: string): string {
        return `https://www.tapd.cn/${this.config.workspace_id}/prong/stories/view/${storyId}`;
    }

    async getStory(storyId: string): Promise<TapdResult> {
        if (this.dryRun) return { ok: true, raw: {} };
        return this._get(`/stories?workspace_id=${this.config.workspace_id}&id=${storyId}`);
    }

    async listStories(page: number = 1, limit: number = 200): Promise<TapdResult> {
        if (this.dryRun) return { ok: true, raw: { status: 1, data: [] } };
        const query = new URLSearchParams({
            workspace_id: String(this.config.workspace_id),
            page: String(page),
            limit: String(limit),
        });
        return this._get(`/stories?${query.toString()}`);
    }

    async listStoryStatusChanges(created: string, page: number = 1, limit: number = 100): Promise<TapdResult> {
        if (this.dryRun) return { ok: true, raw: { status: 1, data: [] } };
        const query = new URLSearchParams({
            workspace_id: String(this.config.workspace_id),
            created,
            change_field: "status",
            need_parse_changes: "1",
            order: "created ASC",
            page: String(page),
            limit: String(Math.max(1, Math.min(100, limit))),
        });
        return this._get(`/story_changes?${query.toString()}`);
    }

    async listWorkitemTypes(page: number = 1, limit: number = 200): Promise<TapdResult> {
        if (this.dryRun) return { ok: true, raw: { status: 1, data: [] } };
        const query = new URLSearchParams({
            workspace_id: String(this.config.workspace_id),
            page: String(page),
            limit: String(limit),
        });
        return this._get(`/workitem_types?${query.toString()}`);
    }

    private async _get(path: string): Promise<TapdResult> {
        const url = `${this.config.api_base.replace(/\/$/, '')}${path}`;
        try {
            const resp = await axios.get(url, {
                headers: {
                    "Authorization": `Bearer ${this.config.api_token}`,
                    "Content-Type": "application/json",
                    "Via": "mcp"
                },
                timeout: 60000
            });
            return { ok: true, raw: resp.data };
        } catch (error: any) {
            if (axios.isAxiosError(error)) {
                if (!error.response || error.response.status >= 500) {
                    throw new Error(`TAPD API Error (Network/5xx): ${error.message}`);
                }
                const body = error.response.data;
                return { ok: false, raw: { body }, error: `HTTP ${error.response.status}: ${JSON.stringify(body)}` };
            }
            throw error;
        }
    }

    private async _post(path: string, payload: any): Promise<TapdResult> {
        const url = `${this.config.api_base.replace(/\/$/, '')}${path}`;
        try {
            const resp = await axios.post(url, payload, {
                headers: {
                    "Authorization": `Bearer ${this.config.api_token}`,
                    "Content-Type": "application/json",
                    "Via": "mcp"
                },
                timeout: 60000
            });
            return { ok: true, raw: resp.data };
        } catch (error: any) {
            if (axios.isAxiosError(error)) {
                if (!error.response || error.response.status >= 500) {
                    throw new Error(`TAPD API Error (Network/5xx): ${error.message}`);
                }
                const body = error.response.data;
                return { ok: false, raw: { body }, error: `HTTP ${error.response.status}: ${JSON.stringify(body)}` };
            }
            throw error;
        }
    }

    private _extractStoryId(raw: any): string | undefined {
        const data = raw?.data;
        if (typeof data === 'object' && data !== null) {
            const story = data.Story || data.story || data;
            if (typeof story === 'object' && story !== null && story.id) {
                return String(story.id);
            }
        }
        return undefined;
    }
}
