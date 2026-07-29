import { describe, expect, test } from "bun:test";
import { buildConfig } from "@/core/config";

describe("config", () => {
    test("should use public-safe defaults for project integrations", () => {
        const envNames = [
            "PROJECT_NAME",
            "FEISHU_BOT_NAME",
            "TAPD_WORKSPACE_ID",
            "TAPD_WORKITEM_TYPE_ID",
            "AI_MODEL",
        ] as const;
        const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

        try {
            for (const name of envNames) delete process.env[name];
            const config = buildConfig({});

            expect(config.project.name).toBe("Demo Project");
            expect(config.feishu.bot_name).toBe("AI 交付助理");
            expect(config.tapd.workspace_id).toBe(0);
            expect(config.tapd.workitem_type_id).toBe("");
            expect(config.ai.model).toBe("");
        } finally {
            for (const name of envNames) {
                const value = previous[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    test("should let Feishu bot env override file config", () => {
        const previousBotOpenId = process.env.FEISHU_BOT_OPEN_ID;
        const previousBotName = process.env.FEISHU_BOT_NAME;

        try {
            process.env.FEISHU_BOT_OPEN_ID = "ou_env_bot";
            process.env.FEISHU_BOT_NAME = "Env Bot";

            const config = buildConfig({
                feishu: {
                    bot_open_id: "ou_file_bot",
                    bot_name: "File Bot",
                },
            });

            expect(config.feishu.bot_open_id).toBe("ou_env_bot");
            expect(config.feishu.bot_name).toBe("Env Bot");
        } finally {
            if (previousBotOpenId === undefined) delete process.env.FEISHU_BOT_OPEN_ID;
            else process.env.FEISHU_BOT_OPEN_ID = previousBotOpenId;

            if (previousBotName === undefined) delete process.env.FEISHU_BOT_NAME;
            else process.env.FEISHU_BOT_NAME = previousBotName;
        }
    });

    test("should not fall back to file bot id when env is intentionally empty", () => {
        const previousBotOpenId = process.env.FEISHU_BOT_OPEN_ID;

        try {
            process.env.FEISHU_BOT_OPEN_ID = "";

            const config = buildConfig({
                feishu: {
                    bot_open_id: "ou_file_bot",
                },
            });

            expect(config.feishu.bot_open_id).toBe("");
        } finally {
            if (previousBotOpenId === undefined) delete process.env.FEISHU_BOT_OPEN_ID;
            else process.env.FEISHU_BOT_OPEN_ID = previousBotOpenId;
        }
    });

    test("should configure the TAPD attachment custom field from environment", () => {
        const previous = process.env.TAPD_ATTACHMENT_CUSTOM_FIELD;
        try {
            process.env.TAPD_ATTACHMENT_CUSTOM_FIELD = "custom_field_five";
            const config = buildConfig({ tapd: {} });
            expect(config.tapd.attachment_custom_field).toBe("custom_field_five");
        } finally {
            if (previous === undefined) delete process.env.TAPD_ATTACHMENT_CUSTOM_FIELD;
            else process.env.TAPD_ATTACHMENT_CUSTOM_FIELD = previous;
        }
    });

    test("should preserve enabled legacy daily summaries when the later-added module switch is off", () => {
        const config = buildConfig({
            groups: [{
                chat_id: "oc_dev",
                name: "Demo 研发组",
                members: [],
                schedule: {
                    daily_summary: "18:30",
                    daily_summary_enabled: true,
                    module_daily_summary_enabled: false,
                },
            }],
        });

        expect(config.groups[0].schedule.module_daily_summary_enabled).toBe(true);
        expect(config.groups[0].schedule.daily_summary_enabled).toBe(true);
    });

    test("should normalize the overdue scan working window", () => {
        const defaults = buildConfig({ groups: [{ chat_id: "oc_default", schedule: {} }] });
        expect(defaults.groups[0].schedule).toMatchObject({
            overdue_scan: "09:00",
            overdue_scan_end: "18:30",
            overdue_scan_interval_minutes: 30,
            overdue_scan_timezone: "Asia/Shanghai",
        });

        const invalid = buildConfig({
            groups: [{ chat_id: "oc_invalid", schedule: {
                overdue_scan: "20:00",
                overdue_scan_end: "08:00",
                overdue_scan_interval_minutes: 0,
                overdue_scan_timezone: "Mars/Olympus",
            } }],
        });
        expect(invalid.groups[0].schedule).toMatchObject({
            overdue_scan: "09:00",
            overdue_scan_end: "18:30",
            overdue_scan_interval_minutes: 30,
            overdue_scan_timezone: "Asia/Shanghai",
        });
    });

    test("should normalize weekly report scheduling and preserve an enabled legacy task", () => {
        const config = buildConfig({
            groups: [{
                chat_id: "oc_weekly",
                schedule: {
                    weekly_report: "25:90",
                    weekly_report_timezone: "Mars/Olympus",
                    weekly_report_enabled: true,
                    module_weekly_report_enabled: false,
                },
            }],
        });

        expect(config.groups[0].schedule).toMatchObject({
            weekly_report: "18:50",
            weekly_report_timezone: "Asia/Shanghai",
            weekly_report_enabled: true,
            module_weekly_report_enabled: true,
        });
    });

    test("should validate maintenance cleanup settings and use safe defaults", () => {
        const envNames = [
            "MAINTENANCE_ENABLED",
            "AUDIT_LOG_RETENTION_DAYS",
            "MAINTENANCE_CLEANUP_TIME",
            "MAINTENANCE_CLEANUP_TIMEZONE",
            "MAINTENANCE_CLEANUP_BATCH_SIZE",
            "MAINTENANCE_CLEANUP_MAX_BATCHES",
        ] as const;
        const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

        try {
            for (const name of envNames) delete process.env[name];

            expect(buildConfig({}).maintenance).toEqual({
                enabled: true,
                audit_log_retention_days: 90,
                cleanup_time: "03:30",
                cleanup_timezone: "Asia/Shanghai",
                cleanup_batch_size: 500,
                cleanup_max_batches: 20,
            });

            expect(buildConfig({
                maintenance: {
                    audit_log_retention_days: 0,
                    cleanup_time: "25:00",
                    cleanup_timezone: "Mars/Olympus",
                    cleanup_batch_size: 1,
                    cleanup_max_batches: 0,
                },
            }).maintenance).toEqual({
                enabled: true,
                audit_log_retention_days: 90,
                cleanup_time: "03:30",
                cleanup_timezone: "Asia/Shanghai",
                cleanup_batch_size: 500,
                cleanup_max_batches: 20,
            });
        } finally {
            for (const name of envNames) {
                const value = previous[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    test("should configure the AI news bot without storing its secret value", () => {
        const envNames = [
            "AI_NEWS_ENABLED",
            "FEISHU_AI_NEWS_APP_ID",
            "FEISHU_AI_NEWS_APP_SECRET_ENV",
            "AI_NEWS_SOURCE_URL",
            "AI_NEWS_DEFAULT_LIMIT",
            "AI_NEWS_REQUEST_TIMEOUT_MS",
        ] as const;
        const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
        try {
            for (const name of envNames) delete process.env[name];
            const config = buildConfig({
                ai_news: {
                    enabled: true,
                    app_id: "cli_aaaaaaaaaaaaaaaa",
                    app_secret_env: "CUSTOM_AI_NEWS_SECRET",
                    source_url: "https://news.example.com",
                    default_limit: 50,
                    request_timeout_ms: 500,
                },
            });

            expect(config.ai_news).toEqual({
                enabled: true,
                bot_instance_id: "bot-ai-news",
                bot_name: "AI热点新闻助手",
                app_id: "cli_aaaaaaaaaaaaaaaa",
                app_secret_env: "CUSTOM_AI_NEWS_SECRET",
                source_url: "https://news.example.com",
                default_limit: 20,
                request_timeout_ms: 1000,
            });
            expect(JSON.stringify(config.ai_news)).not.toContain("app_secret:");
        } finally {
            for (const name of envNames) {
                const value = previous[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });

    test("should enable AI news on the existing Feishu bot without extra credentials by default", () => {
        const envNames = [
            "AI_NEWS_ENABLED",
            "FEISHU_AI_NEWS_APP_ID",
            "FEISHU_AI_NEWS_APP_SECRET_ENV",
            "AI_NEWS_DEFAULT_LIMIT",
        ] as const;
        const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
        try {
            for (const name of envNames) delete process.env[name];

            const config = buildConfig({});

            expect(config.ai_news).toMatchObject({
                enabled: true,
                app_id: "",
                source_url: "https://aihot.virxact.com",
                default_limit: 15,
            });
            expect(config.feishu.app_id).toBe(process.env.FEISHU_APP_ID || "");
            expect(JSON.stringify(config.ai_news)).not.toContain("app_secret:");
        } finally {
            for (const name of envNames) {
                const value = previous[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});
