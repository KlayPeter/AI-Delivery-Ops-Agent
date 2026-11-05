<div align="center">
  <img src="frontend/src/assets/logo.svg" width="88" height="88" alt="AI Delivery Ops Agent logo">
  <h1>AI Delivery Ops Agent</h1>
  <p>用自己的知识和开源插件，完成有来源、可追踪、可复核的 Agent 任务。</p>
</div>

本地优先的 Agent 插件工作台，面向开发者和个人知识使用者。从 Markdown、
Obsidian、公开网页或本地文档开始，检索原文、生成带引用的回答、准备发布草稿，
并在同一个界面查看实际执行步骤与结果。飞书和 TAPD 是可选的团队集成。

当前为 `v0.1.0-alpha`。无需飞书、TAPD 或模型密钥即可启动并体验示例知识检索；
调用外部服务或生成回答时，再配置自己的连接。

![个人知识工作台：内置虚构资料的无模型检索](docs/images/knowledge-workspace.jpg)

## 三个值得试的流程

- **资料成为任务输入**：网页正文或 PDF/Office 转为带来源指纹的 Markdown，
  检查后明确收录到本地资料库；可将资料库选作后续检索和 RAG 的来源。
- **知识变化后复核旧结果**：回答保留实际引用与版本；来源变更后，独立检查记录
  标出变化、缺失或不可访问的引用，保留原回答与证据。
- **插件结果可检查**：插件声明版本化结果规则，用同一规则检查两次已完成运行，
  展示结构、步骤及执行版本的差异。它不自动重跑任务，也不判断回答的语义正确性。

## 能力与插件

| 能力 | 当前实现 |
| --- | --- |
| Agent 工作台 | 任务发起、运行历史、步骤、产物、错误及人工补充后继续 |
| 个人知识 | 只读 Markdown/Obsidian 与公开 URL，关键词检索、版本、原文定位；可选模型生成引用回答 |
| 资料收集 | 单篇公开网页；微软 MarkItDown 0.1.9 转换 PDF、DOCX、PPTX、XLSX 等本地文件 |
| 本地资料库 | 明确收录、去重、来源凭证、检索与知识来源切换 |
| 开源能力接入 | MCP stdio/HTTPS、HTTP/OpenAPI 适配、标准 SKILL.md 显式导入；真实 Context7 示例 |
| 插件契约 | Manifest、依赖、权限、页面/API/动作、结果规则与 Cordis 资源释放 |
| 可靠执行 | Agent/Tool/Skill 预算、委派、Session/Checkpoint、Run/Artifact 与 Outbox |
| 可选团队能力 | GitHub 发布准备、飞书任务与报告、TAPD 同步、多机器人路由 |

默认装配与团队 SDK 分开；显式 `AGENT_PLUGINS_FILE` 完全控制组合，不自动叠加默认插件。

| 组合 | 插件数 | Agent 数 |
| --- | --- | --- |
| 默认 HTTP 工作台 | 17 | 14 |
| 配置 GitHub 后 | 19 | 15 |
| 团队 SDK | 9 | 7 |

[插件规范与作者模板](docs/PLUGIN_AUTHORING.md)描述当前支持的接口。
第三方仓库需要明确适配与授权；当前没有任意仓库自动安装或在线插件市场。

## 本地快速开始

需要 Bun 1.3.x、Node.js 22 与 pnpm 10。不需要 Docker、服务器或外部账号。

```bash
git clone https://github.com/KlayPeter/AI-Delivery-Ops-Agent.git
cd AI-Delivery-Ops-Agent/backend
bun install --frozen-lockfile
cp .env.example .env
bunx prisma generate
bun run setup
```

复制 `.env` 只用于首次初始化，已有配置请保留。示例凭据留空即可，后端默认
监听 `http://127.0.0.1:8090`。`setup` 安全同步 SQLite schema 并启动开发服务。

另开终端，从仓库根目录启动前端：

```bash
cd frontend
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev --host 127.0.0.1
```

打开 [本地工作台](http://127.0.0.1:15173/)，进入「知识库」检索 **API 迁移说明**。
结果来自仓库里的虚构示例笔记，无需模型。端口被占用时以终端实际地址为准。

```bash
curl http://127.0.0.1:8090/healthz
curl http://127.0.0.1:8090/readyz
```

`readyz` 的 `status: "ready"` 表示数据库、Host 和所需机器人已就绪；没有配置
飞书时，`required: 0` 是正常状态。完整说明见[本地运行](docs/LOCAL_DEVELOPMENT.md)。

## 接入自己的资料与能力

- 「知识库 → 配置来源」选择 Markdown/Obsidian 目录、公开链接或应用资料库；
  [来源指南](docs/PERSONAL_KNOWLEDGE.md)说明范围、排除项和引用。
- 「网页收集」可直接使用；「文档导入」需先安装
  [MarkItDown 转换环境](docs/DOCUMENT_IMPORT.md)，未安装时页面显示状态。
- 「连接与模型」可填写自己的模型、飞书、TAPD 与 GitHub 设置，保存后重启后端。
  设置保存在本机 `connections.json`，权限 0600，密钥不回显；本机文件未加密。
- 体验 [Context7 与标准 Skill](docs/COMMUNITY_PLUGINS.md)，或按
  [MCP 指南](docs/MCP_TOOLS.md)连接经审查的本地工具。独立配置档需显式选择。
- 配置 GitHub 后可使用[发布准备](docs/RELEASE_PREPARATION.md)，结合仓库事实与
  个人规则收集证据；生成草稿需要模型，不自动创建发布或发送消息。
- 团队接入见[第三方配置指南](docs/第三方平台接入配置指南.md)。飞书 App ID 与
  Secret 均留空时不连接；只填一项会拒绝启动。

## 架构

```text
本地工作台 / CLI / 飞书 / 定时触发
                 │
      Cordis 插件装配与能力注册
                 │
     Agent Host → Agent / Tool / Skill
                 │
     Run → Step → Artifact → Outbox
                 │
      来源版本 / 检查记录 / 可选投递
```

- [后端](backend/README.md)：Bun、Elysia、Prisma、SQLite、Cordis 与 Agent Runtime。
- [前端](frontend/README.md)：React、TypeScript、Vite、Ant Design。
- 确定性状态由领域服务维护；Agent 和模型通过受治理工具调用业务能力。
- 插件可贡献业务入口，部分基础服务仍由宿主拥有；当前边界见
  [功能卡索引](docs/features/README.md)和[路线图](ROADMAP.md)。

## 开发与验证

后端全量测试包含真实文档转换，先在 `backend` 安装
[固定版本 Python 转换环境](docs/DOCUMENT_IMPORT.md)，再执行：

```bash
cd backend
bun install --frozen-lockfile
bunx prisma generate
bunx prisma validate
bun run typecheck
TEST_DATABASE_PATH="$(mktemp)"
DATABASE_URL="file:${TEST_DATABASE_PATH}" bunx prisma db push --skip-generate
DATABASE_URL="file:${TEST_DATABASE_PATH}" bun test
```

前端：

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
bun test
pnpm build
```

行为变化与对应 `FEATURE.md` 同步提交，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 使用边界

管理 API 没有登录或 RBAC，使用回环地址运行；当前 Host/Origin 检查不等于身份认证。
SQLite 与资料库要求同一数据目录只有一个后端写实例。不要提交 `.env`、凭据、
个人知识、数据库、日志或生成报告。文档转换不提供 OCR，也不是公开上传沙箱。

本轮以本地运行验证为准。现有部署模板见[部署文档](docs/项目部署与开发协作流程.md)，
不影响本地使用。安全问题见 [SECURITY.md](SECURITY.md)，产品后续计划见
[ROADMAP.md](ROADMAP.md)；独立用户采用与长期运行数据仍待验证。

## 文档与许可

[文档中心](docs/README.md)包含使用、插件开发与架构指南。
[项目演示与验证证据](docs/PROJECT_EVIDENCE.md)提供可复现流程、实际截图、简历描述和待完成事项。
项目采用 [Apache License 2.0](LICENSE)；外部服务、内容源和依赖见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
