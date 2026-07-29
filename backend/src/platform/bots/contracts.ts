export type BotPlatform = 'feishu';
export type BotStatus = 'active' | 'disabled' | 'error';

export interface BotInstance {
    id: string;
    workspaceId: string;
    platform: BotPlatform;
    name: string;
    appId: string;
    secretRef: string;
    botOpenId?: string;
    status: BotStatus;
    config: Readonly<Record<string, unknown>>;
}

export interface BotAgentBinding {
    id: string;
    botInstanceId: string;
    agentInstallationId: string;
    enabled: boolean;
    priority: number;
    capabilities: readonly string[];
    routingConfig: Readonly<Record<string, unknown>>;
    configOverride: Readonly<Record<string, unknown>>;
}
