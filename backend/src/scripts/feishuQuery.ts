/**
 * 飞书 API 诊断查询脚本 (仅限查询操作)
 *
 * 用途: 在正式环境中排查飞书用户、群组等实体状态。
 * 该脚本默认读取环境变量和系统配置，使用当前正式机器人的 App ID 和 Secret。
 *
 * 使用方式:
 *   bun run src/scripts/feishuQuery.ts user <open_id>     # 查询指定用户的详细信息
 *   bun run src/scripts/feishuQuery.ts chat <chat_id>     # 查询指定群聊的详细信息
 *   bun run src/scripts/feishuQuery.ts get <api_path>     # 自定义 GET 请求 (如: get contact/v3/users/...)
 */

import { loadConfig } from '../core/config';
import axios from 'axios';

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
    const url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
    const resp = await axios.post(url, {
        app_id: appId,
        app_secret: appSecret
    });
    if (resp.data.code !== 0) {
        throw new Error(`获取 Token 失败: ${JSON.stringify(resp.data)}`);
    }
    return resp.data.tenant_access_token;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log("用法示例:");
        console.log("  bun run feishuQuery.ts user ou_xxxxxxxxx");
        console.log("  bun run feishuQuery.ts chat oc_xxxxxxxxx");
        console.log("  bun run feishuQuery.ts get contact/v3/users/ou_xxxxxxxxx");
        return;
    }

    const command = args[0];
    const target = args[1];

    console.log("加载正式环境配置...");
    const config = loadConfig();
    const appId = config.feishu.app_id;
    const appSecret = config.feishu.app_secret;

    if (!appId || !appSecret) {
        console.error("❌ 环境中缺失 FEISHU_APP_ID 或 FEISHU_APP_SECRET！");
        return;
    }

    console.log(`正在获取租户凭证 (App ID: ${appId})...`);
    const token = await getTenantAccessToken(appId, appSecret);

    let apiUrl = "";
    if (command === "user") {
        apiUrl = `https://open.feishu.cn/open-apis/contact/v3/users/${target}`;
    } else if (command === "chat") {
        apiUrl = `https://open.feishu.cn/open-apis/im/v1/chats/${target}`;
    } else if (command === "get") {
        apiUrl = `https://open.feishu.cn/open-apis/${target.replace(/^\/+/, '')}`;
    } else {
        console.error(`未知命令: ${command}`);
        return;
    }

    console.log(`执行查询: GET ${apiUrl}`);
    try {
        const resp = await axios.get(apiUrl, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log("✅ 查询成功:");
        console.log(JSON.stringify(resp.data, null, 2));
    } catch (e: any) {
        console.error("❌ 查询失败:");
        if (e.response) {
            console.log(`状态码: ${e.response.status}`);
            console.log(JSON.stringify(e.response.data, null, 2));
        } else {
            console.error(e.message);
        }
    }
}

main().catch(console.error);
