import { test, expect, describe } from "bun:test";
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { LLMAdapter } from '@/adapters/llm';
import { TapdAdapter } from '@/adapters/tapd';
import { FeishuAdapter, FeishuEventParser, extractFeishuImageKeys } from '@/adapters/feishu';
import { AIConfig, TapdConfig, FeishuConfig } from '@/core/config';
import { TAPD_STATUS_REQUIREMENT } from '@/services/messageHandler/types';

describe("Adapters Loading", () => {
    test("should instantiate adapters successfully", () => {
        const aiConfig: AIConfig = { provider: "openai", api_base: "", api_key: "", model: "", max_tokens: 100, temperature: 0.1, retry_count: 1, request_timeout_ms: 15000, use_proxy: false, proxy_url: "" };
        const llm = new LLMAdapter(aiConfig, true);
        expect(llm).toBeDefined();

        const tapdConfig: TapdConfig = { workspace_id: 1, api_token: "", api_base: "", workitem_type_id: "" };
        const tapd = new TapdAdapter(tapdConfig, true);
        expect(tapd).toBeDefined();

        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, true);
        expect(feishu).toBeDefined();

        const parser = new FeishuEventParser("bot123");
        expect(parser).toBeDefined();
    });

    test("should audit Feishu delivery metadata without message content", async () => {
        const feishu = new FeishuAdapter({
            app_id: "",
            app_secret: "",
            bot_open_id: "",
            bot_name: "",
            send_retry_count: 1,
        }, true);
        const audits: Array<{ action: string; payload: Record<string, unknown> }> = [];
        feishu.setAuditCallback((action, payload) => audits.push({ action, payload }));

        await feishu.sendPrivateMarkdown("ou_user", "不应进入日志的新闻正文", "AI 热点新闻");

        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
            action: "bot_message_sent",
            payload: { channel: "private_markdown", target: "ou_user", ok: true },
        });
        expect(audits[0].payload).not.toHaveProperty("text");
        expect(audits[0].payload).not.toHaveProperty("text_preview");
        expect(JSON.stringify(audits[0])).not.toContain("不应进入日志");
    });

    test("should normalize Feishu millisecond timestamps into ISO message time", () => {
        const parser = new FeishuEventParser("bot123", { ou_user: "测试用户" });
        const createdAt = new Date("2026-07-17T01:30:20Z");
        const message = parser.parse({
            event: {
                sender: { sender_id: { open_id: "ou_user" } },
                message: {
                    message_id: "om_timestamp",
                    chat_id: "oc_test",
                    chat_type: "p2p",
                    message_type: "text",
                    content: JSON.stringify({ text: "【昨日完成】\n1. 完成测试" }),
                    create_time: String(createdAt.getTime()),
                },
            },
        });

        expect(message?.sent_at).toBe(createdAt.toISOString());
        expect(message?.sender_name).toBe("测试用户");
    });

    test("should build TAPD story title and description update payloads", async () => {
        const tapdConfig: TapdConfig = { workspace_id: 1, api_token: "", api_base: "", workitem_type_id: "" };
        const tapd = new TapdAdapter(tapdConfig, true);

        const titleResult = await tapd.updateStoryTitle("story-1", "新标题");
        expect(titleResult.raw.payload).toMatchObject({
            workspace_id: 1,
            id: "story-1",
            entity_type: "stories",
            name: "新标题",
        });

        const descriptionResult = await tapd.updateStoryDescription("story-1", "新的详细信息");
        expect(descriptionResult.raw.payload).toMatchObject({
            workspace_id: 1,
            id: "story-1",
            entity_type: "stories",
            description: "新的详细信息",
        });
    });

    test("should build TAPD story comment payloads", async () => {
        const tapdConfig: TapdConfig = { workspace_id: 1, api_token: "", api_base: "", workitem_type_id: "" };
        const tapd = new TapdAdapter(tapdConfig, true);

        const commentResult = await tapd.addStoryComment("story-1", "打回原因：前端和原型图相差较大");

        expect(commentResult.raw.payload).toMatchObject({
            workspace_id: 1,
            entry_type: "stories",
            entry_id: "story-1",
            description: "打回原因：前端和原型图相差较大",
        });
    });

    test("should create TAPD stories in requirement status", async () => {
        const tapdConfig: TapdConfig = { workspace_id: 1, api_token: "", api_base: "", workitem_type_id: "story" };
        const tapd = new TapdAdapter(tapdConfig, true);

        const result = await tapd.createStory("新需求", "张三", "Middle", null, "描述", null, "李四");

        expect(result.raw.payload).toMatchObject({
            workspace_id: 1,
            name: "新需求",
            entity_type: "stories",
            workitem_type_id: "story",
            status: TAPD_STATUS_REQUIREMENT,
            owner: "张三",
            creator: "李四",
            priority_label: "Middle",
            description: "描述",
        });
    });

    test("should request TAPD work item types for the configured workspace", async () => {
        const tapd = new TapdAdapter({
            workspace_id: 12345678,
            api_token: "token",
            api_base: "https://api.tapd.test",
            workitem_type_id: "story",
        }, false);
        const originalGet = axios.get;
        (axios.get as any) = async (url: string, options: any) => {
            expect(url).toBe("https://api.tapd.test/workitem_types?workspace_id=12345678&page=2&limit=50");
            expect(options.headers.Authorization).toBe("Bearer token");
            return { data: { status: 1, data: [{ WorkitemType: { id: "type-1", name: "STORY" } }] } };
        };

        try {
            const result = await tapd.listWorkitemTypes(2, 50);
            expect(result).toMatchObject({ ok: true, raw: { status: 1 } });
        } finally {
            axios.get = originalGet;
        }
    });

    test("should upload a TAPD native story attachment as multipart form data", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-adapter-test-"));
        const filePath = path.join(tempDir, "source.png");
        await Bun.write(filePath, new Uint8Array([137, 80, 78, 71]));
        const tapd = new TapdAdapter({
            workspace_id: 1,
            api_token: "token",
            api_base: "https://api.tapd.test",
            workitem_type_id: "story",
        }, false);
        const originalFetch = globalThis.fetch;

        (globalThis.fetch as any) = async (url: string, options: RequestInit) => {
            const body = options.body as FormData;
            expect(url).toBe("https://api.tapd.test/files/upload_attachment");
            expect(new Headers(options.headers).get("Authorization")).toBe("Bearer token");
            expect(body.get("workspace_id")).toBe("1");
            expect(body.get("type")).toBe("story");
            expect(body.get("custom_field")).toBeNull();
            expect(body.get("entry_id")).toBe("story-1");
            expect((body.get("file") as File).name).toBe("需求截图.png");
            return new Response(JSON.stringify({ status: 1, data: { Attachment: { id: "attachment-1" } }, info: "success" }), { status: 200 });
        };

        try {
            const result = await tapd.uploadAttachment("story-1", filePath, "需求截图.png", "创建人", "image/png");
            expect(result).toMatchObject({ ok: true, story_id: "story-1", attachment_id: "attachment-1" });
        } finally {
            globalThis.fetch = originalFetch;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test("should upload into the configured TAPD story custom field when provided", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-adapter-test-"));
        const filePath = path.join(tempDir, "source.png");
        await Bun.write(filePath, new Uint8Array([137, 80, 78, 71]));
        const tapd = new TapdAdapter({
            workspace_id: 1,
            api_token: "token",
            api_base: "https://api.tapd.test",
            workitem_type_id: "story",
            attachment_custom_field: "custom_field_five",
        }, false);
        const originalFetch = globalThis.fetch;

        (globalThis.fetch as any) = async (_url: string, options: RequestInit) => {
            const body = options.body as FormData;
            expect(body.get("type")).toBe("story_custom_field");
            expect(body.get("custom_field")).toBe("custom_field_five");
            return new Response(JSON.stringify({ status: 1, data: { Attachment: { id: "attachment-2" } }, info: "success" }), { status: 200 });
        };

        try {
            const result = await tapd.uploadAttachment("story-1", filePath, "需求截图.png");
            expect(result).toMatchObject({ ok: true, attachment_id: "attachment-2" });
        } finally {
            globalThis.fetch = originalFetch;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test("should call OpenAI-compatible chat completions with diagnostics", async () => {
        const aiConfig: AIConfig = {
            provider: "openai",
            api_base: "https://api.openai.example/v1",
            api_key: "test-key",
            model: "gpt-test",
            max_tokens: 16,
            temperature: 0,
            retry_count: 0,
            request_timeout_ms: 5000,
            use_proxy: false,
            proxy_url: "",
        };
        const llm = new LLMAdapter(aiConfig, false);
        const originalFetch = globalThis.fetch;

        (globalThis.fetch as any) = async (url: string, init: RequestInit) => {
            expect(url).toBe("https://api.openai.example/v1/responses");
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
            const body = JSON.parse(init.body as string);
            expect(body.model).toBe("gpt-test");
            return new Response(JSON.stringify({
                id: "resp_test",
                created_at: 1,
                model: "gpt-test",
                output: [{
                    type: "message",
                    id: "msg_test",
                    role: "assistant",
                    content: [{ type: "output_text", text: "OK", annotations: [] }],
                }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };

        try {
            const result = await llm.chat("system", "user");
            expect(result.ok).toBe(true);
            expect(result.content).toBe("OK");
            expect(llm.diagnostics()).toMatchObject({
                hasApiKey: true,
                apiBase: "https://api.openai.example/v1",
                requestUrl: "https://api.openai.example/v1/responses",
                model: "gpt-test",
                timeoutMs: 5000,
                retryAttempts: 1,
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("should route Gemini configuration through SDK diagnostics", () => {
        const aiConfig: AIConfig = {
            provider: "gemini",
            api_base: "https://generativelanguage.googleapis.com/v1beta/openai",
            api_key: "test-key",
            model: "gemini-3-flash-preview",
            max_tokens: 16,
            temperature: 0,
            retry_count: 0,
            request_timeout_ms: 5000,
            use_proxy: false,
            proxy_url: "",
        };
        const llm = new LLMAdapter(aiConfig, false);

        expect(llm.diagnostics()).toMatchObject({
            hasApiKey: true,
            apiBase: "(default)",
            requestUrl: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
            model: "gemini-3-flash-preview",
            timeoutMs: 5000,
            retryAttempts: 1,
        });
    });


    test("should throw error when AI request hangs", async () => {
        const aiConfig: AIConfig = {
            provider: "openai",
            api_base: "https://api.openai.com/v1",
            api_key: "test-key",
            model: "gpt-test",
            max_tokens: 16,
            temperature: 0,
            retry_count: 0,
            request_timeout_ms: 1,
            use_proxy: false,
            proxy_url: "",
        };
        const llm = new LLMAdapter(aiConfig, false);
        const originalFetch = globalThis.fetch;

        (globalThis.fetch as any) = async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            });
        });

        try {
            await expect(llm.chat("system", "user")).rejects.toThrow("LLM API Error (OpenAI/Compatible): AI request timed out after");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("should fail health check when AI key is missing", async () => {
        const aiConfig: AIConfig = {
            provider: "openai",
            api_base: "https://api.openai.com/v1",
            api_key: "",
            model: "gpt-test",
            max_tokens: 16,
            temperature: 0,
            retry_count: 0,
            request_timeout_ms: 5000,
            use_proxy: false,
            proxy_url: "",
        };
        const llm = new LLMAdapter(aiConfig, false);

        const result = await llm.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toBe("AI_API_KEY is not configured");
        expect(result.diagnostics.hasApiKey).toBe(false);
    });

    test("should keep mention metadata even when Feishu omits open_id", () => {
        const parser = new FeishuEventParser("ou_bot");
        const message = parser.parse({
            event: {
                sender: { sender_id: { open_id: "ou_user" } },
                message: {
                    message_id: "om_mention",
                    chat_id: "oc_group",
                    chat_type: "group",
                    message_type: "text",
                    content: JSON.stringify({ text: "@_user_1 你好" }),
                    mentions: [{ key: "@_user_1", name: "AI 交付助理" }],
                },
            },
        });

        expect(message?.mentions).toEqual([{ open_id: "", name: "AI 交付助理", key: "@_user_1" }]);
        expect(message?.text).toBe("@AI 交付助理 你好");
    });

    test("should extract every image key from a Feishu rich-text post", () => {
        const content = JSON.stringify({
            title: "需求截图",
            content: [[
                { tag: "img", image_key: "img_first" },
                { tag: "text", text: "请按图创建任务" },
                { tag: "img", image_key: "img_second" },
            ]],
        });
        const parser = new FeishuEventParser("ou_bot");
        const message = parser.parse({
            event: {
                sender: { sender_id: { open_id: "ou_user" } },
                message: {
                    message_id: "om_post",
                    chat_id: "oc_group",
                    chat_type: "group",
                    message_type: "post",
                    content,
                },
            },
        });

        expect(extractFeishuImageKeys(content)).toEqual(["img_first", "img_second"]);
        expect(message?.image_key).toBe("img_first");
        expect(message?.text).toBe("需求截图\n请按图创建任务");
    });

    test("should page through group history and exclude bot messages", async () => {
        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "ou_bot", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, false, { ou_user: "测试用户" });
        (feishu as any)._getTenantAccessToken = async () => "tenant-token";

        const originalGet = axios.get;
        const requests: any[] = [];
        (axios.get as any) = async (url: string, options: any) => {
            requests.push({ url, params: options.params });
            if (!options.params.page_token) {
                return {
                    data: {
                        code: 0,
                        data: {
                            items: [
                                {
                                    message_id: "om_user",
                                    chat_id: "oc_group",
                                    msg_type: "text",
                                    create_time: "1784192400000",
                                    sender: { id: "ou_user", sender_type: "user" },
                                    body: { content: JSON.stringify({ text: "现有人力无法覆盖全部需求，需要确认优先级" }) },
                                    mentions: [{ key: "@_user_1", id: "ou_owner", name: "Figo" }],
                                },
                                {
                                    message_id: "om_bot",
                                    chat_id: "oc_group",
                                    msg_type: "interactive",
                                    create_time: "1784192460000",
                                    sender: { id: "cli_bot", sender_type: "app" },
                                    body: { content: "机器人日报" },
                                },
                                {
                                    message_id: "om_system",
                                    chat_id: "oc_group",
                                    msg_type: "system",
                                    create_time: "1784192480000",
                                    sender: { id: "ou_user", sender_type: "user" },
                                    body: { content: JSON.stringify({
                                        template: "{from_user} invited {to_chatters} to the group.",
                                        from_user: ["测试用户"],
                                        to_chatters: ["测试机器人1"],
                                        divider_text: {},
                                    }) },
                                },
                            ],
                            has_more: true,
                            page_token: "next-page",
                        },
                    },
                };
            }
            return {
                data: {
                    code: 0,
                    data: {
                        items: [{
                            message_id: "om_image",
                            chat_id: "oc_group",
                            msg_type: "image",
                            create_time: "1784192520000",
                            sender: { id: "ou_user", sender_type: "user" },
                            body: { content: JSON.stringify({ image_key: "img_1" }) },
                        }],
                        has_more: false,
                    },
                },
            };
        };

        try {
            const messages = await feishu.fetchChatHistory(
                "oc_group",
                new Date("2026-07-16T00:00:00+08:00"),
                new Date("2026-07-16T23:59:59+08:00"),
            );

            expect(requests).toHaveLength(2);
            expect(requests[0]).toMatchObject({
                url: "https://open.feishu.cn/open-apis/im/v1/messages",
                params: { container_id_type: "chat", container_id: "oc_group", sort_type: "ByCreateTimeAsc", page_size: 50 },
            });
            expect(requests[1].params.page_token).toBe("next-page");
            expect(messages.map(item => item.id)).toEqual(["om_user", "om_image"]);
            expect(messages[0]).toMatchObject({
                sender_name: "测试用户",
                text: "现有人力无法覆盖全部需求，需要确认优先级",
                mentions: [{ open_id: "ou_owner", name: "Figo", key: "@_user_1" }],
            });
            expect(messages[1]).toMatchObject({ text: "[图片消息]", image_key: "img_1" });
        } finally {
            axios.get = originalGet;
        }
    });


    test("should request group members as open_id and enrich their job titles", async () => {
        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, false);
        (feishu as any)._getTenantAccessToken = async () => "tenant-token";

        const originalGet = axios.get;
        const urls: string[] = [];
        (axios.get as any) = async (url: string) => {
            urls.push(url);
            if (url.includes("/contact/v3/users/")) {
                const openId = url.includes("ou_123") ? "ou_123" : "ou_456";
                return { data: { code: 0, data: { user: { job_title: openId === "ou_123" ? "前端工程师" : "产品经理" } } } };
            }
            expect(url).toContain("member_id_type=open_id");
            if (!url.includes("page_token=next_page")) {
                return {
                    data: {
                        code: 0,
                        data: {
                            items: [{ member_id: "ou_123", name: "张三" }],
                            has_more: true,
                            page_token: "next_page",
                        },
                    },
                };
            }

            return {
                data: {
                    code: 0,
                    data: {
                        items: [{ open_id: "ou_456", user_name: "李四" }],
                        has_more: false,
                    },
                },
            };
        };

        try {
            const members = await feishu.listGroupMembers("oc_123");
            expect(urls).toHaveLength(4);
            expect(urls[1]).toContain("page_token=next_page");
            expect(members).toEqual([
                { member_id: "ou_123", name: "张三", open_id: "ou_123", job_title: "前端工程师" },
                { open_id: "ou_456", user_name: "李四", name: "李四", job_title: "产品经理" },
            ]);
        } finally {
            axios.get = originalGet;
        }
    });

    test("should send private text through Feishu message API with open_id", async () => {
        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, false);
        (feishu as any)._getTenantAccessToken = async () => "tenant-token";

        const originalPost = axios.post;
        (axios.post as any) = async (url: string, body: any) => {
            expect(url).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");
            expect(body.receive_id).toBe("ou_123");
            expect(body.msg_type).toBe("text");
            expect(JSON.parse(body.content)).toEqual({ text: "你好" });
            return { data: { code: 0, data: { message_id: "om_123", chat_id: "oc_p2p" } } };
        };

        try {
            const result = await feishu.sendPrivateText("ou_123", "你好");
            expect(result.ok).toBe(true);
            expect(result.message_id).toBe("om_123");
            expect(result.chat_id).toBe("oc_p2p");
        } finally {
            axios.post = originalPost;
        }
    });

    test("should cache tenant token and coalesce concurrent refreshes", async () => {
        const feishuConfig: FeishuConfig = { app_id: "app-id", app_secret: "app-secret", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, false);
        const originalPost = axios.post;
        let tokenRequests = 0;
        let messageRequests = 0;
        (axios.post as any) = async (url: string) => {
            if (url.endsWith("/tenant_access_token/internal")) {
                tokenRequests++;
                await Promise.resolve();
                return { data: { code: 0, tenant_access_token: "tenant-token", expire: 7200 } };
            }
            messageRequests++;
            return { data: { code: 0, data: { message_id: `om_${messageRequests}`, chat_id: "oc_p2p" } } };
        };

        try {
            const results = await Promise.all([
                feishu.sendPrivateText("ou_1", "消息一"),
                feishu.sendPrivateText("ou_2", "消息二"),
            ]);
            const third = await feishu.sendPrivateText("ou_3", "消息三");

            expect(results.every(result => result.ok)).toBe(true);
            expect(third.ok).toBe(true);
            expect(tokenRequests).toBe(1);
            expect(messageRequests).toBe(3);
        } finally {
            axios.post = originalPost;
        }
    });

    test("should treat Feishu message API business errors as failed sends", async () => {
        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, false);
        (feishu as any)._getTenantAccessToken = async () => "tenant-token";

        const originalPost = axios.post;
        (axios.post as any) = async () => ({ data: { code: 230001, msg: "receiver not in scope" } });

        try {
            const result = await feishu.sendPrivateText("ou_123", "你好");
            expect(result.ok).toBe(false);
            expect(result.error).toBe("receiver not in scope");
            expect(result.retryable).toBe(false);
        } finally {
            axios.post = originalPost;
        }
    });

    test("should reject an empty Feishu recipient before requesting a token", async () => {
        const feishu = new FeishuAdapter({ app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 }, false);
        const originalPost = axios.post;
        let requests = 0;
        (axios.post as any) = async () => { requests++; return { data: { code: 0 } }; };

        try {
            expect(await feishu.sendPrivateText("", "你好")).toMatchObject({
                ok: false,
                error: "receive_id is required",
                retryable: false,
            });
            expect(await feishu.sendGroupMarkdown("你好", "")).toMatchObject({
                ok: false,
                error: "receive_id is required",
                retryable: false,
            });
            expect(requests).toBe(0);
        } finally {
            axios.post = originalPost;
        }
    });

    test("should reply through Feishu reply API", async () => {
        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, false);
        (feishu as any)._getTenantAccessToken = async () => "tenant-token";

        const originalPost = axios.post;
        (axios.post as any) = async (url: string, body: any) => {
            expect(url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om_incoming/reply");
            expect(JSON.parse(body.content)).toEqual({ text: "收到" });
            return { data: { code: 0, data: { message_id: "om_reply" } } };
        };

        try {
            const result = await feishu.sendReplyText("om_incoming", "收到");
            expect(result.ok).toBe(true);
            expect(result.message_id).toBe("om_reply");
        } finally {
            axios.post = originalPost;
        }
    });

    test("should upload a dashboard image once and reuse its image key", async () => {
        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, true);

        const uploaded = await feishu.uploadImage("/tmp/dashboard.png");
        const groupResult = await feishu.sendGroupImageKey(uploaded.image_key!, "oc_group");
        const replyResult = await feishu.sendReplyImageKey(uploaded.image_key!, "om_request");

        expect(uploaded).toMatchObject({ ok: true, image_key: "dry-run-image-key" });
        expect(groupResult).toMatchObject({ ok: true, chat_id: "oc_group" });
        expect(replyResult.ok).toBe(true);
    });
});
