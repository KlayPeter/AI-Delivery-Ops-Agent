import type { AppConfig } from '@/core/config';

export function maskedConfig(current: AppConfig): AppConfig {
    const response = JSON.parse(JSON.stringify(current));
    response.feishu.app_secret = current.feishu.app_secret ? "******" : "";
    response.tapd.api_token = current.tapd.api_token ? "******" : "";
    response.ai.api_key = current.ai.api_key ? "******" : "";
    response.email.pass = current.email.pass ? "******" : "";
    return response;
}
