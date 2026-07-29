import * as path from 'path';
import * as fs from 'fs';
import { Member } from '@/models/types';

export const DEFAULT_SCHEDULE: Record<string, any> = {
    standup_push: "09:00",
    standup_push_enabled: true,
    standup_second_remind: "09:30",
    standup_second_remind_enabled: true,
    standup_summary: "09:45",
    standup_summary_enabled: true,
    overdue_scan: "09:00",
    overdue_scan_end: "18:30",
    overdue_scan_interval_minutes: 30,
    overdue_scan_timezone: "Asia/Shanghai",
    overdue_scan_enabled: true,
    daily_summary: "18:30",
    daily_summary_enabled: true,
    dashboard: "18:40",
    dashboard_enabled: true,
    weekly_report: "18:50",
    weekly_report_enabled: true,
    weekly_report_timezone: "Asia/Shanghai",
    module_standup_enabled: false,
    module_daily_summary_enabled: false,
    module_dashboard_enabled: false,
    module_weekly_report_enabled: false,
    public_overdue_owners: false,
    workdays_only: true,
};

export interface ProjectConfig {
    name: string;
    root: string;
}

export interface FeishuConfig {
    app_id: string;
    app_secret: string;
    bot_open_id: string;
    bot_name: string;

    send_retry_count: number;
}

export interface GroupConfig {
    chat_id: string;
    name: string;
    members: Member[];
    schedule: Record<string, any>;
    daily_summary_period: string;
}

export interface TapdConfig {
    workspace_id: number;
    api_token: string;
    api_base: string;
    workitem_type_id: string;
    attachment_custom_field?: string;
}

export interface AIConfig {
    provider: string;
    api_base: string;
    api_key: string;
    model: string;
    max_tokens: number;
    temperature: number;
    retry_count: number;
    request_timeout_ms: number;
    use_proxy: boolean;
    proxy_url: string;
}

export interface AiNewsConfig {
    enabled: boolean;
    bot_instance_id: string;
    bot_name: string;
    app_id: string;
    app_secret_env: string;
    source_url: string;
    default_limit: number;
    request_timeout_ms: number;
}

export interface RuntimeConfig {
    data_dir: string;
    public_base_url: string;
    daily_summary_period: string;
    daily_summary_fetch_history: boolean;
    daily_summary_fetch_page_size: number;
}

export interface MaintenanceConfig {
    enabled: boolean;
    audit_log_retention_days: number;
    cleanup_time: string;
    cleanup_timezone: string;
    cleanup_batch_size: number;
    cleanup_max_batches: number;
}

export interface EmailConfig {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from_address: string;
    to_addresses: string[];
}

export interface AppConfig {
    project: ProjectConfig;
    feishu: FeishuConfig;
    tapd: TapdConfig;
    ai: AIConfig;
    ai_news: AiNewsConfig;
    email: EmailConfig;
    runtime: RuntimeConfig;
    maintenance: MaintenanceConfig;
    groups: GroupConfig[];
    schedule: Record<string, any>;
    root_path: string;
    data_path: string;
}

function envString(envName: string, defaultValue: string = ""): string {
    return process.env[envName] || defaultValue;
}

function envStringIfSet(envName: string, defaultValue: string = ""): string {
    return process.env[envName] !== undefined ? process.env[envName] || "" : defaultValue;
}

function envNumber(envName: string, defaultValue: number): number {
    const raw = process.env[envName];
    if (raw === undefined || raw === "") return defaultValue;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function envBool(envName: string, defaultValue: boolean): boolean {
    const raw = process.env[envName];
    if (raw === undefined || raw === "") return defaultValue;
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function defaultProjectRoot(): string {
    if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
    return path.basename(process.cwd()) === "backend" ? path.resolve(process.cwd(), "..") : process.cwd();
}

function normalizeSchedule(rawSchedule: Record<string, any> = {}): Record<string, any> {
    const schedule = { ...DEFAULT_SCHEDULE, ...rawSchedule };
    const overdueStart = normalizedClockTime(schedule.overdue_scan);
    const overdueEnd = normalizedClockTime(schedule.overdue_scan_end);
    const overdueInterval = Number(schedule.overdue_scan_interval_minutes);
    schedule.overdue_scan = overdueStart || DEFAULT_SCHEDULE.overdue_scan;
    schedule.overdue_scan_end = overdueEnd || DEFAULT_SCHEDULE.overdue_scan_end;
    if (clockMinutes(schedule.overdue_scan) > clockMinutes(schedule.overdue_scan_end)) {
        schedule.overdue_scan = DEFAULT_SCHEDULE.overdue_scan;
        schedule.overdue_scan_end = DEFAULT_SCHEDULE.overdue_scan_end;
    }
    schedule.overdue_scan_interval_minutes = Number.isInteger(overdueInterval) && overdueInterval > 0 && overdueInterval <= 60
        ? overdueInterval
        : DEFAULT_SCHEDULE.overdue_scan_interval_minutes;
    schedule.overdue_scan_timezone = validTimeZone(schedule.overdue_scan_timezone)
        ? schedule.overdue_scan_timezone
        : DEFAULT_SCHEDULE.overdue_scan_timezone;
    schedule.weekly_report = normalizedClockTime(schedule.weekly_report) || DEFAULT_SCHEDULE.weekly_report;
    schedule.weekly_report_timezone = validTimeZone(schedule.weekly_report_timezone)
        ? schedule.weekly_report_timezone
        : DEFAULT_SCHEDULE.weekly_report_timezone;
    if (!rawSchedule.standup_second_remind && rawSchedule.standup_remind) {
        schedule.standup_second_remind = rawSchedule.standup_remind;
    }
    if (rawSchedule.standup_second_remind_enabled === undefined && rawSchedule.standup_remind_enabled !== undefined) {
        schedule.standup_second_remind_enabled = rawSchedule.standup_remind_enabled;
    }
    reconcileModuleSchedule(schedule, rawSchedule, "module_standup_enabled", ["standup_push", "standup_second_remind", "standup_summary"]);
    reconcileModuleSchedule(schedule, rawSchedule, "module_daily_summary_enabled", ["daily_summary"]);
    reconcileModuleSchedule(schedule, rawSchedule, "module_dashboard_enabled", ["dashboard"]);
    reconcileModuleSchedule(schedule, rawSchedule, "module_weekly_report_enabled", ["weekly_report"]);
    return schedule;
}

function normalizedClockTime(value: unknown): string | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clockMinutes(value: string): number {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
}

function validTimeZone(value: unknown): value is string {
    if (typeof value !== "string" || !value) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}

function reconcileModuleSchedule(schedule: Record<string, any>, rawSchedule: Record<string, any>, moduleKey: string, jobKeys: string[]): void {
    if (rawSchedule[moduleKey] !== false) return;
    if (jobKeys.some(jobKey => rawSchedule[`${jobKey}_enabled`] === true)) {
        schedule[moduleKey] = true;
    }
}

export function buildConfig(raw: any): AppConfig {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error("Config must be a JSON object");
    }

    const projectRoot = envString("PROJECT_ROOT", defaultProjectRoot());

    const project: ProjectConfig = {
        name: envString("PROJECT_NAME", raw.project?.name || "Demo Project"),
        root: projectRoot,
    };

    const feishuRaw = raw.feishu || {};
    const feishu: FeishuConfig = {
        app_id: envString("FEISHU_APP_ID"),
        app_secret: envString("FEISHU_APP_SECRET"),
        bot_open_id: envStringIfSet("FEISHU_BOT_OPEN_ID", feishuRaw.bot_open_id || ""),
        bot_name: envStringIfSet("FEISHU_BOT_NAME", feishuRaw.bot_name || "AI 交付助理"),

        send_retry_count: Math.max(0, Number(feishuRaw.send_retry_count ?? envNumber("FEISHU_SEND_RETRY_COUNT", 1))),
    };

    const tapdRaw = raw.tapd || {};
    const tapd: TapdConfig = {
        workspace_id: Number(tapdRaw.workspace_id ?? envNumber("TAPD_WORKSPACE_ID", 0)),
        api_token: envString("TAPD_API_TOKEN"),
        api_base: tapdRaw.api_base || envString("TAPD_API_BASE", "https://api.tapd.cn"),
        workitem_type_id: tapdRaw.workitem_type_id || envString("TAPD_WORKITEM_TYPE_ID"),
        attachment_custom_field: tapdRaw.attachment_custom_field || envString("TAPD_ATTACHMENT_CUSTOM_FIELD"),
    };

    const aiRaw = raw.ai || {};
    const ai: AIConfig = {
        provider: aiRaw.provider || envString("AI_PROVIDER", "openai"),
        api_base: aiRaw.api_base || envString("AI_API_BASE", "https://api.openai.com/v1"),
        api_key: envString("AI_API_KEY"),
        model: aiRaw.model || envString("AI_MODEL"),
        max_tokens: Number(aiRaw.max_tokens ?? envNumber("AI_MAX_TOKENS", 4096)),
        temperature: Number(aiRaw.temperature ?? envNumber("AI_TEMPERATURE", 0.2)),
        retry_count: Math.max(0, Number(aiRaw.retry_count ?? envNumber("AI_RETRY_COUNT", 1))),
        request_timeout_ms: Math.max(1000, Number(aiRaw.request_timeout_ms ?? envNumber("AI_REQUEST_TIMEOUT_MS", 15000))),
        use_proxy: envBool("LLM_USE_PROXY", false) || envBool("AI_USE_PROXY", false) || aiRaw.use_proxy || false,
        proxy_url: envString("HTTP_PROXY_URL") || envString("AI_PROXY_URL") || aiRaw.proxy_url || "",
    };

    const aiNewsRaw = raw.ai_news || {};
    const aiNewsAppId = envString("FEISHU_AI_NEWS_APP_ID", aiNewsRaw.app_id || "");
    const aiNewsLimit = Number(aiNewsRaw.default_limit ?? envNumber("AI_NEWS_DEFAULT_LIMIT", 15));
    const aiNewsTimeout = Number(aiNewsRaw.request_timeout_ms ?? envNumber("AI_NEWS_REQUEST_TIMEOUT_MS", 10000));
    const ai_news: AiNewsConfig = {
        enabled: envBool("AI_NEWS_ENABLED", aiNewsRaw.enabled ?? true),
        bot_instance_id: envString("AI_NEWS_BOT_INSTANCE_ID", aiNewsRaw.bot_instance_id || "bot-ai-news"),
        bot_name: envString("FEISHU_AI_NEWS_BOT_NAME", aiNewsRaw.bot_name || "AI热点新闻助手"),
        app_id: aiNewsAppId,
        app_secret_env: envString("FEISHU_AI_NEWS_APP_SECRET_ENV", aiNewsRaw.app_secret_env || "FEISHU_AI_NEWS_APP_SECRET"),
        source_url: envString("AI_NEWS_SOURCE_URL", aiNewsRaw.source_url || "https://aihot.virxact.com"),
        default_limit: Number.isInteger(aiNewsLimit) ? Math.max(1, Math.min(20, aiNewsLimit)) : 15,
        request_timeout_ms: Number.isFinite(aiNewsTimeout) ? Math.max(1000, Math.min(30000, aiNewsTimeout)) : 10000,
    };

    const email: EmailConfig = {
        enabled: envBool("EMAIL_ENABLED", false),
        host: envString("EMAIL_HOST"),
        port: envNumber("EMAIL_PORT", 465),
        secure: envBool("EMAIL_SECURE", true),
        user: envString("EMAIL_USER"),
        pass: envString("EMAIL_PASS"),
        from_address: envString("EMAIL_FROM_ADDRESS", envString("EMAIL_USER")),
        to_addresses: envString("EMAIL_TO_ADDRESSES").split(",").map(s => s.trim()).filter(Boolean),
    };

    const runtimeRaw = raw.runtime || {};
    const runtime: RuntimeConfig = {
        data_dir: envString("DATA_DIR", "data"),
        public_base_url: runtimeRaw.public_base_url || envString("PUBLIC_BASE_URL"),
        daily_summary_period: runtimeRaw.daily_summary_period || "00:00-23:59",
        daily_summary_fetch_history: runtimeRaw.daily_summary_fetch_history ?? true,
        daily_summary_fetch_page_size: Number(runtimeRaw.daily_summary_fetch_page_size || 50),
    };

    const maintenanceRaw = raw.maintenance || {};
    const retentionDays = Number(maintenanceRaw.audit_log_retention_days ?? envNumber("AUDIT_LOG_RETENTION_DAYS", 90));
    const batchSize = Number(maintenanceRaw.cleanup_batch_size ?? envNumber("MAINTENANCE_CLEANUP_BATCH_SIZE", 500));
    const maxBatches = Number(maintenanceRaw.cleanup_max_batches ?? envNumber("MAINTENANCE_CLEANUP_MAX_BATCHES", 20));
    const maintenance: MaintenanceConfig = {
        enabled: envBool("MAINTENANCE_ENABLED", maintenanceRaw.enabled ?? true),
        audit_log_retention_days: Number.isInteger(retentionDays) && retentionDays > 0 && retentionDays <= 3650 ? retentionDays : 90,
        cleanup_time: normalizedClockTime(maintenanceRaw.cleanup_time || envString("MAINTENANCE_CLEANUP_TIME", "03:30")) || "03:30",
        cleanup_timezone: validTimeZone(maintenanceRaw.cleanup_timezone || envString("MAINTENANCE_CLEANUP_TIMEZONE", "Asia/Shanghai"))
            ? String(maintenanceRaw.cleanup_timezone || envString("MAINTENANCE_CLEANUP_TIMEZONE", "Asia/Shanghai"))
            : "Asia/Shanghai",
        cleanup_batch_size: Number.isInteger(batchSize) && batchSize >= 50 && batchSize <= 5000 ? batchSize : 500,
        cleanup_max_batches: Number.isInteger(maxBatches) && maxBatches > 0 && maxBatches <= 200 ? maxBatches : 20,
    };

    const schedule = normalizeSchedule(raw.schedule);

    const groupsRaw = raw.groups || [];
    const groups: GroupConfig[] = [];

    for (const g of groupsRaw) {
        groups.push({
            chat_id: g.chat_id || "",
            name: g.name || "",
            members: g.members || [],
            schedule: normalizeSchedule(g.schedule || schedule),
            daily_summary_period: g.daily_summary_period || runtime.daily_summary_period
        });
    }

    const dataPath = path.isAbsolute(runtime.data_dir)
        ? runtime.data_dir
        : path.join(project.root, runtime.data_dir);

    return {
        project,
        feishu,
        tapd,
        ai,
        ai_news,
        email,
        runtime,
        maintenance,
        groups,
        schedule,
        root_path: project.root,
        data_path: dataPath,
    };
}

export function loadConfig(raw: any = {}): AppConfig {
    let fileConfig = {};
    try {
        const rootPath = envString("PROJECT_ROOT", defaultProjectRoot());
        const configPath = path.join(process.cwd(), 'config.json');
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    } catch (e) {
        console.warn("Failed to load config.json", e);
    }

    const merged = {
        ...fileConfig,
        ...raw,
        feishu: { ...(fileConfig as any).feishu, ...raw.feishu },
        tapd: { ...(fileConfig as any).tapd, ...raw.tapd },
        ai: { ...(fileConfig as any).ai, ...raw.ai },
        ai_news: { ...(fileConfig as any).ai_news, ...raw.ai_news },
        runtime: { ...(fileConfig as any).runtime, ...raw.runtime },
        maintenance: { ...(fileConfig as any).maintenance, ...raw.maintenance },
        email: { ...(fileConfig as any).email, ...raw.email },
        project: { ...(fileConfig as any).project, ...raw.project },
    };

    return buildConfig(merged);
}
