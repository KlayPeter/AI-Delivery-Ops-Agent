# 本地运行

安装 Bun、Node.js 22 和 pnpm 10。以下命令在仓库根目录执行；不需要 Docker 或服务器。

首次启动后端：

```sh
cd backend
cp .env.example .env
bun install --frozen-lockfile
bunx prisma generate
bun run db:push
bun run dev
```

示例配置将 HTTP 绑定到 `127.0.0.1:8090`。飞书 App ID 和 Secret 都留空时，不创建默认飞书长连接，仍可使用本地管理页面和 Agent/知识 CLI。只填一项或填写错误 App ID 会明确报错；配置凭据后需要重启后端。TAPD、模型和飞书业务操作需要各自的真实配置。

另开终端，在仓库根目录启动前端：

```sh
cd frontend
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

打开 [本地界面](http://localhost:15173/)。[就绪检查](http://localhost:8090/readyz) 返回 `status: "ready"` 表示数据库、Agent Host 和已配置的入站机器人已就绪；未配置飞书时 `required: 0` 是正常状态。

首页为 Agent 工作台，个人知识默认使用仓库中的虚构示例，可在「知识库」直接检索，无需任何密钥。「连接与模型」可填写飞书、模型与 TAPD；「知识库 → 配置来源」可选择自己的目录或公开链接。配置保存在数据目录下的 connections.json（0600、本机明文），密钥不回显，重启后端后生效。工作台保存值覆盖同名环境值，模型与 TAPD 连接环境值优先于旧 config.json。

成功的知识回答详情可点击「检查引用变化」，生成独立检查记录；「刷新状态」只读取上次评估，显示检查时间，不自动扫描来源。原回答与引文保留，知识变化会提示复核。HTTP 默认共 12 个插件、10 个 Agent，团队 SDK 保持 9 个插件、7 个 Agent。

页面初始没有团队业务数据。项目看板需要配置群组与 TAPD 后生成；CLI 体验可按 [Markdown / Obsidian 与公开链接用法](PERSONAL_KNOWLEDGE.md) 在 CLI 中体验。CLI 的检索不需要模型，生成回答需要显式配置模型；持久化与历史引用复核见 [知识变更复核](KNOWLEDGE_IMPACT.md)。

接入已有开源 MCP 工具可按 [MCP 本地连接](MCP_TOOLS.md)选择独立配置档；提供无需模型的文件读取示例，默认工作台不自动启用外部进程。

页面与手动任务会按已装配插件变化：移除 builtin.standup 后，站会导航、统计接口和手动站会任务都不可用；移除 builtin.dashboard 后，看板/甘特导航、文件读取、计划读写和旧 HTML/根查询入口均不可用，已有快照和任务保留；MCP 读取示例可自行贡献导航。周报与隐藏纪要页面/API 也由各自插件管理。纪要生成仍关闭，归档页面导航隐藏；邮件发送读取宿主邮件配置，本地验证使用替身服务，不代表已完成真实 SMTP 联调。知识工作台业务适配和基础服务生命周期继续按功能卡迁移。

本地管理 API 目前没有登录认证，统一限制本机 Host/Origin；使用示例中的回环地址运行。`.env`、个人知识文件与本地数据库不要提交到 Git。
