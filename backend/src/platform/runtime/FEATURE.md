---
feature_id: operations-observability
name: 运行控制与可观测性
status: active
agent_mapping: []
last_reviewed: 2026-11-05
---

# 运行控制与可观测性

统一记录审计日志、消息上下文、Job/Trigger/Agent Run、Artifact 和 Outbox 投递，并提供后台查询与手动验证入口。

## 功能定位

运行控制与可观测性把一次业务动作拆成可追溯的事实链：谁触发、系统怎样路由、Agent 或服务执行了哪些步骤、生成了什么产物、消息是否真正送达。它解决的是定位和恢复问题，而不是业务展示问题。

系统刻意分开 Trigger、Run、Artifact 和 Outbox 状态。这样可以准确区分“未开始”“执行失败”“执行成功但投递失败”和“已经送达”，避免管理员只看到一个模糊的成功布尔值。

## 实现流程图

```mermaid
flowchart TD
    R["Host 启动"] --> S["收敛上次进程遗留的运行中记录"]
    R --> Q["/healthz 进程存活"]
    R --> OAPI["/api/swagger API 文档"]
    S --> P["Cordis 插件装配与配置恢复"]
    P --> MR["装配可释放消息贡献"]
    MR --> BC["requiredBots：仅要求已配置的入站连接"]
    BC --> Z["/readyz 数据库 + Agent Host + 必需连接就绪"]
    P --> SJ[装配群业务计划与轮询]
    SJ --> Z
    S --> A["消息 / Scheduler / API"]
    A --> WOWN[插件声明的 Web 页面、API 与手动任务]
    WOWN --> PV[看板文件读取与甘特计划；缺少所有者返回 404]
    PV --> PA[TaskService 计划审计；保留历史数据]
    WOWN --> EMAIL[纪要邮件：真实服务接受后记录标记与审计]
    EMAIL --> UNCERTAIN[接受后保存失败显式返回；当前进程不重发]
    WOWN --> B["Trigger / Job Execution"]
    B --> C["Agent Run / 业务服务"]
    C --> AB[父中止或自身超时：停止等待并拒绝迟到成功]
    AB --> AFAIL[失败 Run / Agent Step / 委派 Step；无成功返回产物]
    C --> SC[Agent / Tool / Skill 标准 JSON Schema 校验]
    SC --> C7[标准 Skill 与社区 MCP 工具调用]
    C7 --> TC
    SC --> TC{"Tool 调用前已取消?"}
    D --> MCP[可选 stdio / HTTPS MCP：错误、取消和超时显式失败]
    MCP --> MHTTP[HTTP 固定 IP/TLS、无重定向与有界响应；凭据引用不进产物]
    TC -- 是 --> TR["TOOL_CANCELLED：不进入 Handler"]
    TC -- 否 --> L{"Run Tool 预算内?"}
    L -- 是 --> D["Step / Tool Call / Audit"]
    L -- 否 --> M["Guardrail Step / 明确失败"]
    C --> E["Artifact"]
    C --> F["Outbox Message"]
    F --> G["Delivery Worker 串行 drain"]
    G --> H{"投递成功?"}
    H -- 否 --> I["退避重试 / 失败状态"]
    H -- 是 --> J["Delivered"]
    D --> K["Logs / Contexts / Debug 页面"]
    A --> X["消息处理失败分类审计"]
    X --> K
    A --> COL[网页收集 / 文档暂存 ID 转换]
    COL --> B
    A --> KW[可选知识工作台入口；描述失败不执行检索]
    KW --> B
    E --> RELEASE[发布结果：证据/不足/待复核/草稿面板与 Markdown；不代表已发布]
    RELEASE --> WA
    E --> WA[本机工作台：插件动作与上次检查时间]
    WA -- 显式执行 --> A
    WA --> IC
    E --> KS[可选 CLI 私有 SQLite 状态]
    KS --> IC[实际知识引用复核与独立评估]
    E --> K
    I --> K
    J --> K
    G --> Y["飞书/TAPD 接口级计数、耗时与失败率"]
    Y --> Z1{"应用额度熔断?"}
    Z1 -- "是" --> I
    Z1 -- "否" --> K
    COL --> KLIB[明确收录原产物；私有资料与后续检索]
    D --> QVS[每次实际调用的执行版本与序列化指纹]
    QVS --> QCR[保存记录结构验收；独立报告]
    E --> QCR
```

## 能力边界

### 目标

- 回答“谁在何时、以什么输入、调用了什么、产生了什么结果、是否投递成功”。
- 允许管理员查询上下文、日志和运行状态，并安全地触发诊断动作。

### 非目标

- 日志和页面不拥有业务状态，不用于修补任务或站会真相源。
- 可观测性不是独立 Agent；它是所有 Agent 和确定性流程共享的平台能力。

## 工作台入口

MCP 在线连接不增加新的执行状态机：公开 HTTPS 经与 stdio 相同的 Tool Gateway、Scope、预算及 Tool Step，固定工具调用的错误/超时/取消均失败。HTTP 连接自己校验 DNS、固定 IP/TLS 与响应预算，停止尝试终止本客户端会话并关闭本地流；失败清理不删除运行历史。HTTP JSON/SSE、字节超限、重定向、流取消和会话测试见 backend/test/mcpHttp.test.ts；官方 Context7 实际查询为 1 次工具/0 次模型，不代表所有服务或远端取消均已验证。

新增本地工作台：最近 50 个根 Run、结果/步骤/详情和人工继续；Run 列表与 Artifact 查询固定默认 workspace/bot。运行入口使用 manual Trigger 和 none 回复策略，Tool 自身仍可能写业务数据。管理 API（包括既有 Run 详情）统一检查本机 Host/Origin，防止其他网站读取本地个人产物。HTTP 默认监听 127.0.0.1。连接保存与实际运行状态分开呈现，见 [工作台功能卡](../workspace/FEATURE.md)。

发布准备通过插件拥有的 /release 表单复用 manual Trigger、Run 和 Tool/Model Step。收集不调用模型，生成始终需要人工复核；证据不足或预算超限仍是执行完成的资料结果，与 Run 执行失败区分。结果将通用状态面板置于正文前，避免存储的同时间产物顺序掩盖状态；只使用既有通用状态面板/Markdown 协议，JSON 完整证据保留在详情；本地 GitHub 密钥不回显。验证覆盖 workspace/release 专项与前端日期边界。

知识库页面与描述 API 由 knowledge.workspace 所有；卸载界面不删除运行记录或底层来源能力。页面明确选择来源并核对回答插件依赖，描述错误时不使用缓存来源发起新任务。知识请求仍复用原 Run/Artifact，无新状态机；专项覆盖来源并存、生命周期与只读 API 边界。

群成员后台同步在单群失败、无成员变化时仍记录带失败结果的 group_members_sync，不把静默无更新当作读取成功；原成员保留。验证见 backend/test/groupMembers.test.ts。

新增网页收集与文档转换仍使用同 Run 的工具步骤与来源 Artifact；不以上传完成冒充转换成功。Markdown 结果可复制和下载，JSON 保留来源与版本。文档原始暂存消费后删除，最终来源指纹及转换结果依宿主保留；转换无正文、超限或取消不发布成功产物。验证包括真实 MarkItDown PDF/DOCX/PPTX/XLSX 与公开网页边界。

## 核心规则

Native 插件可以使用宿主 Orchestrator/Tool Gateway 组合执行；RAG 回答把检索、模型步骤与带版本证据的 Artifact 归入同一 Run。引用核验只证明身份和精确引文存在，不代表结论语义已验证。模型步骤失败时不发布答案。

Tool 在已取消请求或领取账本期间收到取消时不进入 Handler；领取过的调用写入失败状态。超时和协作取消共享 TOOL_TIMEOUT 原因，不把取消当作成功，也不能据此声称外部副作用已回滚。

Agent 的父中止同样是实际执行边界：预中止不进入 Adapter，执行中即使 Adapter 不响应也停止等待，接收结果及成功状态写入前再次核对。父中止为 PARENT_ABORTED/不可重试，自身截止为 TIMEOUT/可重试；Run、Agent Step 与委派 Step 记录失败并保留执行快照。失败返回不向上层交付成功产物；已持久化事实仍保留，不声称回滚原生代码或已经发出的外部操作。验证：backend/test/agentDelegation.test.ts 五种中止情形及 agentRuntime.test.ts。

父子共享截止时间时，计时器触发顺序依运行环境而定：父信号先中止为 PARENT_ABORTED，子计时器先到期为 TIMEOUT。两种路径均为失败，不能根据测试平台假定其中一个必然先发生。

超时依据请求中同一个绝对 deadlineAt。步骤保存耗时会减少剩余预算，计时器和执行/结果边界均核对该截止时间；事件循环延迟或保存较慢不能使已过期结果进入成功状态。慢保存回归见 agentRuntime.test.ts。

Host 关闭时先停止消息注册表接受新执行，等待在途确定性消息、调度轮次与 Agent Run、投递收敛后再释放插件。停用功能删除其内存消息贡献，不删除历史来源消息、引用、运行和业务数据；历史引用本身不会重新启用功能。

1. **记录事实并执行有界保留。** Run、Step、Tool Call 采用追加式记录；Audit Event 默认保留 90 天，过期记录由每日维护任务分批删除，修复动作仍产生新事件而不覆盖原始证据。
2. **不同状态机分别保存。** Job Execution 表示调度尝试，Agent Run 表示执行，Artifact 表示产物，Outbox 表示外部投递；它们用关联 ID 串联。
3. **每条链路携带相关标识。** root Run、parent Run、trigger、group、bot 和 correlation ID 支持从用户消息追踪到最终投递。
4. **Outbox 使用持久化领取、真实时间租约和进程内串行 drain。** 同一进程的后台轮询与主动 flush 共用一个进行中 Promise，不能并发领取；租约从实际领取时间计算，不能复用较早的业务触发时间。同一条消息只允许一个 Worker 在租约期内处理；Worker 崩溃后其他实例可以重新领取。
5. **重试不重新执行业务。** 临时投递错误只重试 Outbox；永久错误进入失败或死信状态，不能重新运行 Agent 来碰运气。
6. **查询严格按 Scope 过滤。** 日志、上下文和 Run Detail 不能因为是后台接口就跨 workspace、group 或 bot 暴露。
7. **日志默认脱敏。** Token、Secret、邮箱凭据、完整附件和不必要的 Prompt 内容不得写入审计或错误信息。
8. **Debug 是受控新执行。** 手动触发必须指定已注册的 Job/Agent 与参数，并产生新的执行记录；它不能运行任意命令或直接篡改历史状态。手动 Job 的 `sendToGroup` 默认关闭，只有明确打开时才创建群消息投递，关闭时仍保留业务生成/更新和审计事实。
9. **监控失败需要显式暴露。** 非关键审计写入失败可避免阻塞主业务，但系统必须记录或告警；关键合规动作应使用事务或 Outbox 保证证据落盘。
10. **飞书令牌按有效期复用。** Adapter 在提前量内缓存 tenant access token，并合并并发刷新请求；发送失败仍按消息投递结果处理，不能通过每次重新申请令牌规避权限或接收人错误。
11. **部分完成不是成功别名。** Job 完成业务扫描但存在跳过、临时投递失败或永久拒绝时记录 `job_completed_with_warnings`，查询页面显示“任务部分完成”；同步等前置条件失败仍记录 `job_failed`。
12. **查询参数必须有边界。** 日志和上下文分页每页最多 200 条，非法页码回落到安全默认值；日期筛选按 `Asia/Shanghai` 自然日转换成 UTC 左闭右开区间，非法或反向日期返回 400。
13. **日志清理不能阻塞业务调度。** 每日维护按配置时区领取一次执行，单批和单次总批数均有上限；失败只写维护失败事实，不中断站会、日报、周报或提醒任务。
14. **Tool 调用预算覆盖完整 Run。** `AgentManifest.limits.maxToolCalls` 同时约束模型直接调用和 Skill 内部调用；暂停恢复或同一 Run 再进入时从已持久化 Tool Step 恢复用量，幂等命中旧结果不重复扣减，超限写 `guardrail` Step 并返回不可重试错误。
15. **进程重启必须收敛非终态。** 单实例 Host 接收新触发前，将上次进程遗留的 `queued/running` Run、运行中 Step、Tool Call 和 Trigger 原子标记为 `PROCESS_RESTARTED`；`waiting_human`、成功记录和 Outbox 租约保持原语义，不自动重放可能已产生副作用的操作。
16. **存活与就绪必须分离。** `/healthz` 只证明 HTTP 进程可响应，供 liveness 使用；`/readyz` 必须同时验证 SQLite 可查询且 Agent Host 已初始化并启动，失败返回 503，供 startup/readiness 在依赖异常时停止接收流量。探针响应不暴露数据库路径或底层错误。
17. **CI 是质量检查，不代表部署。** 当前 GitHub Actions 运行锁定安装、后端 Prisma/类型/测试、前端 lint/类型/测试/构建、Docker 构建与秘密扫描；不连接服务器、不推送生产镜像，也不证明线上业务可用。按用户当前要求不部署服务器。
18. **Host 仅在扩展装配完整后就绪。** 本地 `AgentHostExtension` 在 Runtime 创建前串行注册且每个唯一 ID 只执行一次；任何扩展校验或注册失败都会阻止 `initialized=true`，从而使 `/readyz` 保持失败。
19. **入站和投递幂等必须包含 BotInstance。** 飞书事件的进程内缓存键使用 `botInstanceId:messageId`，持久化 Trigger Claim 使用 workspace、bot、trigger type、message ID；两个应用即使产生相同 message ID 也不能互相吞消息。
20. **私聊目标必须显式保存 channel。** `ReplyPolicy` 的配置目标可声明 `private` 或 `group`；新闻机器人使用发送者在该应用下的 OpenID 作为 private 目标，不能根据存在 `chatId` 就推断为群聊。
21. **结构化文章产物由 Adapter 生成最终提示。** AI 新闻 Artifact 保存文章、来源与是否还有下一页等结构化事实；飞书 Delivery Adapter 统一渲染安全链接、多源信号和固定操作引导，外部 Provider 不能注入卡片尾部指令。
22. **AI 异常必须留下可查询根因和降级结果。** 消息处理的兜底回复前写入 `message_processing_failed`，保留消息和群标识、脱敏后的错误摘要及分类；AI 429 不能混同为网络超时。任务命令、日报、站会自然语言解析、站会主/补充汇总和周报分别记录对应 AI 失败事件，统一使用 `rate_limited`、`timeout`、`invalid_response`、`unavailable` 分类和明确的 fallback 字段，形成“AI 失败—规则继续执行或拒绝保存”的证据链。
23. **日志状态必须区分失败与成功降级。** AI 调用失败但 `fallback` 已生成日报、站会或周报时，日志页使用橙色“已降级”标签；只有规则也未完成、解析被拒绝或 Job 最终失败时使用红色失败标签，不能用底层事件名误导管理员。
24. **外部 API 必须按接口和应用统计。** 飞书与 TAPD Adapter 统一记录调用次数、计费调用估算、成功/失败、平均/最大耗时和最近失败时间；动态资源 ID 在聚合前归一化。飞书按 App ID 分开统计并以 100 万次/月作为基础版风险参考，运行不足一小时不输出误导性的月度投影。
25. **飞书限流和额度耗尽必须分流。** HTTP 429 保留 `Retry-After` 供 Outbox/调度退避；业务码 `99991403` 视为当前应用月额度耗尽，熔断至下一个上海时区月初并标记不可重试，不能让一个应用的熔断阻断其他 BotInstance。
26. **投递超时必须取消底层请求。** Delivery Worker 的 AbortSignal 必须传到飞书文本、卡片、图片上传和图片发送请求；超时后不能保留后台请求并同时创建重试，从而造成幽灵双发。
27. **入站事件使用跨实例原子去重。** 收到飞书 message ID 后，以 workspace、BotInstance 和 message ID 组成 `feishu:event:` 幂等键并由数据库原子领取；进程内有界缓存只作为同实例快速路径，不能作为生产集群唯一去重机制。
28. **重复触发不等于再次完成。** Agent Trigger Store 返回 `duplicate` 时，Scheduler 只记录 `job_duplicate_skipped`，不能追加第二条 `job_completed`；日志页明确显示“重复触发已跳过”，避免把幂等命中误读成业务再次执行。
29. **API 文档必须经过生产代理可达。** Swagger UI 使用 `/api/swagger`，OpenAPI JSON 使用 `/api/swagger/json`；两者统一放在生产环境已转发到后端的 `/api` 前缀下，不能使用会被前端 SPA 接管的根路径 `/swagger`。

## 本地启动与就绪

默认飞书 App ID/Secret 都未配置时不创建连接，`/readyz` 的必需连接数为零；Agent Host 与数据库仍须真正就绪。部分凭据、错误 App ID 和已启用其他机器人的连接错误仍导致启动失败。连接启动与就绪共用 `FeishuBotConnectionManager.requiredBots()`。本地 `.env.example` 通过 `HOST=127.0.0.1` 限制监听地址；API 尚未提供登录认证。参见 [本地运行](../../../../docs/LOCAL_DEVELOPMENT.md)。

## 本地历史复核

CLI 可选 --state 保存 Run/Step/Tool/Artifact；默认仍为内存。知识影响插件只读原 Artifact 的实际引用并独立写评估，不修改旧证据。作用域先验证 workspace/bot，再读取目标产物。评估 revision 经 CAS 竞争，旧检查不能覆盖新检查；来源失败、旧格式或中断不能显示为 current。单一活跃状态会话通过 SQLite 独占锁保证，避免把另一个 CLI 的运行误判为重启遗留。

## 工作台后续动作与证据

成功 Run 可显示插件贡献的动作。GET 仅查询缓存状态并显示检查时间，不刷新来源或新建 Run；POST 经固定 Scope、插件指定输入和已启用 Capability 创建新执行。UUID 幂等键同时绑定动作和目标。知识复核记录独立 Run/Artifact 与最近评估，不把原运行的 succeeded 改为失败，也不覆盖旧正文或引用。检查中的状态、读取失败、需要复核和版本未变化分开展示；新版状态协议无效时回退原始产物。Host 停止等待在途状态读取后再释放插件。

## MCP 与标准契约记录

可选 stdio 连接工具同样经过 Tool Gateway 并产生 Tool Step；示例 Agent 形成正常 Run 和 Artifact，不以协议握手成功冒充业务成功。isError、结构化输出错误、超限、进程退出和超时不生成成功产物；取消通知不证明服务内部已停止。Host 等待在途 Run 后清理服务。Agent/Tool/Skill 共用标准 JSON Schema 校验，新增联合类型、引用、额外字段和边界约束；非法 Schema 失败关闭，校验错误文案随标准实现更新。

## 插件 Web 与手动执行

手动业务任务需要已装配插件声明所有权；未知名称为 400，已知但缺少所有者为 404，不创建执行器或产生业务副作用。日期、工作日、安全预览、sendToGroup 和原有审计语义保留。默认组合保留全部九项原有任务；空组合不暴露这些任务。

插件 HTTP 与手动任务由 Host 跟踪，在途执行结束后才释放插件。声明路由加入 OpenAPI，代理不预先解析/消耗 Request body。站会读模型接口迁移到 Owner 目录，页面查询不创建 Agent Run；统计与历史汇总的规则由 StandupService 维护。

## 社区 Skill 与 Context7 验证

标准 SKILL.md 可经 readAgentSkill 显式导入现有 Prompt Skill Runtime；元数据不能自动取得工具或 Agent 授权，不执行目录脚本。community.context7 是真实使用者：接入上游 MCP 两个读取工具，提供无模型查询和需模型的研究助手；页面按插件贡献，未知能力标签使用作者声明的 Agent 名称。默认组合不自动安装它。来源、许可、运行命令和验收边界见 [社区接入说明](../../../../docs/COMMUNITY_PLUGINS.md)。

验证：backend/test/context7Plugin.test.ts 覆盖格式/边界、权限不继承、受控 Prompt Skill 执行及插件装配；本地实际 MCP 与工作台验收覆盖公开文档检索。真实付费模型未调用。

knowledge.collect 只固定当前成功采集 Run ID，经 knowledge.library.manage 执行同 Scope 的一次 Tool；先校验原 Run，再读取唯一私有 Markdown。状态读取不创建 Run，保存结果单独记录，不改源 Artifact。重复、容量、文件安全与中断暂存恢复由资料库服务负责；原文检索及选择资料库后的回答/引用复核复用现有管线。验证：backend/test/knowledgeLibrary.test.ts。

每次 Agent 调用的运行中/成功/失败步骤均带独立 execution 1.0 快照，保留声明的身份与版本、Manifest/可序列化输入指纹；这不是完整执行环境快照，新增字段不保存原始输入。新 quality.checks 插件先验证全部目标归属和终态，再读取原记录做结构验收，报告与新增失败项单独持久化，不修改原证据或重执行任务。结构结果与验收 Run 状态分开；旧版本凭证缺失不可显示绿色通过。验证：backend/test/pluginChecks.test.ts 与 agentRuntime.test.ts。

## 用户能力

- 查看审计日志、消息上下文、Agent Run、Step、Artifact 和投递状态。
- 在 Debug 页面按明确参数手动运行 Job 或 Agent。
- 识别生成成功但投递失败、模型失败但业务已写入等部分成功状态。

## 入口与触发

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| 业务服务/Agent Runtime | Run、Step、Artifact、Audit Event | 持久化运行事实 |
| Delivery Worker | Outbox 状态、错误、重试次数 | 投递结果 |
| 后台 API/页面 | 时间、类型、群、Run ID 筛选 | 日志、上下文和运行详情 |
| Debug API | 明确 Job/Agent 与参数 | 新执行记录 |
| Kubernetes 探针 | `/healthz`、`/readyz` | 进程存活、数据库与 Agent Host 就绪状态 |
| 外部 API 健康接口 | `/api/health/external-api-usage` | 当前进程按供应商、应用、接口聚合的调用量、失败率、耗时、月度投影与熔断状态 |
| API 文档 | `/api/swagger`、`/api/swagger/json` | 可交互 Swagger UI 与机器可读 OpenAPI 文档 |

## 运行逻辑

1. 消息、Scheduler 或 API 建立 Trigger/Job Execution。
2. Runtime 和业务服务追加结构化 Run、Step、Tool Call、Audit 与 Artifact；消息处理异常在回复用户前追加带分类的 `message_processing_failed` 审计。
3. 外部消息先写 Outbox；后台轮询和主动 flush 通过同一个 Worker 串行 drain，以实际领取时刻建立租约，再执行投递、失败退避并保存结果。
4. 后端只返回当前 Scope 有权查看的记录。
5. Logs、Contexts 和 Debug 页面用于查询、关联和受控重放。
6. Host 重启时先收敛遗留非终态记录并追加恢复审计，再对外接受新的 Agent 调度。
7. Kubernetes 以 `/readyz` 控制启动和接流量，以 `/healthz` 判断是否需要重启进程。
8. 飞书/TAPD Adapter 在每次外部请求边界记录统一指标；飞书额度码按 App ID 打开熔断，投递重试读取供应商建议等待时间。

## Agent、Tool 与服务边界

| 对象 | 职责 | 禁止承担 |
| --- | --- | --- |
| Run/Trigger Store | 保存执行事实和状态转换 | 保存业务实体真相 |
| Audit/Context | 记录输入、路由和动作证据 | 保存 Secret 或完整敏感载荷 |
| Outbox/Worker | 至少一次尝试、退避和投递状态 | 无幂等地重新执行业务 |
| Debug API/Page | 受控触发和查询 | 接受任意代码、路径或命令 |
| 周报查看 API | 按持久化报告 ID 解析不可变 HTML | 接受客户端文件路径或目录遍历 |

## 本地状态锁保护

CLI 状态文件与会话锁文件仅在不存在时独占创建，创建/关闭在同步段内完成；已有文件通过 lstat 验证常规文件、单链接与私有权限，不额外打开并关闭它们。这样重复打开被拒绝后，不会因原始文件句柄 close 取消同进程的 SQLite POSIX 锁，另一进程仍不能进入活跃状态会话。

## 数据与状态

- Job Execution、Agent Run、Artifact 和 Outbox Message 具有独立状态机和关联 ID。
- Agent Tool 预算以持久化 `kind=tool` Step 为已用事实；Skill 只能使用共享预算，不能建立独立额度绕开 Agent 限制。
- 重启恢复只改变 Agent 平台运行记录，不修改任务、站会、消息、Checkpoint 或 Artifact；等待人工输入的 Run 保持 `waiting_human`。
- Outbox 至少一次投递要求目标端或消息键具备幂等语义；单进程内所有 drain 入口共用运行锁，租约时间不得早于实际领取时刻。
- 日志应使用结构化事件、相关 ID 和统一时间；保留期与清理策略需可配置。
- 默认保留最近 90 天审计日志；每批删除 500 条、每次最多 20 批，并清理过期 `scheduled:`、`maintenance:`、`feishu:event:` 与 `history-sync:` 临时幂等记录，业务消息和 Agent 历史不在本轮清理范围。
- 生产 SQLite 在应用启动前执行完整性检查和一致性备份，再运行非破坏性的 Prisma Schema 同步；全新数据目录先初始化有效空 SQLite 文件，避免 Schema Engine 无法创建首库；升级失败时应用不得带着未知数据库状态启动。

## 失败、安全与降级

- 日志必须脱敏 Token、Secret、邮箱凭据、完整 Prompt 和附件内容。
- 后台查询与 Debug 入口即使在内网也需限制来源/身份，并隔离 tenant/group/bot scope。
- 监控持久化失败不能阻塞关键业务写入，但必须有明确告警；审计要求高的动作应采用同事务或 Outbox 模式。
- 重放只重放安全、声明幂等的动作，不能简单重复整个 Run。

## 代码地图

### 主要实现

- `backend/src/platform/plugins/web.ts`、`backend/src/platform/workspace/jobsApi.ts`：声明路由、生命周期与手动授权。
- `frontend/src/pages/workspace/PluginPage.tsx`、`pages.ts`：页面解析、恢复入口与 Agent 导航。

- `backend/src/connectors/mcp/plugin.ts`、`backend/examples/plugins/mcp-reader.ts`：第三方工具接入与真实执行证据示例。
- `backend/src/platform/agents/schema.ts`：标准契约校验。

- `backend/src/platform/plugins/runActions.ts`、`backend/src/platform/workspace/api.ts`：插件动作与本机查询/执行入口。
- `frontend/src/pages/workspace/RunActions.tsx`、`panels.ts`：状态时间、检查记录与版本化展示。

- `backend/src/platform/persistence/sqliteStore.ts`：CLI 私有记录与会话锁。
- `backend/src/knowledge/impact/service.ts`：只读原引用与独立评估。
- `backend/test/localState.test.ts`、`backend/test/knowledgeImpact.test.ts`：持久化、范围、检查竞争与历史证据回归。
- `backend/src/platform/agents/runStore.ts`、`persistentRunStore.ts`：Agent 运行记录。
- `backend/src/platform/agents/modelLoopAdapter.ts`、`backend/src/platform/tools/budget.ts`、`gateway.ts`：Run 级 Tool 预算恢复、共享扣减与超限 Guardrail。
- `backend/src/platform/agents/persistentRunStore.ts`、`backend/src/platform/tools/callStore.ts`、`backend/src/platform/runtime/persistentTriggerStore.ts`、`interruption.ts`：进程重启后的原子状态收敛。
- `backend/src/platform/bootstrap/agentHost.ts`：恢复完成后再初始化 Runtime 与 Trigger 接入。
- `backend/src/platform/runtime/triggerRuntime.ts`、`persistentTriggerStore.ts`：触发记录。
- `backend/src/platform/bots/feishuBotConnectionManager.ts`、`feishuBotMessageIngress.ts`：bot-scoped 飞书入站、数据库原子去重、进程内快速去重和审计。
- `backend/src/platform/aiDegradation.ts`：AI 限流、超时、非法响应和不可用的统一分类与用户可见降级文案。
- `backend/src/platform/delivery/outbox.ts`、`persistentOutbox.ts`、`worker.ts`：可靠投递、可取消超时和供应商退避时间。
- `backend/src/platform/observability/externalApiHealth.ts`：飞书/TAPD 接口指标、应用维度月度投影与额度熔断状态。
- `backend/src/platform/observability/apiDocumentation.ts`：生产代理可达的 Swagger UI 与 OpenAPI 文档配置。
- `backend/src/adapters/feishu.ts`、`backend/src/adapters/tapd.ts`：统一外部 API 观测；飞书令牌缓存、限流/额度分类和可取消发送。
- `backend/src/services/jobExecution.ts`：Job 执行记录。
- `backend/src/core/logQuery.ts`：日志/上下文分页与北京时间日期范围规范化。
- `backend/src/core/dataRetention.ts`、`auditPayload.ts`：日志保留、临时幂等记录清理和敏感字段遮盖。
- `backend/src/core/sqliteDeployment.ts`、`backend/src/scripts/dbPush.ts`：SQLite 完整性检查、升级前备份和安全 Schema 同步。
- `backend/src/core/health.ts`、`backend/src/index.ts`：无敏感信息的存活/就绪探针，以及日志、上下文、运行与 Debug API。
- `deploy/k8s/30-deployment-backend.yaml`：startup/readiness 使用就绪探针，liveness 使用存活探针。
- `.github/workflows/ci.yml`：公共质量门禁与 Docker 构建验证；不推送镜像或部署集群。
- `frontend/src/pages/LogsPage.tsx`、`components/logs/LogsTable.tsx`、`constants.ts`：后台日志入口、AI 异常/规则降级的中文事件与摘要。
- `frontend/src/pages/ContextsPage.tsx`、`DebugPage.tsx`：后台入口。

### 主要测试

- `backend/test/pluginWeb.test.ts`、`backend/test/standupApi.test.ts`：停用拒绝、读取边界、OpenAPI 和在途收敛。
- `frontend/src/pages/workspace/pages.test.mjs`：路径解析、内部 Agent 链接与选中状态。

- `backend/test/jsonSchema.test.ts`、`backend/test/mcpConnector.test.ts`：Schema、错误/取消与外部进程退出，不产生假成功。

- `backend/test/runActions.test.ts`、`backend/test/workspaceActions.test.ts`：状态不创建 Run、原证据不变、Scope/幂等与停机等待。
- `frontend/src/pages/workspace/panels.test.mjs`：无效展示协议回退。

- `backend/test/knowledgeAnswer.test.ts`：RAG 检索/模型/Artifact 证据、伪造引用拒绝和重复 Trigger 不重复生成。
- `backend/test/toolSkillRuntime.test.ts`：取消与领取竞争的处理边界。
- `backend/test/schedulePlugins.test.ts`：调度计划失败隔离、原子领取与停机等待；原 Scheduler 测试覆盖重试和警告语义。

- `backend/test/messagePlugins.test.ts`：在途确定性消息收敛、停机拒绝新执行与历史上下文禁用。

- `backend/test/deliveryOutbox.test.ts`、`routedFeishuDelivery.test.ts`：投递、供应商退避、底层取消和 Bot 路由。
- `backend/test/externalApiHealth.test.ts`：接口归一化、应用隔离、指标和熔断分类。
- `backend/test/persistentAgentKernel.test.ts`、`triggerRuntime.test.ts`：运行持久化。
- `backend/test/modelLoopAgent.test.ts`、`toolSkillRuntime.test.ts`：跨恢复 Tool 预算、Skill 共享额度和幂等去重。
- `backend/test/persistentAgentKernel.test.ts`、`agentHost.test.ts`：遗留状态恢复、终态保护、人工等待保护和 Host 启动顺序。
- `backend/test/jobExecution.test.ts`、`storage.test.ts`、`logQuery.test.ts`：执行记录、存储与查询边界。
- `backend/test/dataRetention.test.ts`、`maintenanceScheduler.test.ts`：保留边界、批量上限、每日幂等和失败隔离。
- `backend/test/sqliteDeployment.test.ts`：升级前备份、保留数量和损坏数据库拒绝。
- `backend/test/health.test.ts`：存活、数据库异常和 Agent Host 未启动时的就绪判定。
- `backend/test/apiDocumentation.test.ts`：Swagger UI、OpenAPI JSON 与已注册 API 路由生成。
- `backend/test/multiBotIngress.test.ts`、`triggerRuntime.test.ts`：跨 Bot 幂等和显式 private 投递目标。

本批验证：`backend/test/projectVisibilityApi.test.ts` 覆盖插件关闭后的读写拒绝、文件边界、计划校验和审计；`frontend/src/pages/workspace/pages.test.mjs` 覆盖旧看板链接的所有权。配合后端全量回归、前端门禁和桌面/移动端浏览器验收。

## 变更记录

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-11-05 | 插件页面与手动任务只显示已启用贡献；停机等待、原有审计与预览规则保留 | 插件 Web/站会 API 专项、后端回归、前端检查及默认/空配置/MCP 浏览器验收 |
| 2026-11-05 | MCP 工具复用 Run/Step 证据，标准 Schema 校验拒绝额外参数与不兼容输出 | MCP/Schema 专项、后端全量回归与官方文件服务实际读取/越界拒绝 |
| 2026-11-05 | 新增插件动作的独立执行与只读状态；知识引用评估在工作台保留原始证据 | 插件动作/API 专项、后端回归、前端检查与桌面/375px 浏览器验收 |
| 2026-11-05 | 修复已有 CLI 状态文件的文件检查释放 POSIX 会话锁，重复拒绝不能放行其他进程 | 本地状态与知识复核专项、类型检查、后端回归 |
| 2026-11-05 | 新增工作台运行视图与管理 API 本机来源边界 | 工作台专项、后端回归、前端检查与本地浏览器验收 |
| 2026-11-05 | 无飞书凭据也可启动本地管理界面，就绪只要求已配置的入站连接；支持 HOST 指定绑定 | 多机器人/健康回归、独立空库 HTTP 验证、后端全量回归 |
| 2026-11-05 | Native RAG 保存同一 Run 的检索、生成和验收证据；修复预取消/领取中取消仍执行 Tool 的竞态 | RAG、Tool/Skill、模型循环与后端全量回归、类型检查 |
| 2026-11-05 | Host 等待在途群调度后释放插件，应用退出先等待 Scheduler；计划/轮询失败单独审计，旧幂等键保留 | 调度与插件回归、后端 428 通过 / 1 TAPD 跳过、类型检查 |
| 2026-11-05 | 消息贡献随插件回滚与释放；停机等待在途确定性消息并保留持久化事实 | 消息插件/Host 回归、后端 422 通过 / 1 TAPD 跳过、类型检查 |
| 2026-11-05 | 增加可信 YAML Agent 插件选择与本地/已安装包加载；未启用模块不导入，消息 AI/新闻分流检查实际 Capability | 配置加载、插件/Host 测试与后端全量回归 |
| 2026-11-05 | Host 改为选择插件组合后接入 Runtime；启动失败释放贡献，停止先等待在途 Run 与 Worker，再释放插件，持久化历史保留 | 插件/Host 测试、后端全量回归 |
| 2026-11-05 | 修复通用 `logs/` 忽略规则误排除前端日志组件的问题；将筛选与表格源码纳入公开仓库，确保干净检出能构建 | 干净 Git 归档的前端类型检查、测试与构建；GitHub CI |
| 2026-07-29 | 公司部署流水线替换为公共 GitHub Actions 质量门禁，不再自动推送镜像或修改集群 | Workflow YAML、Docker 构建验证 |
| 2026-08-04 | 将 Swagger UI 和 OpenAPI JSON 从被前端 SPA 接管的 `/swagger` 移到生产代理可达的 `/api/swagger` 与 `/api/swagger/json` | `apiDocumentation.test.ts`、后端类型检查 |
| 2026-08-04 | 修复定时报告生成超过 Outbox 租约后，后台 Worker 与主动 flush 并发重领造成的重复发送；所有 drain 串行化并以真实刷新时间领取，重复 Agent Trigger 改记“重复触发已跳过” | `deliveryOutbox.test.ts`、`scheduler.test.ts`、后端类型检查 |
| 2026-08-03 | 数据保留任务纳入日报历史补齐完成键，避免持久化增量缓存无限增长 | `dataRetention.test.ts` |
| 2026-08-03 | 增加飞书/TAPD 接口级健康统计；飞书按应用识别 429 与月额度耗尽并熔断，投递超时下传取消信号，入站事件改为数据库跨实例去重 | `externalApiHealth.test.ts`、`deliveryOutbox.test.ts`、`multiBotIngress.test.ts`、`scheduler.test.ts`、后端类型检查 |
| 2026-07-31 | 日志页将已生成确定性结果的日报、站会主/补充汇总和周报改为橙色“已降级”，保留自然语言解析与最终 Job 失败为红色 | 前端 `typecheck` / `lint` / `build` |
| 2026-07-31 | AI 降级分类扩展到日报、站会解析/汇总和周报；日志页增加对应中文事件与规则兜底摘要，业务消息同时公开降级状态 | `summaries.test.ts`、`jobs.test.ts`、`standupHandler.test.ts`、`weeklyReport.test.ts`、前端检查 |
| 2026-07-31 | 消息入口在兜底回复前记录 `message_processing_failed`；AI 429 显式归类为 `ai_rate_limited`，日志页以中文展示 AI 失败、规则降级和真实根因 | `messageHandler.test.ts`、前端 `typecheck` / `lint` / `build` |
| 2026-07-29 | `article_list` 投递增加多源信号展示和固定尾部操作提示，保留原 Outbox、同 Bot 路由和链接安全校验 | `routedFeishuDelivery.test.ts`、AI News Agent 回归 |
| 2026-07-29 | 飞书入站去重加入 BotInstance，ReplyPolicy 支持显式 private 目标，AI 新闻产物经持久化 Outbox 使用同一机器人回传 | `multiBotIngress.test.ts`、`triggerRuntime.test.ts`、`routedFeishuDelivery.test.ts` |
| 2026-07-29 | 将本地二开扩展纳入 Host 启动边界，扩展失败时不对 readiness 报告就绪 | `agentHost.test.ts`、`health.test.ts` |
| 2026-07-29 | 发布流水线增加后端与前端完整质量门禁，Kubernetes 改为部署提交 SHA 镜像并移除冗余强制重启 | 本地复现全部门禁、Workflow YAML 离线解析 |
| 2026-07-29 | 拆分 `/healthz` 存活探针与 `/readyz` 就绪探针；Kubernetes 仅在 SQLite 可查询且 Agent Host 已启动时接入流量 | `health.test.ts`、后端类型检查、Kubernetes 清单校验 |
| 2026-07-29 | Host 启动前原子收敛上次进程遗留的 Run、Step、Tool Call 和 Trigger；不自动重放写操作，不关闭 `waiting_human` | `persistentAgentKernel.test.ts`、`agentHost.test.ts`、后端类型检查 |
| 2026-07-29 | 将 Agent `maxToolCalls` 落为 Run 级共享硬上限，覆盖直接 Tool 与 Skill 内 Tool；恢复时依据持久化 Step 延续计数，超限记录 Guardrail | `modelLoopAgent.test.ts`、`toolSkillRuntime.test.ts`、后端类型检查 |
| 2026-07-29 | 增加 90 天审计日志保留、500 条分批清理、每日维护幂等和秘密字段遮盖；维护失败不再影响业务 Scheduler | `dataRetention.test.ts`、`maintenanceScheduler.test.ts`、Scheduler 回归 |
| 2026-07-29 | 容器启动改为先校验并备份 SQLite，再执行不接受数据丢失的 Prisma Schema 同步；全新 PVC 先初始化有效空库，损坏或同步失败时拒绝启动 | `sqliteDeployment.test.ts`（含真实 Prisma 首次及二次同步）、后端类型检查 |
| 2026-07-27 | 日志与上下文查询限制单页最大数量，并按北京时间自然日生成 UTC 左闭右开筛选区间；非法日期返回 400 | `logQuery.test.ts`、类型检查 |
| 2026-07-27 | 超期扫描暴露投递统计和部分完成状态；永久接收人错误与临时错误分开审计，日志页增加对应中文标签 | `scheduler.test.ts`、`jobs.test.ts`、前端类型检查 |
| 2026-07-27 | 恢复 tenant access token 有效期缓存，并合并并发刷新，避免定时任务密集发送时重复申请令牌触发限流 | `adapters.test.ts` |
| 2026-07-27 | 周报 Agent 接入 Trigger/Run/Artifact/Outbox；查看 API 通过数据库记录与目录边界校验解析 HTML | `weeklyReport.test.ts`、Agent Runtime 回归 |
| 2026-07-22 | 补充执行事实链、状态分离、租约和重试规则，精简文档结构 | CodeGraph 与持久化投递测试 |
| 2026-07-22 | 建立运行控制与可观测性功能卡 | CodeGraph 架构审查 |
