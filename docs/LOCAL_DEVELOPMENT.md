# 本地运行

安装 Bun 1.3.x、Node.js 22 和 pnpm 10。以下命令在仓库根目录执行；不需要 Docker、服务器或外部账号。仅首次复制 .env，已有配置请保留。

## 一个命令启动

```sh
bun run setup:local
```

首次安装前后端锁定依赖，生成 Prisma Client，使用既有安全数据库同步入口初始化 SQLite，随后启动前后端。只在缺少时从 backend/.env.example 创建 backend/.env（0600），已有文件不覆盖；不会复制或改写 frontend/.env。已有数据库会先做完整性检查和备份，不允许自动接受数据丢失。失败时停止后续步骤，按终端提示修复后可重新执行。

以后在仓库根目录执行 `bun run local`。它不安装依赖或修改 schema；拉取涉及依赖或数据库的更新后，再运行 `bun run setup:local`。打开 Vite 输出的实际地址，默认是 http://127.0.0.1:15173/；前端端口占用时由 Vite 选择可用端口。

启动器把后端和 Vite 绑定到 127.0.0.1，等待自己启动的后端报告监听成功，再把实际 API 地址传给前端；本次 VITE_API_BASE 覆盖已有前端配置，不会连接旧服务。默认后端 8090 被占用会报错；可修改 backend/.env 的 PORT，或执行 `PORT=0 bun run local` 使用动态端口。启动成功不代表外部模型或 MCP 服务可用。

Ctrl+C 或任一服务异常退出会停止本次启动的其他服务及其进程组，最多留 10 秒正常收尾；仍不退出才强制停止。退出不撤销已发生的业务操作；长任务应先在运行页确认结束。不会按端口查杀其他本地服务。当前进程生命周期验证覆盖 macOS 和 Linux；Windows 兼容分支尚未实际验证。

前端保留热更新；后端直接执行 src/index.ts，不经过包脚本包装、不监听文件。修改后端代码或手写插件组合后，停止并重新运行根目录命令。通过页面保存模型、连接和知识来源时，启动器会自动重载后端，前端地址保持；任务或插件操作进行中时保留设置，完成后在「连接与模型」点击「应用已保存配置」。只有新实例确认后才显示已应用，失败可查看终端日志。普通崩溃不会自动重启。外部程序仍由用户自行安装：根启动器不安装 Bun、Node.js、pnpm、Ollama 或 MarkItDown。

## 分开开发与排障

需要后端代码监听重启时，可沿用两个终端的方式。已初始化后，在 backend 执行 `bun run dev`；另一终端在 frontend 执行 `pnpm dev --host 127.0.0.1`。此方式的 API 地址由 frontend/.env 或 frontend/.env.example 中的 VITE_API_BASE 配置，修改 PORT 时要对应调整。

手动首次初始化可在 backend 依次执行 `bun install --frozen-lockfile`、仅在缺少时复制 .env.example、`bunx prisma generate`、`bun run db:push`，在 frontend 执行 `pnpm install --frozen-lockfile`。不要覆盖已有 .env。

飞书 App ID 和 Secret 都留空时，不创建默认飞书长连接。只填一项或错误 App ID 会明确报错；TAPD、模型和飞书业务操作需要各自的真实配置。后端监听后可查看其终端地址下的 /healthz 与 /readyz；后者返回 status: ready 表示数据库、Agent Host 和已配置入站机器人已就绪，未配置飞书时 required: 0 正常。

首页为个人 Agent 工作台，默认装配个人插件，不自动装配团队业务。个人知识使用仓库中的虚构示例，可在「知识库」直接检索，无需任何密钥。「连接与模型」可填写飞书、模型与 TAPD；「知识库 → 配置来源」可选择自己的目录或公开链接。配置保存在数据目录下的 connections.json（0600、本机明文），密钥不回显。根启动器模式下保存并自动应用；手动独立启动则保留重启提示。工作台保存值覆盖同名环境值，模型与 TAPD 连接环境值优先于旧 config.json。

知识页在未配置模型时提供「配置模型」入口；根启动器模式下可直接「保存并应用」，无需切换到终端重启。首次可在「知识库」检索 **API 迁移说明**，查看虚构 Release.md 的真实原文和版本。成功的知识回答详情可点击「检查引用变化」，生成独立检查记录；「刷新状态」只读取上次评估，显示检查时间，不自动扫描来源。原回答与引文保留，知识变化会提示复核。当前装配数量见[首页组合表](../README.md#能力与插件)，由回归测试对照实际插件声明校验。

「网页收集」无需模型即可提取单篇公开文章；「文档导入」需要先安装[固定版本 MarkItDown 环境](DOCUMENT_IMPORT.md)。未安装时页面明确显示转换器不可用，其他能力可以使用。成功结果可复制、下载或明确收录到「资料库」；资料库可立即检索，选作知识来源后保存并应用。

「研究助手」需要自己的模型，按问题委派资料子任务，保存研究稿和真实子任务索引；未配置模型时可先原文检索。研究稿需复核，使用与预算见[个人研究](PERSONAL_RESEARCH.md)。

「结果验收」选择插件提供的规则和已结束运行，可再选择基准记录，检查产物结构、步骤及执行凭证；缺少旧执行版本时显示无法验证，不推断为通过。原运行保留，不重跑原任务；它不判断答案的语义正确性。实现和规则边界见[结果验收功能卡](../backend/src/quality/FEATURE.md)。

在「连接与模型」保存并应用 GitHub 仓库后，可使用[发布准备](RELEASE_PREPARATION.md)：不填模型时先收集仓库和知识证据，填好模型后按需生成草稿。

团队业务需要显式选择插件组合；项目看板还需配置群组与 TAPD。CLI 体验可按 [Markdown / Obsidian 与公开链接用法](PERSONAL_KNOWLEDGE.md) 在 CLI 中体验。CLI 的检索不需要模型，生成回答需要显式配置模型；持久化与历史引用复核见 [知识变更复核](KNOWLEDGE_IMPACT.md)。

默认「接入工具」可发现匿名公开 HTTPS MCP，审查并勾选读取工具，导出可审查的本地配置。保存到 backend/examples 并按页面命令重启后，在「运行工具」使用已授权能力；无需专用适配页面或模型。

接入已有开源 MCP 工具可按 [MCP 本地连接](MCP_TOOLS.md)选择独立配置档；提供无需模型的文件读取示例，默认工作台不自动启用外部进程。

页面与手动任务会按已装配插件变化：移除插件后，对应导航、页面与 API 同时不可用，历史数据保留。知识界面由 knowledge.workspace 独立贡献；未声明 base: personal 的显式 AGENT_PLUGINS_FILE 完全管理组合，不自动叠加页面来源设置；声明个人基底时，来源仍采用本机保存的设置，允许从页面编辑并应用。团队业务和基础服务的具体边界以[功能卡](features/README.md)为准。

本地管理 API 目前没有登录认证，统一限制本机 Host/Origin；使用示例中的回环地址运行。`.env`、个人知识文件与本地数据库不要提交到 Git。

## 在个人工作台中使用 GitHub Skill

已初始化后，可按[Skill 接入指南](GITHUB_SKILLS.md)从公开 SKILL.md 链接读取固定指令与许可，逐项审查后下载配置。勾选“保留本机个人工作台”时，把 plugins.skills-personal.local.yaml 保存到 backend，停止当前服务，再从仓库根目录执行：

```sh
AGENT_PLUGINS_FILE=plugins.skills-personal.local.yaml bun run local
```

该配置声明 base: personal，在重启时沿用「连接与模型」的来源/仓库设置，再追加 Skill 接入与运行两个插件、两个 Agent；实际数量见[首页组合表](../README.md#能力与插件)，知识、资料库、研究和配方仍可使用。自定义插件和团队组合不会自动合并，重复基底插件 ID 会拒绝启动。

在「使用 Skill」明确选一份方法，可再预览一次成功知识检索的历史片段，确认发送后生成文本。使用自己的模型前可先完成读取、审查、导出与知识检索；Skill 文本生成才需要模型。快照证明选入了哪些资料，不证明实际采用、引用正确或来源仍最新。取消保留时仍导出原独立 Skill 组合，按下载的实际文件名重启。

## 按需启用团队功能

从 backend 目录使用现有配置启动：

```sh
AGENT_PLUGINS_FILE=profiles/agents/team.yaml bun run dev
```

该组合保留七个团队 Agent 和十二个插件（含三个模型提供者），包含任务、站会、日报、周报、看板及原有九项手动任务；不是默认个人组合的叠加开关。前端据实际贡献显示团队页面和业务任务；默认个人组合没有这些入口，其站会/看板/周报插件 API 也不可用。`/config` 等核心管理接口仍由宿主提供，隐藏导航不构成额外授权。

「连接与模型」的飞书、TAPD 仍可填写；凭据只保存连接配置，不会安装任务/报告 Agent。已保存的飞书凭据会在重启后尝试连接；使用群聊/私聊业务前请先选择提供对应能力的组合。

需要回到个人工作台时，移除启动命令中的 AGENT_PLUGINS_FILE（环境中已导出时先 unset AGENT_PLUGINS_FILE）再启动。切换使用同一数据目录时，历史 Run/Artifact 与连接配置保留，不自动重新启用旧插件。要混合团队和个人能力，可按[插件规范](PLUGIN_AUTHORING.md)在自己的 .local.yaml 中明确选择各模块。

## 社区插件体验

可选择 [Context7 社区插件](COMMUNITY_PLUGINS.md)，无需宿主模型即可查开发文档；其官方标准 Skill 也会导入，模型研究需自己的模型配置。该组合显式选择，不自动叠加默认团队/个人插件。

已初始化的 backend 可用 AGENT_PLUGINS_FILE=examples/plugins.context7-http.yaml bun run dev 直接连接官方 HTTPS MCP，无需安装上游本地包；查询会发给 Context7。凭据、固定地址、DNS/TLS 与流预算见 [MCP 工具](MCP_TOOLS.md)。

任务成功后可在运行详情保存为[任务配方](TASK_RECIPES.md)，核对原参数与执行版本；下次审查本次参数后创建新运行。最小无模型组合：在 backend 执行 `AGENT_PLUGINS_FILE=examples/plugins.recipes.yaml bun run dev`。

## 使用本机 Ollama

先在本机启动你自己的 Ollama，并用 `ollama list` 确认已有模型。打开「连接与模型」，选择 Ollama，填写模型名；默认地址是 `http://127.0.0.1:11434/v1`，无需 API Key。通过根启动器运行时保存后自动应用；独立启动仍需重启后端。工作台不会安装 Ollama 或下载模型，“已保存参数”也不代表服务可达或模型可用。研究助手需要实际模型支持工具调用。

也可在后端使用环境变量（已保存的连接配置仍优先）：

```sh
AI_PROVIDER=ollama AI_API_BASE=http://127.0.0.1:11434/v1 AI_MODEL='<已有模型名>' bun run dev
```

知识 CLI 使用独立 KNOWLEDGE_* 配置：

```sh
KNOWLEDGE_PROVIDER=ollama KNOWLEDGE_MODEL='<已有模型名>' bun run src/scripts/knowledge.ts --root examples/knowledge-vault --ask 'API 发布有什么要求？'
```

本机接口仅允许 HTTP 回环地址、固定 /v1 Chat Completions，不经过全局代理，也不发送旧云端密钥。Ollama 自身可以选择云端模型；如需本地推理，请确认你使用的是本机权重。当前测试采用真实 SDK 与本机协议服务，未在本机安装或验证真实 Ollama 推理。显式 YAML 需自行加入[模型提供者插件](PLUGIN_AUTHORING.md#模型提供者插件)；空组合不会隐式提供模型。

接口来源：[Ollama OpenAI 兼容说明](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)、[本机与云端认证范围](https://github.com/ollama/ollama/blob/main/docs/api/authentication.mdx)。

## 让多个已接入插件共同启用

在「插件 → 接入与组合 → 组合已有配置」选择已审查并下载的 Skill、MCP、OpenAPI YAML，各一份。校验后核对来源、工具与完整配置，再下载到 backend/；按页面命令从仓库根目录重启。个人知识来源和连接设置沿用本机，已有运行记录保留；不会自动合并当前自定义组合。完整步骤与限制见[插件配置组合](PLUGIN_PROFILES.md)。

首次还没有能力配置时，在同页「启用接入助手」勾选 GitHub Skill/OpenAPI，点击「保存并应用」，直接打开出现的接入链接；取消勾选并应用可停用。选择在本机私有保存，任务进行中时先等待结束。自定义插件文件仍使用高级导出并由原文件控制。此时只是打开发现与审查入口；逐项审查后导出的能力文件，才交给「组合已有配置」。默认 MCP 发现助手可直接使用。
