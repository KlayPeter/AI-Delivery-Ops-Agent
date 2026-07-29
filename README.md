<div align="center">
  <img src="https://raw.githubusercontent.com/github/explore/80688e429a7d4ef2fca1e82350fe8e3517d3494d/topics/bot/bot.png" width="100" height="100" alt="Bot Logo">
  <h1>🚀 AI Delivery Ops Agent</h1>
  <p><strong>智能化研发交付中台：打通飞书、TAPD 与 AI，告别低效项目管理</strong></p>
  <p>
    <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" /></a>
    <a href="https://react.dev"><img src="https://img.shields.io/badge/React-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" /></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://open.feishu.cn"><img src="https://img.shields.io/badge/Feishu-00B2FF?style=for-the-badge&logo=feishu&logoColor=white" alt="Feishu" /></a>
    <a href="https://www.docker.com"><img src="https://img.shields.io/badge/Docker-2CA5E0?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
  </p>
</div>

<br />

> **AI Delivery Ops Agent** 是一个面向研发团队的 ChatOps 与 Agent Host。它连接飞书、TAPD 和 OpenAI 兼容模型，通过领域服务处理任务与站会，通过可插拔 Agent 执行日报、看板和外部资讯能力。

---

## ✨ 核心特性 (Features)

- **🤖 群聊即工单 (ChatOps)**：在飞书群中只需发送 `@机器人 安排任务`，大模型会自动拆解任务属性（负责人、截止日期、优先级）并双向同步至远端 TAPD，开发者全程无需打开工单系统。
- **🔄 极简状态流转**：群内回复“卡住了”或“做完了”，AI 会精准捕捉语义，自动更新状态流，并 `@` 相关人员请求协助。
- **📊 自动化站会与日报**：定时私聊收集成员进度，通过 Native Agent 生成研发日报，并由可靠投递层发送至群聊。
- **📈 现代化控制台**：自带基于 React、Vite 与 Ant Design 的前端管理台，可修改系统配置、预览迭代看板并回溯审计日志。
- **🧩 主从 Agent 编排**：主 Agent 可调用 Task、Standup、日报、看板和已安装的外部 Agent；每个子 Agent 拥有独立职责、会话和 Run。
- **🛠 受治理 Tool 与 Skill**：Agent 只能发现 Manifest 声明的 Tool、Skill 和子 Agent；强一致写操作继续通过领域服务。
- **📦 可靠执行与投递**：保存 Trigger、Run、Step、Session、Checkpoint 和 Artifact；Outbox 提供幂等、重试、租约和崩溃恢复。
- **🛰 AI 热点新闻助手**：现有飞书机器人私聊即可触发 `AI News Radar Agent`，无需大模型即可获取最新 AI 资讯并返回可点击卡片；也可选配独立机器人。
- **🤝 多机器人控制面**：支持每个 Bot Instance 独立长连接、Agent Binding、入站幂等隔离和按机器人凭证投递。
- **⚡ 轻量数据底座**：SQLite + Prisma 适合单后端写实例部署，提供事务、索引和单文件备份能力。

---

## 🏗 工程架构 (Architecture)

本项目采用前后端分离和“领域服务 + Agent Host”混合架构：

- **[Frontend（管理后台）](frontend/README.md)**：React、Vite、Ant Design。
- **[Backend（核心引擎）](backend/README.md)**：Bun、Elysia、Prisma、飞书/TAPD Adapter。
- **领域层**：`TaskService`、`StandupService`、`MessageRouter`、`ContextRouter` 维护强一致业务规则。
- **Agent Host**：`AgentRegistry`、`ModelLoopAgentAdapter`、`AgentRuntime`、`TriggerRuntime`、Tool/Skill Runtime、Session/Checkpoint、Artifact、Outbox 和 Bot Registry。
- **AI**：DeepSeek 或其他 OpenAI 兼容接口用于意图解析、内容生成和风险分析。

```text
飞书消息 / 定时任务 / API
            ↓
MessageRouter / TriggerRuntime
            ↓
确定性 Handler ──────────────→ TaskService / StandupService
            │
            └→ Delivery Ops 主 Agent
                    ↓ Agent-as-Tool
            Task / Standup / 日报 / 看板 / 外部 Agent
                    ↓
            Run → Step → Artifact → Outbox
                    ↓
              Bot Registry → 飞书
```

详细设计见 [系统功能与 Agent 能力卡](docs/features/README.md)、[系统架构与业务逻辑详解](docs/系统架构与业务逻辑详解.md) 和 [Agent 架构升级与系统评估](docs/Agent架构升级与系统评估-2026-07.md)。功能卡是代码维护入口：每次功能改动都必须同步对应 `FEATURE.md` 和流程图。

---

## 🚀 快速开始 (Quick Start)

### 1. 启动后端 (Backend)

进入 `backend` 目录，安装依赖、同步数据库并启动服务：

```bash
cd backend
bun install
cp .env.example .env
# 填写 .env 中的飞书、TAPD、AI 等测试凭证
bun run setup  # 同步 SQLite 结构并启动本地热更新服务
```

*如果你需要可视化修改和查看底层数据，可以运行 `bun run db:studio` 启动 Web 数据控制台。*

> **💡 提示：获取飞书 Bot Open ID**
> 如果你刚创建好飞书机器人，不知道它的 `open_id`，可以在 `.env` 中先填好 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，然后执行以下内置脚本一键查询：
> ```bash
> bun run get-bot-info
> ```
> 获取到后，将其填入 `.env` 中的 `FEISHU_BOT_OPEN_ID` 即可。
基础集成参数通过 `backend/.env` 提供；业务开关、群组、成员和定时任务可在前端管理台中维护并保存到 SQLite。

### 2. 启动前端 (Frontend)

进入 `frontend` 目录，安装依赖并启动管理控制台：

```bash
cd frontend
bun install
bun run dev
```
打开终端提示的地址（如 `http://localhost:15173`），即可通过图形化 UI 进行所有底层系统的配置。

### 3. 验证服务

```bash
curl http://localhost:8090/healthz
curl http://localhost:8090/api/agents
curl http://localhost:8090/api/bots
curl http://localhost:8090/api/agent-bindings
```

`/api/agents` 会列出 Delivery Ops、Task、Standup、日报、周报、项目看板和 AI News Radar 等内置 Agent。符合统一 HTTP 契约的外部 Agent 安装后也会出现在同一目录中。

> [!WARNING]
> 本项目目前没有应用层鉴权。只能在可信网络中运行，或由具备身份验证的反向代理保护；不要直接暴露到公网。

### 4. 使用 AI 热点新闻助手

该功能默认启用并复用系统已有的 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET`，不需要新增应用或配置第二套凭证。成员直接私聊现有机器人，发送“今天 AI 圈有什么热点”“最近三天 OpenAI 的全部模型新闻”等明确新闻查询，即可收到新闻卡片；其他消息继续进入原有任务、站会和主 Agent 流程。默认返回 15 条，回复“查看更多”会续取下一批 20 条；还支持“搜索 Claude”“AI信号”“来源 IT之家”“AI论文”等关键词、多源信号、信源和分类查询。

现有机器人只要已经能够接收私聊并发送消息，就无需新增飞书权限。要关闭此功能时设置 `AI_NEWS_ENABLED=false`。只有希望新闻助手显示为独立机器人时，才额外配置 `FEISHU_AI_NEWS_APP_ID`、`FEISHU_AI_NEWS_APP_SECRET`，并为第二个飞书应用订阅 `im.message.receive_v1`、申请 `im:message.p2p_msg:readonly` 与 `im:message:send_as_bot`。

---

## 🐳 Docker 与部署 (Deployment)

仓库内所有 Docker 构建与部署入口统一收敛到 `docker/` 与 `deploy/`：
- `docker/server/Dockerfile.k8s`：后端镜像
- `docker/web/Dockerfile.k8s`：前端静态镜像
- `docker/web/nginx.conf.template`：前端容器内 Nginx 反向代理配置
- `docker/docker-compose.yml`：本地或单机联调用的前后端双容器编排
- `deploy/k8s/*.yaml`：Kubernetes 部署清单
- `.github/workflows/ci.yml`：公共质量检查；不会部署或推送镜像

详细文档：

- [deploy/k8s/README.md](deploy/k8s/README.md)：部署文件说明与配置分层
- [deploy/k8s/DEPLOY.md](deploy/k8s/DEPLOY.md)：中性的手动部署、回滚与安全说明

说明：
`docker/web/Dockerfile.k8s` 里的 `BACKEND_UPSTREAM=http://backend:8090` 只是给 `docker-compose` 本地联调准备的兜底值，不是 K8s 的正式上游地址；K8s 部署时，`deploy/k8s/31-deployment-frontend.yaml` 会显式把它覆盖成集群内后端 Service 的 DNS 地址。

### 1. 本地 / 单机 Docker 部署

准备好后端 `.env` 和挂载数据目录后，直接从仓库根目录启动前后端双容器编排：

```bash
mkdir -p data
cp backend/.env.example backend/.env
# 请补充 backend/.env 里的集成密钥
docker compose -f docker/docker-compose.yml up -d --build
```
> **提示**：Docker 编排配置已自动将宿主机的 `data` 目录映射进容器中的 `/app/data`，SQLite 数据和中台动态配置都会持久化在这里。

访问地址：

- 前端：`http://localhost:8080`
- 后端健康检查：`http://localhost:8090/healthz`

### 2. Kubernetes 生产环境部署

首次部署前，先手动补齐运行时配置：

```bash
cp deploy/k8s/10-config.yaml /tmp/delivery-ops-config.yaml
# 将其中的 CHANGE_ME 替换为真实值后再执行
kubectl apply -f deploy/k8s/00-namespace.yaml
kubectl apply -f /tmp/delivery-ops-config.yaml
```

公共 GitHub Actions 只执行质量检查与 Docker 构建验证，不会向任何集群部署，也不会推送镜像。镜像发布和集群变更必须由维护者在自己的受控环境中完成。

如果需要手动发布或排障，可以执行以下命令：

```bash
kubectl apply -f deploy/k8s/20-pvc.yaml
kubectl apply -f deploy/k8s/40-service.yaml
kubectl apply -f deploy/k8s/30-deployment-backend.yaml
kubectl apply -f deploy/k8s/31-deployment-frontend.yaml

```

### 3. 部署风险提示

- 当前数据库使用 SQLite，容器重建时如果没有持久卷，数据会丢失；因此 K8s 中必须挂载 `delivery-ops-data`。
- SQLite 部署保持单个后端写实例；不要让多个 Pod 同时写同一个数据库文件。
- 群组、成员、运行参数和定时任务等动态配置保存在 SQLite，与业务数据共用持久卷；基础集成参数由环境变量或 ConfigMap/Secret 提供。
- 前端默认通过同域 `/api` 访问后端，生产环境不要再把前端构建成硬编码某个临时 IP 的版本。
- 后端镜像启动时会执行 `bun run db:push`，首次部署很方便，但生产变更表结构时仍然建议先确认 Prisma schema 的兼容性。

---

## 🌐 飞书长连接集成 (WebSocket)

本项目使用官方长连接（`WSClient`）接收飞书消息，无需配置公网 Webhook。

1. 填写 `app_id` 和 `app_secret` 并启动后台。
2. 前往 **飞书开放平台 -> 事件订阅**。
3. 将 **[订阅方式]** 切换为 **[使用长连接接收事件]** 并保存即可生效。

---

## 📚 文档索引

- [系统功能与 Agent 能力卡（功能清单、边界、流程图、代码与测试地图）](docs/features/README.md)
- [Agent 架构升级与系统评估（2026-07）](docs/Agent架构升级与系统评估-2026-07.md)
- [系统架构与业务逻辑详解](docs/系统架构与业务逻辑详解.md)
- [项目部署与开发协作流程](docs/项目部署与开发协作流程.md)
- [后端存储与协作架构说明](docs/后端存储与协作架构探究.md)
- [第三方平台接入配置指南](docs/保姆级第三方平台接入配置指南.md)
- [机器人 Agent 用户使用指南](docs/AI-Delivery-Ops-Agent-用户使用指南.md)
