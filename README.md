<div align="center">
  <img src="frontend/src/assets/logo.svg" width="88" height="88" alt="AI Delivery Ops Agent logo">
  <h1>AI Delivery Ops Agent</h1>
  <p>连接飞书、TAPD 和 AI 模型的研发交付 ChatOps 与 Agent Host。</p>
</div>

AI Delivery Ops Agent 把任务流转、站会、日报、周报、项目看板和 AI
资讯接入同一套可审计的执行链路。业务状态由领域服务维护；Agent 负责多步
决策、内容生成和能力编排。

> [!IMPORTANT]
> 当前版本定位为 `v0.1.0-alpha`。接口、配置项和部署方式仍可能调整，建议先在
> 测试飞书应用与测试 TAPD Workspace 中验证。

> [!WARNING]
> 项目尚未提供应用层登录和 RBAC。请只在可信网络中运行，或放在具备身份验证、
> TLS、限流和访问审计的反向代理之后。不要把管理端或控制面 API 直接暴露到公网。

## 能力概览

| 能力 | 说明 |
| --- | --- |
| 飞书 ChatOps | 从群聊或私聊创建任务、更新进度、提交站会和触发报告 |
| TAPD 集成 | 创建与同步 Story、映射任务状态并保留外部系统事实 |
| Agent Host | 注册、安装、绑定和运行 Native、Model Loop 与外部 HTTP Agent |
| 可靠执行 | 持久化 Trigger、Run、Step、Session、Checkpoint、Artifact 和 Outbox |
| 管理控制台 | 管理群组、成员、调度配置，查看日志、上下文、站会、周报和甘特图 |
| AI News Radar | 查询公共 AI 资讯，支持时间范围、关键词、来源、分类和分页 |
| 多机器人路由 | 按 Workspace、Bot Instance、Agent Installation 和 Capability 隔离 |

系统内置七个 Agent：

1. Delivery Ops Agent
2. Task Agent
3. Standup Agent
4. Daily Summary Agent
5. Weekly Report Agent
6. Project Dashboard Agent
7. AI News Radar Agent

## 适用边界

本项目适合需要飞书协作、TAPD 任务管理和单后端实例部署的研发团队。当前
SQLite 架构要求只有一个后端写实例。

以下场景需要先补充工程能力：

- 对公网开放管理端或控制面 API；
- 多个后端实例并发写入；
- 多租户或严格租户隔离；
- 对身份认证、RBAC、合规审计或高可用有生产级要求。

相关规划见 [ROADMAP.md](ROADMAP.md)。

## 架构

```text
飞书消息 / 定时任务 / 管理 API
               │
               ▼
    MessageRouter / TriggerRuntime
        │                     │
        ▼                     ▼
领域 Handler 与 Service    Delivery Ops Agent
        │                     │
        │              Agent / Tool / Skill
        └──────────┬──────────┘
                   ▼
       Run → Step → Artifact → Outbox
                   │
                   ▼
          Bot Registry → 飞书
```

- [后端](backend/README.md)：Bun、Elysia、Prisma、SQLite、飞书/TAPD Adapter
  和 Agent Runtime。
- [前端](frontend/README.md)：React、TypeScript、Vite、Ant Design。
- 领域服务负责强一致写入；模型和 Agent 不能绕过领域规则直接修改业务状态。
- 外部 Agent 通过 Manifest、网络白名单、Secret 引用和输出类型约束接入。

详细说明见 [文档中心](docs/README.md)。

## 快速开始

### 1. 准备环境

- Bun 1.3.x
- Node.js 22 与 pnpm 10
- 一个用于测试的飞书企业自建应用
- 可选：测试 TAPD Workspace
- 可选：OpenAI 兼容模型接口

克隆仓库：

```bash
git clone https://github.com/KlayPeter/AI-Delivery-Ops-Agent.git
cd AI-Delivery-Ops-Agent
```

### 2. 启动后端

```bash
cd backend
bun install --frozen-lockfile
cp .env.example .env
```

至少为测试飞书应用填写：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_with_test_secret
FEISHU_BOT_OPEN_ID=ou_xxx
```

TAPD 和模型配置可以稍后补充；未配置时，对应能力不可用。公开版默认
`TAPD_WORKSPACE_ID=0`、`AI_MODEL=`，不会自动连接真实项目或模型。

初始化数据库并启动开发服务：

```bash
bunx prisma generate
bun run setup
```

如果还不知道 Bot Open ID，可以先填写 App ID 和 App Secret，再执行：

```bash
bun run get-bot-info
```

后端默认监听 `http://localhost:8090`。

### 3. 启动前端

打开另一个终端：

```bash
cd frontend
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

开发服务器默认使用 `http://localhost:8090/api` 作为后端地址，并在终端输出
前端访问地址。

### 4. 验证

```bash
curl http://localhost:8090/healthz
curl http://localhost:8090/readyz
curl http://localhost:8090/api/agents
```

- `/healthz` 表示进程仍能响应。
- `/readyz` 同时检查数据库、Agent Host 和所需机器人连接。
- `/api/agents` 应列出七个内置 Agent。

这些 API 没有内置鉴权，只能在受控环境中调用。

### 5. 配置飞书

1. 在飞书开放平台为应用添加机器人能力。
2. 在事件订阅中选择长连接，并订阅 `im.message.receive_v1`。
3. 发布测试版本，把机器人加入测试群。
4. 在管理台添加群组并同步成员。

权限、TAPD、模型和外部 Agent 的详细配置见
[第三方平台接入配置指南](docs/第三方平台接入配置指南.md)。

## Docker

从仓库根目录执行：

```bash
mkdir -p data
cp backend/.env.example backend/.env
# 编辑 backend/.env，只填写你自己的测试或运行环境凭证
docker compose -f docker/docker-compose.yml up -d --build
```

默认地址：

- 前端：`http://localhost:8080`
- 后端：`http://localhost:8090`

Compose 端口只绑定 `127.0.0.1`。SQLite 和动态配置保存在宿主机 `data/`
目录。停止服务不会删除该目录。

Kubernetes 模板和手动部署步骤见
[deploy/k8s/README.md](deploy/k8s/README.md) 与
[deploy/k8s/DEPLOY.md](deploy/k8s/DEPLOY.md)。公共 CI 不推送镜像，也不
连接任何集群。

## 开发与验证

后端：

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

行为变化必须更新对应 `FEATURE.md`。完整贡献流程见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 数据与安全

- 不要提交 `.env`、真实凭据、数据库、日志、备份或生成报告。
- 使用独立测试飞书应用和测试 TAPD Workspace 开发。
- SQLite 只能由一个后端实例写入，并且必须挂载持久化目录。
- 生产凭据应由环境变量、Secret Manager 或 Kubernetes Secret 注入。
- 提交安全问题前请阅读 [SECURITY.md](SECURITY.md)。

## 文档

[docs/README.md](docs/README.md) 按使用者、部署者和维护者整理了全部公开文档。

## 许可证

项目采用 [Apache License 2.0](LICENSE)。外部服务、内容源和依赖的说明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
