import * as Lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../core/config';

async function main() {
    const config = loadConfig();
    const appId = config.feishu.app_id;
    const appSecret = config.feishu.app_secret;

    if (!appId || !appSecret) {
        console.error("❌ 错误: 环境变量中缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET。请先在 .env 中配置。");
        process.exit(1);
    }

    console.log(`正在请求飞书 API 获取机器人信息... (AppID: ${appId})`);

    const client = new Lark.Client({ appId, appSecret });

    try {
        const res = await client.request({
            url: 'https://open.feishu.cn/open-apis/bot/v3/info',
            method: 'GET'
        });

        if (res.code === 0 && res.bot) {
            console.log("\n✅ 获取成功！请将以下信息填入您的 K8s Secret 或 .env 中：\n");
            console.log(`FEISHU_BOT_OPEN_ID=${res.bot.open_id}`);
            console.log(`(机器人名称: ${res.bot.app_name})`);
        } else {
            console.error("\n❌ 获取失败，飞书 API 返回报错：", JSON.stringify(res, null, 2));
        }
    } catch (e: any) {
        console.error("\n❌ 网络请求失败：", e.message || String(e));
    }
}

main();
