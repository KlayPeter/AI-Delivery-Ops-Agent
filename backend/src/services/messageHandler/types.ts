import type { AppConfig } from '@/core/config';
import { PrismaStore } from '@/core/storage';
import { FeishuAdapter } from '@/adapters/feishu';
import { TapdAdapter } from '@/adapters/tapd';
import { EmailAdapter } from '@/adapters/email';
import { DashboardService } from '@/services/dashboard';
import { ProjectDashboardService } from '@/services/projectDashboard';
import { MessageIntentParser } from '@/services/messageIntent';
import type { SourceMessage } from '@/models/types';
import type { MessageRouteRegistry } from './routes';

export interface AgentMessageOrchestrator {
    isAvailable(): boolean;
    handle(message: SourceMessage, source: 'group' | 'private', replyContext?: unknown): Promise<{ runId: string; status: 'waiting_human' | 'succeeded'; text: string }>;
    resume(runId: string, message: SourceMessage, source: 'group' | 'private'): Promise<{ runId: string; status: 'waiting_human' | 'succeeded'; text: string }>;
}

export interface AgentCapabilityDispatcher {
    isAvailable(): boolean;
    runManual(capability: string, groupId: string, input: unknown, triggerId?: string): Promise<Record<string, any>>;
}

export interface HandlerContext {
    config: AppConfig;
    store: PrismaStore;
    feishu: FeishuAdapter;
    tapd: TapdAdapter;
    email: EmailAdapter | null;
    dashboard: DashboardService;
    projectDashboard: ProjectDashboardService;
    intentParser?: MessageIntentParser;
    agentOrchestrator?: AgentMessageOrchestrator;
    agentDispatcher?: AgentCapabilityDispatcher;
    messageRoutes?: MessageRouteRegistry;
}

export const TAPD_STATUS_REQUIREMENT = "status_2";
export const TAPD_STATUS_IN_PROGRESS = "status_14";
export const TAPD_STATUS_TESTING = "status_3";
export const TAPD_STATUS_DONE = "status_5";
export const TAPD_STATUS_CANCELLED = "status_20";
export const TAPD_STATUS_BLOCKED = "workflow_suspended";
export const WORKING_REACTION_MIN_SECONDS = 1.2;
export const AI_CONFIDENCE_THRESHOLD = 0.85;
export const PRIORITY_TO_TAPD_LABEL: Record<string, string> = { "P0": "High", "P1": "Middle", "P2": "Low" };
