# 本地运行

安装 Bun 1.3.x、Node.js 22 和 pnpm 10。以下命令在仓库根目录执行；不需要 Docker、服务器或外部账号。仅首次复制 .env，已有配置请保留。

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

首页为个人 Agent 工作台，默认九个插件、八个 Agent，不自动装配团队业务。个人知识使用仓库中的虚构示例，可在「知识库」直接检索，无需任何密钥。「连接与模型」可填写飞书、模型与 TAPD；「知识库 → 配置来源」可选择自己的目录或公开链接。配置保存在数据目录下的 connections.json（0600、本机明文），密钥不回显，重启后端后生效。工作台保存值覆盖同名环境值，模型与 TAPD 连接环境值优先于旧 config.json。

首次可在「知识库」检索 **API 迁移说明**，查看虚构 Release.md 的真实原文和版本。成功的知识回答详情可点击「检查引用变化」，生成独立检查记录；「刷新状态」只读取上次评估，显示检查时间，不自动扫描来源。原回答与引文保留，知识变化会提示复核。当前装配数量见[首页组合表](../README.md#能力与插件)，由回归测试对照实际插件声明校验。

「网页收集」无需模型即可提取单篇公开文章；「文档导入」需要先安装[固定版本 MarkItDown 环境](DOCUMENT_IMPORT.md)。未安装时页面明确显示转换器不可用，其他能力可以使用。成功结果可复制、下载或明确收录到「资料库」；资料库可立即检索，选作知识来源后需重启。

「结果验收」选择插件提供的规则和已结束运行，可再选择基准记录，检查产物结构、步骤及执行凭证；缺少旧执行版本时显示无法验证，不推断为通过。原运行保留，不重跑原任务；它不判断答案的语义正确性。实现和规则边界见[结果验收功能卡](../backend/src/quality/FEATURE.md)。

在「连接与模型」保存 GitHub 仓库并重启后，可使用[发布准备](RELEASE_PREPARATION.md)：不填模型时先收集仓库和知识证据，填好模型后按需生成草稿。

团队业务需要显式选择插件组合；项目看板还需配置群组与 TAPD。CLI 体验可按 [Markdown / Obsidian 与公开链接用法](PERSONAL_KNOWLEDGE.md) 在 CLI 中体验。CLI 的检索不需要模型，生成回答需要显式配置模型；持久化与历史引用复核见 [知识变更复核](KNOWLEDGE_IMPACT.md)。

默认「接入工具」可发现匿名公开 HTTPS MCP，审查并勾选读取工具，导出可审查的本地配置。保存到 backend/examples 并按页面命令重启后，在「运行工具」使用已授权能力；无需专用适配页面或模型。

接入已有开源 MCP 工具可按 [MCP 本地连接](MCP_TOOLS.md)选择独立配置档；提供无需模型的文件读取示例，默认工作台不自动启用外部进程。

页面与手动任务会按已装配插件变化：移除插件后，对应导航、页面与 API 同时不可用，历史数据保留。知识界面由 knowledge.workspace 独立贡献；显式 AGENT_PLUGINS_FILE 完全管理组合，不自动叠加页面来源设置。团队业务和基础服务的具体边界以[功能卡](features/README.md)为准。

本地管理 API 目前没有登录认证，统一限制本机 Host/Origin；使用示例中的回环地址运行。`.env`、个人知识文件与本地数据库不要提交到 Git。

## 按需启用团队功能

从 backend 目录使用现有配置启动：

```sh
AGENT_PLUGINS_FILE=profiles/agents/team.yaml bun run dev
```

该组合保留七个团队 Agent 和九个插件，包含任务、站会、日报、周报、看板及原有九项手动任务；不是默认个人组合的叠加开关。前端据实际贡献显示团队页面和业务任务；默认个人组合没有这些入口，其站会/看板/周报插件 API 也不可用。`/config` 等核心管理接口仍由宿主提供，隐藏导航不构成额外授权。

「连接与模型」的飞书、TAPD 仍可填写；凭据只保存连接配置，不会安装任务/报告 Agent。已保存的飞书凭据会在重启后尝试连接；使用群聊/私聊业务前请先选择提供对应能力的组合。

需要回到个人工作台时，移除启动命令中的 AGENT_PLUGINS_FILE（环境中已导出时先 unset AGENT_PLUGINS_FILE）再启动。切换使用同一数据目录时，历史 Run/Artifact 与连接配置保留，不自动重新启用旧插件。要混合团队和个人能力，可按[插件规范](PLUGIN_AUTHORING.md)在自己的 .local.yaml 中明确选择各模块。

## 社区插件体验

可选择 [Context7 社区插件](COMMUNITY_PLUGINS.md)，无需宿主模型即可查开发文档；其官方标准 Skill 也会导入，模型研究需自己的模型配置。该组合显式选择，不自动叠加默认团队/个人插件。

已初始化的 backend 可用 AGENT_PLUGINS_FILE=examples/plugins.context7-http.yaml bun run dev 直接连接官方 HTTPS MCP，无需安装上游本地包；查询会发给 Context7。凭据、固定地址、DNS/TLS 与流预算见 [MCP 工具](MCP_TOOLS.md)。
