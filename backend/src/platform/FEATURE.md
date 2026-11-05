---
feature_id: agent-platform
name: Agent 平台与多机器人控制面
status: active
agent_mapping:
  - built-in.delivery-ops-agent
  - built-in.task-agent
  - built-in.standup-agent
  - native.daily-summary
  - native.weekly-report
  - native.project-dashboard
  - native.ai-news-radar
  - external.ai-hot
last_reviewed: 2026-11-05
---

# Agent 平台与多机器人控制面

提供可注册、可委派、可暂停恢复、可审计的 Agent Runtime，并通过 Tool、Skill、Trigger、Run、Artifact、Outbox 和 Bot Binding 支持内置与外部 Agent 插拔。

## 功能定位

Agent 平台把“一个模型调用”提升为可管理的执行单元。每个 Agent 通过 Manifest 声明身份、版本、Capability、运行方式和可使用资源；Runtime 负责作用域、运行记录、委派、暂停恢复和产物投递。

平台的核心价值不是把所有功能 Agent 化，而是建立稳定边界：Agent 决策下一步，Tool 暴露受控动作，Skill 提供可复用方法，Domain Service 保存业务事实。新增外部 Agent 或新机器人时，系统扩展注册和绑定，不复制整条业务链路。

## 实现流程图

```mermaid
flowchart TD
    UI[个人默认 / 按需团队工作台] --> A
    UI --> LC[私有连接配置·重启生效]
    LC --> X
    A["飞书 / Scheduler / API"] --> R{"默认 Bot 明确 AI 新闻意图?"}
    R -- "是" --> B["Scope 与 Bot Binding"]
    R -- "否" --> Q["现有消息 Router"]
    R -- "非消息入口" --> B
    Q --> B
    B --> C["Agent Registry 按 ID 或 Capability 解析"]
    X["Cordis FeaturePlugin / 兼容扩展"] --> C
    X --> I["Tool / Skill / Adapter 注册"]
    X --> SKIMP[标准 SKILL.md：元数据导入与独立权限]
    SKIMP --> I
    X --> MR["消息路由、引用上下文与帮助贡献"]
    MR --> Q
    X --> WEB[页面、API 与手动任务贡献]
    WEB --> WREQ[本机请求与 Host 在途跟踪]
    WEB --> FORM[可选 Capability 元数据：Agent 入口进入结构化表单]
    WREQ --> DOC[私有文档暂存 ID；Native Tool 转换与来源 Artifact]
    WREQ --> PV[报告/纪要受限文件 API / TaskService 甘特与计划审计]
    WREQ --> MAIL[纪要邮件接受/未确认审计，失败不伪造成功]
    WREQ --> J
    X --> RA[成功 Run 的插件动作与状态面板]
    UI --> RA
    RA -- 显式执行 --> B
    X --> SJ[群业务计划与轮询贡献]
    SJ --> A
    C --> D["Trigger / Session / Run Runtime"]
    D --> E{"Adapter 类型"}
    E -- Model Loop --> F["主 Agent / 专业 Agent"]
    E -- Native --> G["确定性 Agent"]
    E -- HTTP --> H["受限外部 Agent"]
    F --> I["Tool Gateway"]
    F -. 委派 .-> C
    D --> AB[父信号或自身截止时间中止执行；停止等待并拒绝迟到成功]
    AB --> FAIL[失败 Run / Step；不向调用者返回成功产物]
    I --> SV[标准 JSON Schema 校验；同 ID 契约隔离]
    SV --> J["Domain Service / Adapter"]
    X --> MCP[可选 MCP stdio / 公开 HTTPS 连接插件]
    MCP --> I
    MCP --> MHTTP[HTTP 固定端点、公开 DNS/IP 与 TLS；有界 JSON/SSE]
    MHTTP --> I
    J --> MS[显式选择的本地 MCP 工具]
    I -- "调用前已取消" --> XC["拒绝进入 Tool Handler"]
    X --> NP["Native 插件：宿主模型与 Tool 组合"]
    NP --> I
    NP --> OM["Orchestrator：可选无人工输入函数的纯生成"]
    OM --> K
    G --> J
    H --> K["Artifact / Step / Checkpoint"]
    K --> LS[CLI 可选私有 SQLite KV 与独占会话]
    LS --> IR[历史知识引用复核；原证据保留]
    J --> K
    K --> L["Outbox"]
    L --> M["目标 Bot 与飞书群"]
    N["配置完整的 active BotInstance 独立飞书长连接"] --> R
    G --> O["AI HOT v1 新闻 / 多源信号 Provider"]
    DOC --> KLIB[明确收录；既有知识检索与引用回答]
    K --> QCR[实际执行快照与保存记录验收]
    X --> QRULE[随插件释放的结果规则]
    QRULE --> QCR
    UI --> MCPSETUP[匿名 MCP 发现与审查配置导出]
    MCPSETUP --> MCPRESTART[用户保存并重启独立组合]
    MCPRESTART --> MCPRUN[通用读取路由与上游 Tool：共享预算及同一 Run]
    MCPRUN --> I
```

## 能力边界

### 目标

- 用统一 Manifest、Capability 和 Adapter 接入 Model Loop、Native 与 HTTP Agent。
- 主 Agent 可以按 capability 委派专业 Agent，所有副作用经过受治理 Tool。
- 为多机器人预留 Bot Registry、Binding 和目标路由，而不是在业务代码写死机器人。

### 非目标

- 不把所有业务函数包装成 Agent；确定性、强一致逻辑保留在领域服务。
- Skill 是可复用能力包，不拥有长期业务状态，也不等同 Agent。
- Agent Registry 不是任意远程代码执行器；外部 Agent 必须通过协议和 allowlist 接入。

## 本地工作台

HTTP 应用首页提供任务、运行详情、Agent/插件清单和连接表单，复用现有 Host；本地请求固定默认 workspace/bot，最终结果不投递会话。HTTP 默认组合数量见[工作台功能卡](workspace/FEATURE.md)与[首页装配表](../../../README.md#能力与插件)，首页数量由回归对照实际声明校验；团队 SDK 组合保持九个插件、七个 Agent。管理 API 校验回环 Host/Origin；这不是多人认证。站会、看板、甘特、周报与隐藏纪要页面/API 已按插件装配；旧根查询和 HTML 链接同样核对所有者，甘特计划继续由 TaskService 保存。

## 核心规则

团队 SDK 组合为九个功能插件、七个 Agent。各插件拥有自己的消息指令与引用贡献；Router 无业务默认项，空组合无消息和群业务调度功能。私聊组合中的成员门槛继续保留，不表示已提供逐路由授权或 RBAC。

原生插件现在可调用宿主 Orchestrator 和 Tool Gateway 组合受治理管线。知识回答用一个检索 Tool 和一次无 Tool 的模型生成，在发布前核验引用；两个个人知识插件均不进入默认团队组合。`allowHumanInput: false` 关闭模型执行器的默认人工输入函数，其他 Agent 保持原有默认暂停恢复行为。

Tool Gateway 在预取消和领取账本期间取消时拒绝进入 Handler；已领取调用记录失败，预取消不领取。超时将同一个 TOOL_TIMEOUT 原因传给 Handler 与等待方，避免协作取消把超时混成未知错误。已经发出的外部操作仍需业务幂等和结果核验。

Agent Runtime 在进入 Adapter 前核对父信号，并让父中止与自身截止时间参与等待；忽略信号或中止后返回成功的 Adapter 不能把迟到结果变成成功 Run。接收结果及持久化成功状态前再次检查信号。自身超时保留 TIMEOUT/可重试，父中止记录 PARENT_ABORTED/不可重试，Agent/委派 Step 同步失败并保留执行快照；不将其标成用户主动取消。已持久化的事实保留，失败返回不交付成功产物。原生代码不构成可强杀沙箱，已发出的业务副作用不自动回滚。

子截止时间受父截止时间约束，二者同时到期时，父中止和子计时器可能按不同平台顺序先触发；错误按实际先触发的来源记录。委派回归分别验证预中止/执行中止为 PARENT_ABORTED，自身超时为 TIMEOUT，相同截止时间允许这两种原因，但必须失败、保留对应重试属性且不产生迟到成功。

执行始终使用请求中记录的绝对 deadlineAt；保存运行步骤等等待会消耗剩余时间，不能在等待之后重新计满配置时长。计时器按剩余时间启动，每个执行/结果边界同时核对当前时间，即使事件循环尚未处理计时器，也不能接受已过期成功。agentRuntime.test.ts 用慢步骤保存和绝对截止后才返回的 Adapter 重现并校验该边界。

1. **Manifest 是运行契约。** Agent 只能声明并使用自己的 Capability、Tool、Skill 和可委派子 Agent；运行时不接受 Prompt 临时扩大权限。
2. **Registry 负责发现，Binding 负责使用。** 安装 Agent 不等于所有机器人自动可用；Bot Binding 决定某个机器人可路由哪些 Capability，以及优先级和覆盖配置。
3. **所有执行携带 Scope。** workspace、bot、group 和 user 共同限制读取、Tool 调用、Run 查询和最终投递，跨 Scope 操作在服务端拒绝。
4. **三类 Adapter 使用同一生命周期。** Model Loop、Native 和 HTTP Agent 都产生 Trigger、Run、Step 和 Artifact，但各自执行策略不同。
5. **Agent 不直接写业务存储。** 具有副作用的动作进入 Tool Gateway，再由 Domain Service 校验身份、状态、参数和幂等键。
6. **委派必须有界。** 父 Agent 只能调用 Manifest 允许的 Capability；子 Run 保存 parent、root 和 correlation 关系，并受深度、步数、预算和超时限制。
7. **暂停恢复复用原 Run。** 等待用户补充信息时保存 Checkpoint；用户回复后继续原来的根 Run，不能创建另一条失去上下文的执行链。
8. **外部 Agent 默认不可信。** HTTP Adapter 校验 endpoint allowlist、Secret 引用、请求超时和响应大小，并区分可重试错误与永久错误。
9. **Agent 完成不等于消息送达。** Runtime 先保存 Artifact，再写 Outbox；Delivery Worker 独立完成 Bot 路由、重试和最终状态。
10. **功能是否 Agent 化看运行特征。** 需要多步决策、会话恢复、独立部署或资源预算时使用 Agent；稳定知识和操作方法使用 Skill；强一致状态始终归 Domain Service。
11. **功能 Agent 通过 Cordis 插件装配。** 七个内置 Agent 已拆为独立 `FeaturePlugin`，版本、依赖、配置和 effect 清理由插件运行时管理；`AgentHost` 默认无业务插件，应用通过 `createDeliveryOpsHost` 选择组合。完整规范见 `docs/PLUGIN_AUTHORING.md`。旧扩展继续兼容： 自定义模块实现带唯一 ID 的 `AgentHostExtension`，在 Runtime 就绪前取得受限的 Registry、Native/Model-loop Adapter、Tool 与 Skill 注册入口；重复 ID 或注册失败会让 Host 启动失败，不能留下部分就绪状态。内置 Agent 的默认注册顺序和外部 HTTP Agent 安装协议保持不变。
12. **多机器人入口与出口使用同一 Bot Scope。** 每个配置了入站连接的 active BotInstance 建立自己的飞书长连接，入站闭包固定 bot ID；Trigger 幂等和 Outbox 目标都包含 bot ID，出站再按该 BotInstance 解析凭证。
13. **默认机器人可按确定性意图前置调用 Capability。** 现有机器人收到明确的 AI 新闻 p2p 文本时，在成员映射和 Delivery Ops 主 Agent 之前调用 `knowledge.ai.news.fetch`；同会话 30 分钟内的“查看更多”、关键词、来源和分类追问沿用新闻路由。其他模糊追问、否定、元问题、开发任务和非新闻文本继续原业务链路。显式配置不同 App ID 时才启用带 `entryCapability` 的独立新闻机器人。
14. **机器人日志最小化且可验收。** AI 新闻入站和出站审计只保留 bot、message、chat、投递结果等路由元数据，不保存私聊或卡片正文；飞书事件先以 workspace、BotInstance、message ID 建立数据库原子 Claim，再写入最多 1000 条的进程内快速缓存，`/readyz` 要求所有启用的入站机器人连接可用。默认复用模式不增加连接数。
15. **外部投递遵守供应商反馈。** 飞书请求接收 Worker 的取消信号；429 使用 `Retry-After`，月额度耗尽按 App ID 进入不可重试熔断，不能重新运行 Agent 或误伤其他机器人。
15. **文章产物由平台安全渲染。** `article_list` 只接受 HTTP/HTTPS 原文链接，平台负责追加信号来源和操作提示；Provider 返回内容不能控制提示语、生成任意卡片结构或暴露内部 cursor。

## 插件运行后续动作

Host 持有 RunActionRegistry，Cordis 管理注册生命周期。状态 GET 先核对默认 workspace/bot，再读取插件状态并校验 StatusPanel 1.0；读取失败返回错误面板。POST 仅接受 UUID，由插件固定目标与输入，经已启用 Capability 进入正常 Runtime；幂等键绑定动作和目标 Run。Host 停止等待在途状态读取和动作执行后释放插件。原始历史与后续报告分别持久化，不修改旧 Artifact。

## 外部工具与 Schema

可选 connector.mcp 将已审查的本地 stdio 工具显式导入 Tool Registry，仍受 Scope、Agent allowedTools 和预算约束。标准 JsonSchema 类型与校验使用官方 SDK 的 JSON Schema 实现，支持联合类型、额外字段、引用及数值/长度约束；非法或不支持的 Schema 失败关闭，不自动下载远端引用。同一 $id 的不同契约不复用验证器，防止错误套用另一份契约。现有基础 Schema 保持兼容，错误描述改用标准校验器文案。MCP 是 Tool 连接，不是新增 Agent Adapter；具体边界见 [MCP 功能卡](../connectors/mcp/FEATURE.md)。

## 本地启动

默认飞书 App ID/Secret 均为空时跳过该入站连接，保留默认 Bot 的本地 Agent Scope。只填一项或格式错误仍阻止连接启动；其他已配置机器人继续独立启动。连接管理器的 `requiredBots()` 同时驱动启动与 `/readyz`，避免未配置飞书使本地永远不就绪。`HOST` 可指定 HTTP 绑定地址，本地示例使用 `127.0.0.1`；未设置 HOST 时也默认监听回环地址。操作步骤见 [本地运行](../../../docs/LOCAL_DEVELOPMENT.md)。

## 本地 CLI 状态

知识与发布 CLI 可显式选择 SQLitePersistentKeyValueStore，复用既有 KV/Run/Artifact 契约。默认团队应用仍使用既有持久化路径。新状态文件校验专用 application_id/schema，创建私有文件与目录，拒绝符号链接、硬链接、共享权限与外部数据库。独立 SQLite 锁事务限制同一文件一个 CLI Host，避免重启恢复误标另一个活跃会话；已提交状态单独持久化，进程退出释放锁。此实现不是应用认证、加密存储或多机数据库。

## 插件 Web 生命周期

Host 提供 PluginWebRegistry，由 Cordis 管理页面/API/原有手动任务授权。handlePluginRequest 与 executePluginJob 统一进入在途跟踪；停止后拒绝新请求，等待已接受请求和任务后才释放插件。路由声明用于 HTTP 装配与 OpenAPI，Fetch handler 保留原 Request 请求体；本机 Host/Origin 边界仍生效。页面元数据不提供认证或原生代码沙箱，旧业务路由仍逐项迁移。

已打包 builtin 页面可选声明 capability，让 Agent 卡片和任务选择进入所属结构化表单。网页收集与 MarkItDown 文档导入分别以独立 Native Agent/Tool 使用现有 Run、Scope、预算、幂等与私有 Artifact，不修改 Agent 执行协议。文档通过不透明上传 ID 消费私有暂存；转换器独立子进程固定上游版本，不接收用户提供的主机路径。专项验证见 backend/test/webCapture.test.ts、backend/test/markitdown.test.ts，页面入口回归见 frontend/src/pages/workspace/pages.test.mjs。

## 社区 Skill 与 Context7 验证

标准 SKILL.md 可经 readAgentSkill 显式导入现有 Prompt Skill Runtime；元数据不能自动取得工具或 Agent 授权，不执行目录脚本。community.context7 是真实使用者：接入上游 MCP 两个读取工具，提供无模型查询和需模型的研究助手；页面按插件贡献，未知能力标签使用作者声明的 Agent 名称。默认组合不自动安装它。来源、许可、运行命令和验收边界见 [社区接入说明](../../../docs/COMMUNITY_PLUGINS.md)。

验证：backend/test/context7Plugin.test.ts 覆盖格式/边界、权限不继承、受控 Prompt Skill 执行及插件装配；本地实际 MCP 与工作台验收覆盖公开文档检索。真实付费模型未调用。

资料库作为独立 Native 插件复用 Agent/Tool/Artifact 与运行后续动作；收录只接受固定原 Run ID，不把正文或路径视为动作授权。一次预算写入应用私有目录，检索和来源切换复用 Markdown/RAG/impact。没有新的 Agent 协议或共享 Store 表。验证：backend/test/knowledgeLibrary.test.ts，包含保存后重启、真实 MarkItDown、模拟模型引用回答与变更复核。

Agent Runtime 为每次实际 invoke 的 Agent Step 保存 execution 1.0：Agent ID/版本、Manifest 序列化指纹和可用的请求输入指纹；成功/失败都保留，人工继续创建新步骤，原 metrics 不丢失。不可序列化的 SDK 输入不使执行失败，缺失指纹不能作为可比较凭证。quality.checks 通过新规则注册表读取已保存证据，独立验收；历史版本不从当前安装推断。验证：agentRuntime.test.ts、pluginChecks.test.ts。


## MCP 接入与通用运行

HTTP 默认加入独立 mcp.setup 接入助手，公开 HTTPS 匿名发现、审查勾选与 local.yaml 导出；不调用目录内工具或读取 Secret。保存并重启明确组合后，mcp.runner 按可信 allowedTools 转调已注册读取工具，实时 Schema 校验、同一 Scope/信号与共享两次 Tool 预算，记录 Agent/路由/上游三步。ctx.delivery.tools.list 只返回契约副本，ToolExecutionContext.budget 沿用既有预算，不给旧调用新增额度。移除插件释放页面/API/Agent/Tool，历史保留；无在线安装或 OS 沙箱。实现与测试见 [接入功能卡](../connectors/mcp-workbench/FEATURE.md)。

## HTTP 默认组合边界

HTTP 仅默认加载个人知识、采集、资料库、验收与 MCP 接入助手（九插件/八 Agent）；SDK 团队默认不变，HTTP 团队通过既有可信文件显式选择。工作台根据实际 active Agent 和页面/手动任务贡献选择默认能力与导航，不将隐藏菜单作为 API 授权。默认没有站会/看板/周报插件接口或九项团队业务任务；切换保留成功历史，不自动重新启用旧插件。真实装配与保留历史验证见 backend/test/workspaceComposition.test.ts；首页数量由 featureIndex.test.ts 对照实际 HTTP 选择器检查。

## 用户能力

- 通过 Delivery Ops 主 Agent 调用 Task、Standup、Daily Summary、Weekly Report 和 Project Dashboard Agent。
- 安装、启用和调用符合 HTTP 契约的外部 Agent，例如 AI Hot。
- 为不同机器人绑定 Agent/能力和投递目标。
- 查看 Agent Run、Step、Artifact、Tool Call，并对可恢复运行暂停或继续。

## 入口与触发

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| 消息兜底/主 Agent | 用户目标和会话作用域 | Tool 调用、委派或回复 |
| Scheduler/API | Agent ID、capability、payload、scope | Agent Run 与 Artifact |
| 外部 Agent 安装 | Manifest、endpoint、Secret 引用 | Registry 中的 Agent |
| Bot Binding | Bot、群、Agent/capability 规则 | 受路由约束的执行和投递 |

## 运行逻辑

1. Bootstrap 注册 Agent、Tool、Skill、Bot、Adapter 和持久化组件。
   先由 Cordis 装配插件拥有的 Agent、Tool、Skill、消息路由与 Adapter，再恢复持久化控制面并发送 `delivery/restored`；兼容扩展在 Runtime 创建前执行。
2. 入口创建带 tenant/group/bot/user 的 Scope，并按 ID 或 capability 解析 Agent。
3. Runtime 建立 Trigger、Session、Checkpoint 和 Run。
4. Adapter 执行 Model Loop、Native 函数或受限 HTTP 调用。
5. Model Agent 只能通过 Tool Gateway 调用领域能力，或经 Runtime 委派其他 Agent。
6. Step、Tool Call、Artifact 和状态增量持久化；投递写入 Outbox，再按 Bot Binding 发送。

## Agent、Tool、Skill 与服务边界

| 对象 | 何时使用 | 状态与副作用 |
| --- | --- | --- |
| Agent | 有独立目标、决策循环、会话/恢复或独立部署需求 | 拥有运行状态，不直接拥有业务真相 |
| Tool | Agent 需要调用确定性系统能力 | 强 Schema、权限、幂等和审计；副作用入口 |
| Skill | 可复用提示、流程说明或工具组合 | 默认无长期状态，不直接绕过 Tool |
| Domain Service | 强一致业务规则和唯一写入口 | 拥有业务状态 |
| Native Agent | 希望接入统一调度/审计的确定性长流程 | 复用 Service，不能复制领域规则 |
| HTTP Agent | 独立部署或外部开源 Agent | 仅经协议、超时、认证和网络 allowlist 调用 |

### Agent 与 Skill 判断规则

满足任一强信号时优先 Agent：需要多步自主决策、独立会话或暂停恢复、独立扩缩容/部署、独立 SLA 和资源预算。仅包含稳定知识、提示模板、确定性步骤或多个 Tool 的可复用操作方式时优先 Skill。需要持久化业务状态时，两者都不是状态所有者，应进入领域服务。

## 当前 Agent 清单

| Agent ID | Capability | Adapter | 角色 |
| --- | --- | --- | --- |
| `built-in.delivery-ops-agent` | `delivery.ops.orchestrate` | Model Loop | 主编排 Agent |
| `built-in.task-agent` | `task.manage` | Model Loop | 任务专业 Agent |
| `built-in.standup-agent` | `standup.manage` | Model Loop | 站会专业 Agent |
| `native.daily-summary` | `summary.daily.generate` | Native | 日报 Agent |
| `native.weekly-report` | `summary.weekly.generate` | Native | 周报 Agent |
| `native.project-dashboard` | `dashboard.project.generate` | Native | 看板 Agent |
| `native.ai-news-radar` | `knowledge.ai.news.fetch` | Native | 实时 AI 新闻 Agent |
| `external.ai-hot` | `knowledge.ai.hot.fetch` | HTTP | 可选外部知识 Agent |

## 本地状态锁保护

CLI 状态文件与会话锁文件仅在不存在时独占创建，创建/关闭在同步段内完成；已有文件通过 lstat 验证常规文件、单链接与私有权限，不额外打开并关闭它们。这样重复打开被拒绝后，不会因原始文件句柄 close 取消同进程的 SQLite POSIX 锁，另一进程仍不能进入活跃状态会话。

## 数据与状态

- Manifest/Registry 保存定义；Trigger、Session、Checkpoint、Run、Step、Artifact 和 Tool Call 保存执行事实。
- Scope 至少区分 tenant、group、bot 和 user；Run 与 Artifact 不能跨 Scope 查询或投递。
- Outbox 与业务 Run 分离：Agent 完成不代表外部消息已送达。
- Bot Binding 决定入口 Agent 和出口 Bot，新增机器人不需要复制业务 Agent。

## 失败、安全与降级

- 外部 Agent endpoint 必须执行协议校验、认证、连接/读取超时、响应大小限制和内网地址策略，防止 SSRF。
- Tool Gateway 必须服务端校验 Schema、调用者 scope、权限、超时和幂等键；Prompt 不是权限边界。
- Secret 只通过 Resolver 传给 Adapter，不进入 Prompt、日志或 Artifact。
- 循环委派、无限 Tool 调用和 Token 消耗需要深度、步数、预算和截止时间上限。
- Runtime 崩溃后从持久化 Checkpoint 恢复，不能重复已经确认的副作用。

## 代码地图

### 主要实现

- `backend/src/platform/plugins/web.ts`、`backend/src/platform/workspace/jobsApi.ts`：Web 注册、API 路由与手动任务所有者校验。

- `backend/src/platform/agents/schema.ts`、`contracts.ts`：标准 JSON Schema 契约与失败关闭。
- `backend/src/connectors/mcp/plugin.ts`、`http.ts`：可选 stdio / 公开 HTTPS 工具连接；不进入默认组合。
- `backend/test/mcpHttp.test.ts`：真实 TCP JSON/SSE、固定 IP/TLS 参数、Bearer 引用、DNS/URL 拒绝、取消/预算与会话清理；真实 HTTPS 另经官方 Context7 验收。

- `backend/src/platform/plugins/runActions.ts`：成功 Run 的插件动作注册与文本面板协议。

- `backend/src/platform/persistence/sqliteStore.ts`：CLI 私有 KV、专用 schema 和独占会话。
- `backend/test/localState.test.ts`：KV/重开、权限、跨进程与强制退出恢复。
- `backend/src/platform/plugins/contracts.ts`、`runtime.ts`：版本化功能插件与 Cordis 生命周期。
- `backend/src/agents/host.ts`、`backend/src/agents/plugins/`：应用组合与七个独立 Agent 插件。

- `backend/src/platform/agents/registry.ts`、`runtime.ts`、`contracts.ts`：Agent 注册与运行契约。
- `backend/src/platform/agents/modelLoopAdapter.ts`、`nativeAdapter.ts`、`httpAdapter.ts`：三种执行 Adapter。
- `backend/src/platform/bootstrap/agentHost.ts`：平台装配，并提供带唯一 ID 的本地扩展注册上下文，供二开模块注册 Agent、Tool、Skill 或 Adapter。
- `backend/src/platform/tools/gateway.ts`、`registry.ts`：Tool 治理。
- `backend/src/platform/skills/registry.ts`、`runtime.ts`、`packageLoader.ts`：Skill 加载与执行。
- `backend/src/platform/session/**`：会话和 Checkpoint。
- `backend/src/platform/bots/**`、`delivery/routedFeishuAdapter.ts`：多机器人长连接、入站隔离与路由投递。
- `backend/src/agents/**`：当前 Agent 定义。

### 主要测试

- `backend/test/pluginWeb.test.ts`：页面/API/任务元数据、默认组合、回滚、请求体与在途停止。

- `backend/test/jsonSchema.test.ts`、`backend/test/mcpConnector.test.ts`：完整约束、Schema 身份隔离、工具权限与 MCP 生命周期。

- `backend/test/runActions.test.ts`、`backend/test/workspaceActions.test.ts`：动作校验、Scope、固定输入、幂等与停机等待。

- `backend/test/knowledgeAnswer.test.ts`：真实 SDK/本地模拟模型、无 Tool 生成、引用核验、Scope 和运行证据。
- `backend/test/toolSkillRuntime.test.ts`：预取消与领取期间取消不执行处理者，及原工具/Skill 预算和幂等回归。
- `backend/test/schedulePlugins.test.ts`：群调度贡献、空组合、插件禁用、错误隔离与在途停止。

- `backend/test/messagePlugins.test.ts`：共享消息注册表、插件禁用、第三方私聊与确定性消息在途停止。

- `backend/test/pluginRuntime.test.ts`：版本、依赖、配置、恢复、失败回滚与清理。

- `backend/test/agentHost.test.ts`、`agentRuntime.test.ts`：Host 与 Runtime。
- `backend/test/modelLoopAgent.test.ts`、`domainAgents.test.ts`：Agent 执行。
- `backend/test/toolSkillRuntime.test.ts`：Tool 与 Skill 治理。
- `backend/test/sessionRuntime.test.ts`、`persistentAgentKernel.test.ts`：恢复和持久化。
- `backend/test/agentDelegation.test.ts`：委派边界；预中止、执行中止、忽略信号、持久化期间中止及真实父超时，拒绝假成功并保留原记录。
- `backend/test/externalAgent.test.ts`：HTTP Agent。
- `backend/test/agentControlPlane.test.ts`、`platformScope.test.ts`：控制面与隔离。
- `backend/test/multiBotIngress.test.ts`、`aiNewsRadar.test.ts`：多 Bot 入站和专用 Native Agent。

本批验证：`backend/test/projectVisibilityApi.test.ts` 覆盖插件关闭后的读写拒绝、文件边界、计划校验和审计；`frontend/src/pages/workspace/pages.test.mjs` 覆盖旧看板链接的所有权。配合后端全量回归、前端门禁和桌面/移动端浏览器验收。

## 变更记录

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-11-05 | 父中止参与实际等待；拒绝预取消执行和迟到成功，区分父中止与自身超时 | 委派五种中止回归、Runtime/Trigger/模型/Tool 专项、类型及后端全量回归 |
| 2026-11-05 | Host 跟踪插件 HTTP 和手动任务，拒绝已移除插件的旧入口 | 插件 Web/站会 API 专项、后端回归、前端检查及默认/空配置/MCP 浏览器验收 |
| 2026-11-05 | 接入可选 MCP 工具插件，升级标准 JSON Schema 校验，保持 Agent/Tool/Skill 共用参数边界 | MCP/Schema 专项、后端全量回归与官方文件服务实际读取/越界拒绝 |
| 2026-11-05 | Host 支持受 Scope 与生命周期约束的插件动作，复用现有 Capability 与 Runtime | 插件动作/API 专项、后端回归、前端检查与桌面/375px 浏览器验收 |
| 2026-11-05 | 修复已有 CLI 状态文件的文件检查释放 POSIX 会话锁，重复拒绝不能放行其他进程 | 本地状态与知识复核专项、类型检查、后端回归 |
| 2026-11-05 | 增加本地控制面、固定 Scope 运行与人工继续；区分 HTTP 与 SDK 插件组合 | 工作台专项、后端回归、前端检查与本地浏览器验收 |
| 2026-11-05 | 未配置默认飞书时支持本地启动；连接与就绪共用候选列表，拒绝部分凭据；增加 HOST 绑定 | 多机器人/健康回归、空库本地启动与 HTTP 就绪检查、后端全量回归 |
| 2026-11-05 | 扩展 Native 插件模型/Tool 服务、纯生成禁用人工输入函数选项；修复取消边界和统一超时原因 | RAG、模型循环、Tool/Skill 与后端全量回归、类型检查 |
| 2026-11-05 | 群业务调度改为可释放插件贡献，新增外部 AI Hot 调度插件；空组合不隐式执行群任务；停机等待本轮结束 | 调度/日历/插件回归、后端 428 通过 / 1 TAPD 跳过、类型检查 |
| 2026-11-05 | 插件扩展消息路由贡献；Host 停止先拒绝并等待在途确定性消息，再清理插件 | 消息插件、Host 和原业务回归；类型检查 |
| 2026-11-05 | 增加可信 YAML Agent 插件选择与本地/已安装包加载；未启用模块不导入，消息 AI/新闻分流检查实际 Capability | 配置加载、插件/Host 测试与后端全量回归 |
| 2026-11-05 | 用 Cordis 装配七个 Agent 插件，Host 去除业务 Agent 直接依赖；停止前等待在途执行，清理注册且保留运行数据 | 插件/Host 测试、后端全量回归 |
| 2026-08-03 | 飞书事件增加数据库跨实例原子去重；投递链路传递取消信号、供应商重试时间和按 App ID 隔离的额度错误 | `multiBotIngress.test.ts`、`deliveryOutbox.test.ts`、`externalApiHealth.test.ts` |
| 2026-07-29 | AI 新闻增加同会话续页、关键词/来源/信号追问；`article_list` 卡片展示多源信号并追加受控操作提示 | `aiNewsRadar.test.ts`、`routedFeishuDelivery.test.ts`、后端类型检查 |
| 2026-07-29 | AI 新闻默认复用 `bot-default`，增加确定性私聊意图分流；仅显式提供不同 App ID 时创建专用 Bot | `config.test.ts`、`multiBotIngress.test.ts`、`aiNewsRadar.test.ts`、`agentHost.test.ts` |
| 2026-07-29 | 增加每 BotInstance 独立飞书长连接、p2p 专用 Capability 路由，并注册 `native.ai-news-radar` | `multiBotIngress.test.ts`、`aiNewsRadar.test.ts`、`agentHost.test.ts` |
| 2026-07-29 | 增加 `AgentHostExtension` 本地装配入口；扩展只初始化一次，重复 ID 或注册失败时 Host 不进入就绪状态 | `agentHost.test.ts`、Agent 平台全量回归、后端类型检查 |
| 2026-07-27 | 注册 `native.weekly-report`，加入主 Agent 可委派 capability，并通过 Artifact/Outbox 投递周报链接 | `weeklyReport.test.ts`、`scheduler.test.ts`、Agent Host 回归 |
| 2026-07-22 | 补充 Manifest、Binding、Scope、委派和 Agent 化判断规则，精简文档结构 | CodeGraph 与 Agent Runtime 测试 |
| 2026-07-22 | 建立 Agent 平台功能卡，记录当前 Agent、Skill 判断和多机器人扩展点 | CodeGraph 架构审查 |

本地状态变更（2026-11-05）：新增可选 CLI SQLite 实现，知识与发布 Run 可跨进程保存；不改变默认团队应用的业务 Store。验证覆盖原子 KV、外部文件拒绝、独占进程及已提交记录恢复。
