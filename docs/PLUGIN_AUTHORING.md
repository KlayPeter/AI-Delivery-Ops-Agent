# 功能插件规范 v1

当前 SDK 面向本仓库内或由部署者审查的 TypeScript 原生插件。使用 Cordis 4.1.0，协议版本为 `1.0`。现阶段提供 Agent、Tool、Skill、消息路由、群业务调度和运行后续动作的独立装配、依赖校验和资源清理；页面、业务 API 与审计维护也由插件贡献；旧业务服务已按需移到应用装配，固定飞书入站/投递通道继续按路线图收尾。

## 包结构

```text
my-feature/
  index.ts       # 导出 FeaturePlugin
  README.md      # 安装、配置、能力与已知限制
  FEATURE.md     # 功能边界、流程、数据和验证
  test/          # 合法输入、非法输入、失败与清理场景
```

对外分发时还应提供许可证、源码地址、固定版本和权限说明。插件描述与测试结果不能替代部署者对原生代码的审查。

## 最小插件

可运行模板见 [echo.ts](../backend/examples/plugins/echo.ts)，其测试通过真实 Host、Trigger、Run 与 Artifact 链路执行，无需模型或飞书凭据。复制模板后替换插件身份、Agent 契约和 handler，不需要修改 Host。

```ts
import { AgentHost } from './src/platform/bootstrap/agentHost';
import { echoPlugin } from './examples/plugins/echo';

const host = new AgentHost(getContext, 1000, undefined, [], {
  plugins: [echoPlugin],
  pluginConfig: {},
});
await host.initialize();
// 使用 host.dispatch 创建受持久化和作用域约束的执行。
await host.stop();
```

`getContext` 提供当前应用的 `HandlerContext`。现阶段插件 SDK 仍依赖已有应用服务，不是已发布的通用 npm SDK。应用默认组合使用 `createDeliveryOpsHost`，保留七个业务 Agent；直接构造 `AgentHost` 默认不装配业务功能。

较完整的独立例子见 `backend/src/knowledge/markdown/plugin.ts`：使用现有接口声明配置、Native Agent 和两个只读 Tool，不修改 Host。它不在默认团队组合中；本地运行方式见[个人知识库指南](PERSONAL_KNOWLEDGE.md)。

组合示例见 `backend/src/knowledge/answer/plugin.ts`：声明来源依赖，经过宿主 Tool Gateway 检索，再通过 Orchestrator 生成，并在发布前核验引用。

## 用配置文件选择 Agent 插件

从 `backend` 目录启动时，可设置：

```bash
AGENT_PLUGINS_FILE=profiles/agents/team.yaml bun run dev
```

团队 SDK 未指定插件时仍为十五个插件、七个 Agent；HTTP 工作台默认只装配选定知识来源、回答、复核、知识界面、网页收集、文档导入、资料库、结果验收、MCP 接入助手、个人研究及任务配方，共十六个插件、九个 Agent；配置 GitHub 发布组合后为 18 个插件、10 个 Agent。HTTP 不再隐式装配团队能力；使用 profiles/agents/team.yaml 可显式选择十二个功能/平台插件及三个模型插件。会议纪要和外部 AI Hot 调度插件没有独立 Agent。会议纪要仍受原有模块开关控制，外部 AI Hot 能力仍需另行安装。示例还包括 `profiles/agents/native-demo.yaml`、`profiles/agents/empty.yaml` 和 `backend/examples/plugins.collectors.yaml`，分别选择 Echo 模板、零业务插件和采集/资料库三个插件。显式插件文件完全决定组合；未装配的插件页面和 API 不开放，基础服务仍由应用拥有。

```yaml
apiVersion: '1.0'
plugins:
  - module: builtin.task
  - module: ./plugins/my-feature/index.ts
    config:
      environment: test
  - module: ./plugins/temporarily-disabled/index.ts
    enabled: false
```

`module` 可以是内置插件 ID、本地文件路径或已安装的 npm 包。相对文件路径以 YAML 文件所在目录解析；外部模块导出 `default FeaturePlugin`，或具名导出 `manifest` 与 `apply`。配置按声明的依赖排序，YAML 行顺序不决定初始化顺序。未启用的外部模块不导入，未选择的内置插件不执行装配；依赖仍然要求显式选择，缺失时拒绝启动。例如删除任务插件时，也要删除依赖它的主编排插件，或选择不依赖任务的编排实现。

配置文件属于部署者的受信任代码装配入口，修改后重启生效。模块导入会执行其顶层代码，因此只选择已审查的本地文件或依赖；HTTP、Git 和其他 URL 不直接执行，也不会自动安装包。新插件的 Secret 仍应使用引用。

### 在个人工作台上追加插件

```yaml
apiVersion: '1.0'
base: personal
plugins:
  - module: ./examples/plugins/echo.ts
```

显式配置只有声明 base: personal 才继承当前本机个人预设；未声明的旧文件仍完整替换。基底在重启时按本机来源与 GitHub 设置生成，不是冻结环境；追加插件重复 ID 拒绝，不覆盖基底，不递归继承其他文件或合并团队/自定义组合。 HTTP 与根目录 local 启动使用 loadWorkspacePlugins；直接调用 loadPluginConfiguration 时需提供可信 personalBase 回调，否则在模块导入前拒绝。未选择此基底时不读取个人设置。base 仅接受 personal，不接受路径或其他预设。新增插件可依赖基底插件，enabled:false 只跳过该追加项，不能移除基底。

Skill、MCP 和 OpenAPI 的导出页面都可显式保留个人工作台；它们只追加各自模块，不自动合并之前的自定义附加插件。需要同时使用多种能力时，在一份已审查配置中声明一次 base: personal，合并各自 plugins 项并保留完整 config；所有相对 module 路径须以最终文件目录解析。相同插件 ID 只能出现一次，例如多个 MCP 服务应合并到同一个 connector.mcp 的 servers，而不是重复注册连接器。基底中的 mcp.setup 不再追加。

实际验证已将 MCP 与 OpenAPI 两份个人导出的四个追加模块放在同一个 examples/*.local.yaml 中，十八插件十二 Agent 同时装配并成功运行 MCP、固定 GET 和知识检索；不涉及在线热安装或自动授予研究 Agent 新工具。

验证：backend/test/pluginConfiguration.test.ts、workspaceComposition.test.ts、mcpWorkbench.test.ts、openApiConnector.test.ts；实际导出见 [GitHub Skills](GITHUB_SKILLS.md)、[MCP](MCP_TOOLS.md)与[OpenAPI](OPENAPI_TOOLS.md)。

## 声明字段

| 字段 | 规则 |
| --- | --- |
| `manifest.apiVersion` | 固定为 `1.0`，不兼容版本拒绝启动 |
| `manifest.id` | 小写字母开头，仅小写字母、数字、点和连字符；同一 Host 中唯一 |
| `manifest.name`、`description` | 非空显示名称和能力说明 |
| `manifest.version` | `major.minor.patch`，可带预发布后缀 |
| `manifest.requires` | 插件 ID 列表；缺失、重复 ID 和循环依赖在执行插件代码前拒绝 |
| `agents` | Agent Manifest 与安装 ID；Capability、输入输出、资源预算和可使用 Tool 继续由 Agent Manifest 声明 |
| `skillPackages` | Skill 根目录下的直接子包名；声明但缺失时拒绝启动 |
| `messageRoutes` | 可选消息路由贡献；由宿主自动注册并随插件释放 |
| `schedules` | 可选群调度贡献；声明计划/轮询与执行函数，由 Scheduler 统一执行 |
| `Config` | 可选 Standard Schema 校验器，例如 `z.object(...)`；配置从 `pluginConfig[manifest.id]` 传入 |
| `apply(ctx, config)` | 声明能力，配置已经过 `Config` 校验 |

## 注册与清理

通过 `ctx.delivery.nativeAgents.register`、`modelAgents.register`、`tools.register`、`skills.register`、`messageRoutes.register`、`messageRoutes.registerBotEntry`、`schedules.register`、`runActions.register`、`web.register` 注册。它们自动将 disposer 加入当前 Cordis 插件作用域；启动失败或 Host 停止时释放。静态消息和调度优先声明在对应数组，依赖配置的贡献也可在 `apply` 中注册。

连接、监听器和计时器使用 `ctx.effect` / `ctx.on`。插件需要在持久化控制面恢复后协调配置时，监听 `delivery/restored`；该回调失败同样使 Host 启动失败并释放插件。

Native Agent/Adapter 必须把收到的 AbortSignal 传到实际调用。Runtime 在父信号预中止时不进入 Adapter，执行期间中止则停止等待并拒绝迟到成功；父中止记录 PARENT_ABORTED/不可重试，自身截止记录 TIMEOUT/可重试。已经写入的记录保留，失败返回不交付成功产物。忽略信号的原生代码仍可能继续运行或产生副作用，Runtime 不是进程沙箱，也不替代业务幂等与读回核验。

业务数据不随卸载删除。Host 停止时拒绝新消息和调度执行，等待在途动作状态读取、消息、调度轮次、Run 和投递结束，再释放插件；停止后的对象不能重新启动，应创建新实例。应用先 `await scheduler.stop()` 再停止 Host，避免正在执行的调度再向已关闭的 Host 派发。尚未提供运行中单插件热卸载。

## 消息路由贡献

协议见 `backend/src/services/messageHandler/routes.ts`。每条路由声明全局唯一 ID、数值 `priority`、`sources` 和异步 `handle(request)`。同一阶段的优先级不能重复，注册顺序不决定执行顺序。请求包括当前 `ctx`、`resolver`、消息、来源和引用上下文。

- `phase: 'context'` 必须提供纯判断 `matches`；引用上下文存在时只选择第一条匹配路由。它返回空结果后进入普通消息阶段，不能继续尝试其他上下文路由，防止结构化站会被任务引用吞掉。
- 默认 `phase: 'message'` 按优先级逐条尝试，首个非空结果结束路由；可用 `matches` 做额外筛选。Handler 通过领域服务维护状态。
- `prepare` 在上下文仲裁前对本次消息副本执行一次，适合恢复任务追问的原始文本；不可产生外部副作用。`help` 只对本条路由支持的消息来源展示。
- `acceptsUnmentionedReply` 声明可免去再次 @机器人的群引用类型；默认不放行。站会插件仅开放原有两类任务站会引用。
- `requiresProjectMember` 保留团队组合原有的私聊身份门槛：只要所选私聊路由有一条要求成员识别，整个默认私聊链路先做成员绑定检查。这不是逐路由授权或 RBAC；纯个人插件组合不声明此项时不查询项目成员。

应用组合层创建一个 `MessageRouteRegistry`，同时传给 `HandlerContext.messageRoutes` 和 `AgentHostOptions.messageRoutes`。参考 `backend/src/index.ts`。注册表缺失或为空时没有隐式业务默认项；测试通过显式选择插件贡献构造所需路由。

## 默认机器人的 Capability 入口

需要在默认飞书机器人的私聊中直接发起 Agent 时，在插件 apply 中注册：

```ts
ctx.delivery.messageRoutes.registerBotEntry({
  id: 'example.notes.entry',
  priority: 50,
  capability: 'example.notes',
  matches: ({ message }) => message.text.startsWith('笔记：'),
});
```

对应 Agent 必须已装配、绑定当前默认 Bot，并声明该 Capability、message 触发及实际输入 Schema。宿主按原入站契约传入 prompt、message、source，不做自定义输入映射。只对有发送者的私聊文本运行匹配，能力不可派发时跳过；数值优先级从高到低，ID 和本入口阶段的优先级均须唯一。首个命中即结束，未命中继续原 Context/Message Router；独立 Bot 仍使用自身 entryCapability。

matches 是同步判断，只做确定性选择，不执行网络或写入；依赖当前配置时使用传入的 ctx。需要短期会话状态时在 apply 内创建，避免不同 Host 共享。注册随插件正常释放或装配失败回滚，Host 停止后不再选择入口。入口不是成员授权或 RBAC，团队写入仍须执行原业务权限校验。参考 backend/src/agents/plugins/aiNews.ts；backend/test/botEntryPlugins.test.ts 用独立 Native 插件验证真实入站与运行链路，无需模型或飞书凭据。

## 群业务调度贡献

协议见 `backend/src/platform/scheduling/registry.ts`。每条贡献有唯一 `id`、唯一数值 `priority` 和 `kind`，同一阶段按优先级从高到低执行，不依赖插件装配顺序；阶段依次为 global-poll、global-tick、Outbox、逐群任务。

- `kind: 'timed'` 的纯函数 `plan(context)` 返回 `{day, date, time}`，不满足日期、时刻、资格或开关条件时返回 `null`。插件拥有这些业务规则；共用日历工具保留全局工作日兜底和群覆盖。`run` 接收相同上下文、明确业务日期和 `retryAttempt`。
- 默认由 Scheduler 使用 `scheduled:id:group:date:time` 原子领取并记录执行结果。`agent: true` 仅在提供 Agent Dispatcher 时将幂等交给 Agent Trigger Store；执行函数必须实际通过对应 Runtime 派发，不能借此跳过幂等。
- 临时执行错误最多额外重试一次，遵守 `retryAfterMs`；`retryable: false` 不重试。重复 Trigger 与带警告完成沿用原语义，计划错误单独记录且不执行。
- `kind: 'poll'` 在每轮逐群调用，函数拥有自身的到期检查、领取与结果记录方式，不套用分钟计划 Claim 或通用重试。站会承诺提醒复用原来的领域幂等及错误审计。其他插件抛出的轮询错误被隔离，不阻塞其余贡献。
- `kind: 'global-poll'` 在逐群任务前按轮询间隔调用一次，无 `group`，无群时也可执行。Scheduler 第三个构造参数为该低频间隔（秒，原成员同步参数位置保持；SDK 默认一小时，HTTP 六小时，非正值禁用），各贡献分别记录尝试时间；失败记录 `scheduler_poll_failed` 并继续其他贡献，不套用群计划 Claim 或自动重试。
- `kind: 'global-tick'` 每 tick 调用一次，无 `group`，无群时仍执行，不受第三个低频轮询间隔影响。插件自己检查时刻、幂等与结果记录；错误复用全局轮询隔离，不套用群计划 Claim 或自动重试。
- 每轮共享 `resources` Map，插件可按稳定键惰性复用资源。内置 `scheduledPluginJobs` 让多群扫描复用同一个 `ScheduledJobs`，不重复创建 TAPD 同步上下文。资源只在本轮使用，不跨轮保存私有业务事实。

应用组合层创建共享 `ScheduleRegistry`，传给 `HandlerContext.schedules` 与 `AgentHostOptions.schedules`。无注册表或空列表时不隐式运行群业务或审计清理任务；Outbox Worker 仍属于通用投递服务。默认十项定时任务、一项站会轮询与一项通讯录全局轮询和一项维护 global-tick 由功能插件贡献；`builtin.ai-hot-schedule` 只负责外部 AI Hot 调度，不自动安装外部服务。

团队组合的 `builtin.directory` 独立拥有五项 `/api/feishu` 群/成员 API 和自动群成员同步，不增加 Agent。删除该插件同时关闭接口和后台读取，保留既有目录与群配置。个人默认与空组合均不装配；旧自定义组合若需要自动刷新成员，应显式加入 `builtin.directory`。

原生宿主可通过 `AgentHostOptions.reloadConfiguration` 提供配置重载回调，暴露为可选 `ctx.delivery.reloadConfiguration`；HTTP 应用沿用原重建配置/Adapter 流程。手动同步若缺少回调，会在外部读取和写入前返回 503；读取 API 与计划同步仍可用。同步修改后返回的配置继续脱敏；同步已写入而重载失败时返回错误，不能把错误当作回滚。该端口属于可信原生插件服务，不是模型 Tool 权限。

platform.maintenance 复用原审计与临时键保留策略，无 Agent/页面。个人和团队预设包含它；独立显式配置需要自行加入。base: personal 继承它，可用 MAINTENANCE_ENABLED=false 关闭执行；不会清理 Run/Step/Artifact 或未知键。配置默认与完整边界见[运行功能卡](../backend/src/platform/runtime/FEATURE.md#审计维护插件2026-11-06)。

## 运行后续动作与状态面板

插件可在 apply 中注册 `ctx.delivery.runActions.register`，无需修改工作台页面。完整类型见 `backend/src/platform/plugins/runActions.ts`；实际例子见 `backend/src/knowledge/impact/plugin.ts`。

```ts
ctx.delivery.runActions.register({
  id: 'example.review',
  label: '检查结果',
  capability: 'example.check',
  appliesTo: ['example.generate'],
  input: runId => ({ targetRunId: runId }),
  readState: async run => ({
    schemaVersion: '1.0', tone: 'neutral', title: '尚未检查',
  }),
});
```

动作 ID 必须唯一，标签最长 80 字符，Capability 和 appliesTo 遵循注册 Schema。仅匹配成功 Run；readState 应只读本地记录，不调用模型、不刷新来源、不创建执行。Host 校验 Scope 后调用并验证返回面板；失败显示错误。显式执行通过已启用 Capability 和现有 Runtime，服务端固定目标与 input，客户端仅能提供可选 UUID。幂等键包含动作 ID、目标 Run 和 UUID；同一请求重试不会重复创建执行。注册随 Cordis 回滚/释放，停止先等待在途读取和执行。

StatusPanel 1.0 只呈现文本：tone 为 neutral/success/warning/error，title 最长 160 字符，description 最长 2000；可选 checkedAt 为 ISO 时间，items 最多 20 项（label 1024、value 160、detail 2000），relatedRun 为内部 Run ID（256）与标签（80）。不得将旧缓存当作实时确认；提供检查时间并区分未检查、检查中、失败和已完成。模型输出不应直接决定可信的绿色状态。

报告 Artifact 可在 `metadata.statusPanels` 放 1–20 个同协议面板；前端通用渲染并支持内部 Run 跳转，不执行插件 HTML、脚本或远程 UI 包。未知版本或无效数据回退原有结果。动作状态属于最新评估，报告面板属于那次执行，原 Artifact 保留。当前不提供任意页面/表单贡献或运行中热卸载。

## 权限与数据边界

需要在 Native Agent 中组合 Tool 和模型时，可以使用 `ctx.delivery.toolGateway.execute` 与 `ctx.delivery.orchestrator.run`。传入同一 Run 的 scope/runId/agentId、Manifest 工具列表、调用预算、幂等键、期限和取消信号；RAG 插件是实际示例。Orchestrator 默认保留人工输入函数，`allowHumanInput: false` 可关闭它；配合空 tools 列表用于纯生成。此设置不改变其他 Agent 的默认暂停恢复行为。

这些服务是受信任原生插件的宿主 API，不是防恶意代码的权限沙箱；调用者不能以任意 allowedTools 列表冒充授权。模型凭据由宿主模型配置拥有，不放进检索结果或 Artifact。Tool Gateway 会在已取消请求和领取期间取消的请求进入 handler 前拒绝执行；已经发出的外部操作仍需要自己的幂等和结果核验。

原生插件运行在宿主进程，属于受信任代码。`ctx.delivery.getContext` 仍可访问现有应用服务，插件声明不是原生 JavaScript 的沙箱。没有审查的远程仓库不能直接变成原生插件执行。

模型可调用的动作必须通过受治理 Tool。写操作调用领域服务，不能让模型直接拼接数据库写入或扩大权限。Secret 使用引用，不放入 Prompt、产物或插件源码。

已有外部服务可继续通过 HTTP Agent Manifest、网络 allowlist、Secret 引用和超时契约接入。已提供[本地 MCP stdio 工具连接插件](MCP_TOOLS.md)，通过显式工具选择与现有 Tool Gateway 接入；当前仅支持经审查的读取工具。远程 MCP/接入助手与隔离的 CLI 适配属于后续节点。采用 Cordis 不代表现有 DeepSeek Harness 插件可以直接使用；必须适配它所依赖的服务。

## 页面、API 与原有手动任务

`ctx.delivery.web.register` 在当前 Cordis 作用域声明 WebContribution。类型见 `backend/src/platform/plugins/web.ts`。一个贡献有唯一 id，可包含 pages、api、manualJobs 与 runLinks，失败或停止时一起释放。

```ts
ctx.delivery.web.register({
  id: 'example.reader',
  pages: [{ path: '/my-reader', label: '我的读取工具', section: 'workspace',
    view: { kind: 'agent', capability: 'example.read' } }],
});
```

可选 runLinks 声明从成功根运行到功能页面的导航，例如 knowledge.answer 的 `{ id: 'knowledge.reanswer', label: '按最新资料重新回答', path: '/knowledge', appliesTo: ['knowledge.answer'] }`。每个贡献最多 20 项，ID 全局唯一，目标必须是已贡献的站内静态页面；不接受外链、查询串或编码路径。UI 附加编码的 runId，目标页面自行核验来源与准备动作。卸载链接或目标页面后隐藏，页面存在不代表有访问授权；导航不自动执行模型或代表用户确认。注册/深复制/释放测试见 backend/test/pluginWeb.test.ts，完整消费者见 backend/src/knowledge/answer/FEATURE.md。

页面只能使用站内静态路径；label 最长 80 字符，section 为 workspace/team。view.kind=agent 打开指定 Capability 的现有工作台；kind=builtin 使用已打包 renderer ID（包括团队页面，以及 knowledge、release-preparation、web-capture、documents、knowledge-library、plugin-checks、mcp-setup、mcp-runner、personal-research、run-recipes）。builtin view 可声明可选的 capability，让 Agent 卡片和任务选择进入所属结构化表单；网页收集和文档导入是实际例子。未知 renderer 显示恢复入口，不执行远程 HTML、JS 或 React 包。已保留的核心/旧页面不能覆盖，路径与贡献 ID 不得重复；Agent 导航跳转后保持当前项选中。

API 声明 prefix、routes（method/path）与接收标准 Request、返回 Response 的 handle。每条声明必须位于所属前缀，前缀不可重叠或覆盖保留 API。应用在 Host 初始化后核对已有 API 命名空间，冲突时拒绝装配，不覆盖旧接口；随后装配声明路由，因此 OpenAPI 保留路径；请求体由所属 Fetch handler 解析，代理不会先消耗 body。声明同时是请求分发边界：前缀只表示归属，未声明的方法或路径返回 404，不进入 handler，也不解析正文。参数路径、通配路径与 ALL 使用应用现有 Elysia 路由规则；直接 Host 分发与 HTTP 入口一致。`builtin.standup` 和 `backend/src/domains/standup/api.ts` 是真实例子。通过 Host.handlePluginRequest 进入本机来源校验与在途跟踪，停止时先等待请求，再释放资源。

manualJobs 声明现有 Legacy Job 名称的所有者，不添加任意命令或自动生成执行器。原有九项任务分别由站会、任务、日报、看板插件声明；/api/jobs 同时核对标准任务名与已装配所有者，缺失时返回 404。预览、日期、工作日、投递与审计仍由原执行逻辑处理，Host 跟踪任务并在停机时等待。

页面信息不是访问控制，也不能代替服务端数据范围校验。当前已迁移站会、看板、甘特、周报与隐藏纪要页面/API，以及原有手动任务授权，其他业务页面/API 与基础服务仍待迁移；navigation=false 仅隐藏菜单，直接路由仍依赖对应贡献；不代表授权或业务生成开关。没有运行中热卸载。一个功能插件可注册多个唯一 Web 贡献来拥有多个 API 前缀，例如 builtin.dashboard 同时注册 /api/dashboards 与 /api/human-gantt；注册会统一回滚和释放。旧看板根查询和 HTML 链接通过同一页面注册表检查所有者。

当前界面将首页已知任务保留在主导航，其他可见个人插件页面收进「工具与插件」。作者无需新增分组字段；未知 builtin 或 kind=agent 页面仍保留入口，通用能力链接按对应插件页面展开分组。navigation=false 继续隐藏菜单，不改变直接路由的安装校验。

builtin.configuration 是保留旧地址迁移的实例：拥有 /config（team-configuration 视图）与 GET/POST /api/config；个人/空组合不提供这两个入口。GET 仍脱敏，POST 仅接收 runtime/schedule/groups 动态字段；旧客户端回传完整 AppConfig 会被拒绝。无宿主重载时只读，持久化与重载失败分别报告。配置贡献与数据保留的完整边界见 backend/src/core/configuration-scheduling/FEATURE.md。

## 标准 JSON Schema

Agent、Tool 和 Skill 的输入输出共用标准 JSON Schema 校验，支持联合类型、引用、额外字段与边界约束；不自动下载远端引用。校验错误使用标准实现文案，调用方应按错误 code 判断，避免依赖完整错误句子。不同 Schema 即使使用同一 $id 也隔离校验。MCP 工具的原始 inputSchema 保留，structuredContent 另按上游 outputSchema 核验。

## 声明保存记录的验收规则

FeaturePlugin 可在顶层声明 checks，绑定自身 Agent/Capability；规则 ID 以插件 ID 开头，声明自身规则版本。以下展示网页插件的最小结构，完整规则见 backend/src/knowledge/capture/plugin.ts：

```ts
checks: [{
  id: 'knowledge.capture.result', title: '网页正文与来源凭证', version: '1.0.0',
  agentId: 'native.web-capture', capability: 'knowledge.page.capture',
  artifacts: [{ id: 'source', type: 'json', schema: {
    type: 'object', required: ['content', 'mediaType', 'metadata'], properties: {
      mediaType: { const: 'application/json' },
      metadata: { type: 'object', required: ['privateKnowledge'],
        properties: { privateKnowledge: { const: true } } },
      content: { type: 'object', required: ['text', 'documentVersion'],
        properties: { text: { type: 'string', minLength: 1 },
          documentVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    },
  } }],
  steps: [{ id: 'capture', kind: 'tool', name: 'web.page.capture' }],
}]
```

规则仅包含标准 JSON Schema 和步骤声明，不接受回调脚本。Schema 作用于完整 Artifact，正文放在 content 属性；可同时检查媒体类型及隐私标志。每项产物断言先按 type 和可选 selector（标准 JSON Schema）匹配完整 Artifact，再对恰好一份匹配结果校验 schema；必要字段缺失、零/多个匹配或步骤状态不符会失败。省略 selector 保持同类只能一份的旧语义；两份 Schema 都在装配时编译，不执行脚本或下载远端引用。选择器不删除其他产物。最多 8 项产物与 16 项步骤，规则最多 64 KiB；重复 ID、来源 Agent 不属于提供者或 Schema 无法编译会拒绝装配并回滚。

quality.checks 插件提供 /checks 和 quality.runs.check，输入 contractId/runId/可选 baselineRunId。最小组合见 backend/examples/plugins.checks.yaml；它检查已保存的记录，始终不重执行来源任务或调用模型。报告保留规则完整快照/哈希与当前规则提供者版本，另列历史执行步骤中记录的 Agent 版本。两次记录按同一当前规则判断；差异不自动归因升级，原始记录不改写。

Runtime 新步骤保存 execution 1.0，包括 Agent ID/版本、Manifest 及可用的输入序列化指纹。旧步骤缺少凭证时无法完整核验，不能用当前插件版本填补。多次恢复的请求不作单一输入比较；相同请求指纹也不代表完整上下文或环境相同。结构通过不代表语义质量、事实正确或代码安全，作者需要为关键结果写有意义的规则及功能测试。真实 MarkItDown 和网页记录、故意移除字段的跨版本回归已纳入 backend/test/pluginChecks.test.ts。

## 插件提交验收

1. 在真实 Host 中执行至少一个合法输入，检查结果和 Artifact。
2. 非法配置和不兼容契约必须明确失败。
3. 模拟初始化或配置恢复失败，确认没有残留 Tool、Agent Handler、消息路由、调度、安装或绑定。
4. 停止时释放自己的资源；已完成运行和用户配置仍可从持久化存储读取。
5. 有外部写入时验证幂等、重试与结果不确定的处理，不把网络成功等同于业务成功。
6. 同步功能卡、代码与测试地图，运行受影响回归和 `git diff --check`。

当前规范的运行证据见 `backend/test/runActions.test.ts`、`backend/test/workspaceActions.test.ts`、`backend/test/pluginRuntime.test.ts`、`backend/test/agentHost.test.ts`、`backend/test/messagePlugins.test.ts` 和 `backend/test/schedulePlugins.test.ts`。面向业务结果的插件验收契约与版本回放实验室仍在产品路线图中。

## 标准 Agent Skills 与 GitHub 项目

已有 MCP 服务可选择 stdio 或公开 HTTPS Streamable HTTP，connector.mcp 1.1.0 共用显式工具白名单与执行契约；HTTP 固定端点、校验 DNS/IP/TLS、拒绝重定向、限制流大小，凭据只用可选 Bearer 环境引用。不安装上游代码的真实例子见 backend/examples/plugins.context7-http.yaml；配置和边界见 [MCP 指南](MCP_TOOLS.md)。OAuth、私网地址、写工具和任意仓库自动安装仍需各自适配，不能由协议握手推断支持。

现在可显式使用 readAgentSkill 读取第三方 SKILL.md，再以宿主确定的 allowedTools、compatibleAgents、Schema 和预算注册。不是自动继承上游执行权限，也不自动执行脚本或安装任意仓库。Context7 已实际接入：上游 MCP 两个工具、官方原文 Skill、原生查询和可选模型研究。完整配置、固定来源及接入分类见 [社区插件说明](COMMUNITY_PLUGINS.md)。

## 工具元数据与受控转调

`ctx.delivery.tools.list()` 返回隔离副本的 ToolDefinition，不含 Handler；可用于展示已授权工具的当前契约。`ToolExecutionContext.budget` 传入当前调用的共享预算。受信 Native Tool 需要转调其他 Tool 时，必须沿用同一 runId/agentId/scope/signal/budget，不能新建额度；权限来源必须是明确的可信配置，不能采用工具描述或模型输入。示例见 `backend/src/connectors/mcp-workbench/runner.ts`：固定路由权限与上游配置白名单分开，两层合计两次调用，缺少预算拒绝，实际 Tool 还须存在且声明 read。此扩展不构成原生代码沙箱。

MCP 接入助手只生成固定模块配置，不执行上游代码；标准 Skills 和原生插件仍按各自授权入口接入，不能因为发现了 MCP 目录就自动取得权限。

## Model Loop 的请求与完成守卫

通过 modelAgents.register 提供 ModelLoopAgentDefinition，可复用同一执行链路：

```ts
interface ModelLoopAgentDefinition {
  instructions: string;
  artifactTitle?: string;
  artifactMetadata?: Readonly<Record<string, unknown>>;
  validateRequest?(request: AgentRequest, signal: AbortSignal): void | Promise<void>;
  validateCompletion?(request: AgentRequest, signal: AbortSignal):
    readonly ArtifactInput[] | Promise<readonly ArtifactInput[]>;
}
```

请求守卫先于 Session/Checkpoint 读取及模型请求。完成守卫只在模型准备完成时执行，
先于完成 Checkpoint 和保存助手消息；人工提问跳过该守卫。守卫异常使执行失败，
回调后核对信号；返回额外产物和模型稿由既有 Runtime 校验、限制及持久化。
artifactMetadata 用于模型稿与提问，title/waitingHuman 仍由 Adapter 决定。
这些可选项不改变旧定义；回调是受信任 JS，函数体不在 Manifest 序列化哈希中，
变更须更新插件/Agent 版本和测试，不可当作任意社区代码的安全沙箱。

personal.research 读取真实子运行生成资料索引，并用如下 selector 区分复合 JSON，
完整示例见 backend/src/agents/personal-research/plugin.ts：

```ts
selector: { type: 'object', required: ['metadata'], properties: {
  metadata: { type: 'object', required: ['artifactRole'], properties: {
    artifactRole: { const: 'personal.research.evidence' },
  } },
} }
```

Agent 委派上限从同一 Run 的 delegate: Agent 步骤恢复，失败和继续均计数，
暂停不重置额度；未提供 RunStore 的裸 Adapter 仅能在当前调用计数。
不要把保存的资料索引、结构验收或引用存在核验描述成模型语义正确的证明。

## 本机任务复用

personal.recipes 的完整边界与最小组合见 [任务配方](TASK_RECIPES.md)。它是确定性控制面功能，无独立 Agent。可信 capabilities 配置决定可复用范围，能力名或 MCP 注解不是只读证明，作者必须审查实际工具、副作用和权限；默认不开放团队写入或一次性文档输入。

PluginHostServices 增加可选 runLocal(capability, input, triggerId, expected?)，返回 runId/status/error；expected 为 { installationId, manifestHash }。服务固定本机 Scope 和 none 回复策略，经过原 Host/Trigger/Runtime；Host 尚未就绪或停止则拒绝，不能在 apply 阶段等待执行。插件 Request 经 Host 跟踪生命周期，不提供任意远程页面执行。

Host 将 expected 放入可信上下文 reserved expectedExecution，Runtime 在实际解析根 Agent 后再次核对；普通客户端 input 不能写该上下文。子委派与人工继续保持既有协议，不能据此声称环境被冻结。Manifest 指纹不是 Tool/模型/配置的完整代码快照。配方使用既有 execution 1.0 的单次身份与输入指纹，多轮或旧记录不补造凭证。

配方来源回执归配方插件，不能向其他 Agent 保存 Manifest 未允许的 Artifact。候选输入仅在当前页面内存，明确审查保存后才持久化完整参数；它不是自动 Secret 脱敏或共享市场。

源插件可以在结果 Artifact 的 metadata 声明 reusableInput=false，表示输入包含需要重新准备的当次审查内容。配方创建会拒绝此来源，运行详情与配方页也隐藏/禁用创建入口；知识重新回答的当前环境确认是实际例子。这个标记约束配方复用，不构成通用授权或 JavaScript 沙箱。

## 模型提供者插件

ModelProviderDefinition 的 id/name/isConfigured(AIConfig)/create(AIConfig) 构成模型端口；create 返回当前 AI SDK LanguageModel。可直接调用 ctx.delivery.modelProviders.register(definition)，或复用 modelProviderPlugin(definition) 生成 FeaturePlugin。注册随 Cordis effect 释放与回滚，最多 30 项、ID 唯一。供应商选择使用 AI_PROVIDER；未知 ID 只匹配同 ID 已装配插件，不回退 OpenAI。

```ts
import { modelProviderPlugin } from '@/platform/models/providers';
import { createOpenAI } from '@ai-sdk/openai';

export default modelProviderPlugin({
    id: 'example.gateway', name: 'My model gateway',
    isConfigured: config => Boolean(config.api_key && config.model),
    create: config => createOpenAI({ apiKey: config.api_key, baseURL: config.api_base }).chat(config.model),
});
```

在可信 YAML 中像其他插件一样选择模块，无需修改 Host。原生插件代码自行负责其传输与凭据边界。Host 从空注册表开始，显式组合需要自行选择模型；标准默认导出位于 backend/src/platform/models/providers/{openai,google,ollama}Plugin.ts。独立 new AiSdkModelGateway(getConfig) 保留标准供应商方便 SDK 使用，Host 始终显式传自己的注册表。configured 只验证参数，不能当作连接成功或模型效果证明。Ollama 的直连限制与测试见[功能卡](../backend/src/platform/models/FEATURE.md)。

## 组合知识来源

knowledge.mixed 是固定两源组合的实际例子，依赖 knowledge.markdown 和 knowledge.web，不复制它们的读取服务；注册 search/versions Tool 并复用现有回答、研究、发布及复核工厂。明确定义上游授权，沿用同一 execution.budget/scope/runId/signal，不能通过嵌套调用补发预算。

createKnowledgeAnswerPlugin 和 createReleasePlugin 的可信 source port 可声明 toolCalls（默认 1），代表一次检索含路由的总成本；混合为 3。该参数由宿主代码提供，不来自问题、模型输出或页面输入。消费者的 Manifest 和共享预算要覆盖实际嵌套调用，metrics 记录 budget.used。当前混合仅支持笔记与公开网页，不是任意来源/权限的自动发现器。

retrievalEvidence.source 可选 sources 覆盖数组（最多两项，markdown/web、available/unavailable、indexed、partial、可选 version）。原每条引用身份与文档版本仍是事实凭证，合并版本不能替代它们。partial/全部不可读、取消、预算耗尽和单源版本失败要分别表达；不把未读到当作知识不存在。实现、可运行配置与专项见[混合知识功能卡](../backend/src/knowledge/mixed/FEATURE.md)。

## 无 MCP 的公开 REST 项目

提供 OpenAPI 3.0/3.1 JSON/YAML 的服务可选择内置 openapi.setup / connector.openapi，经过目录发现、成功原记录绑定授权导出和固定 GET 运行；无需执行仓库代码或编写专属 Agent。支持边界、参数序列化、配置与复现见 [OpenAPI 工具](OPENAPI_TOOLS.md)。这是原生插件中的受控适配方式，不承诺兼容任意 OpenAPI 或仓库。

## 已审查导出文件的组合

个人默认 plugins.compose 提供本机页面与结构转换 API，见[组合指南](PLUGIN_PROFILES.md)。它只接受固定模块集合的 Skill/MCP/OpenAPI 导出文件，不调用通用动态加载器验证未知代码；普通原生配置仍按上面的可信代码装配规范处理。输出使用 base personal 和 backend 根目录相对模块，保留旧单份 Skill 的 ID 形态、集合固定 ID 和原始指令/许可，MCP 授权必须与运行器一致，OpenAPI 固定契约不扩大。它不自动继承其他显式配置。

## 按任务收紧模型委派

Model Loop 定义可提供 delegationSchema(request, capability) 回调（可异步）：返回 null 隐藏该次能力，undefined 保留旧输入，JSON Schema 与原子 Agent 输入通过 allOf 组合。回调只作用于 Manifest 已声明的 delegates/optionalDelegates；执行时 Adapter 再校验策略，并在失败时写 guardrail、阻止子调用。它不授权新的 Capability，也不是原生代码沙箱。个人研究使用常量固定人工确认的 MCP/API 请求，见[使用与确认规则](PERSONAL_RESEARCH.md#让已接入工具参与研究)。

可信 HTTP 读取连接器可在 ToolDefinition.binding 声明 kind（mcp-http/openapi-get）、公开 url 和配置/契约 sha256；原 MCP/OpenAPI 插件生成，stdio 不声明。研究目录另绑定路由白名单 Schema、Agent Manifest 和安装 ID。binding 不能携带凭据；它是声明和变更指纹，不证明服务身份、只读行为或语义。

plugins.compose 1.1.0 的独立 setup 导出只接受 skills/openapi 枚举，生成已打包助手的固定模块，不经过通用动态加载器。它与 compose 的审查能力文件接口分开；助手选择不授权第三方技能/工具，不自动合并当前自定义配置。两者都由用户预览、保存并重启，详见[接入流程](PLUGIN_PROFILES.md)。

## 可信插件的本机 schedule 执行

PluginHostServices.runScheduledLocal 是可选可信端口，参数/平面回执与 runLocal 相同，但触发类型固定为 schedule；不接受自定义 workspace/bot/chat，不产生直接投递。插件应在 Host 初始化完成后使用，apply/restored 阶段调用会拒绝，停止后同样拒绝。未声明 schedule 的 Agent 在 Adapter 前被拒绝，原执行指纹和触发幂等沿用平台；普通工作台 HTTP 调用不能选择该通道。

knowledge.watch 使用该端口调度 Native 引用复核；requirePersonalVersionScope 只为无群聊 schedule 放行来源 versions。requirePersonalScope 及其他检索、生成、写入权限保持原状。参考[定期复核契约](../backend/src/knowledge/watch/FEATURE.md)与 backend/test/localSchedules.test.ts。原生插件仍是用户信任的本机代码，端口声明不是代码沙箱。

## 外部 Agent 的专用安装入口

可信插件可通过可选 ctx.delivery.installExternal(manifest, options) 复用 Host 的通用安装服务；它不是模型 Tool 授权，也不自动调用远端。builtin.ai-hot-schedule 已拥有原专用安装 URL，移除插件关闭接口/调度，保留 Catalog 与通用管理能力。团队快捷 Dispatcher 位于 agents/dispatcher.ts，旧平台路径仅兼容转出。

插件间 API 前缀不重叠。核心 /api/agents、/api/agents/install、/api/agents/run 保留；其余独立子前缀可以由插件拥有。createPluginApi 还按实际应用路由校验路径段，参数和通配符相交、尾斜杠同路径均拒绝；不会因为同一首级目录就拒绝完全不相交的子路径。其余保留核心命名空间规则不变。

## 插件回复上下文查询

context 阶段的消息路由可声明 lookupContext(ctx, messageId)，返回上下文或 null。注册时必须提供函数并显式使用 phase: context；查询按该阶段 priority 执行，首个非空结果停止继续推断。共享层保留 Bot Context 和有深度/循环保护的消息祖先遍历；业务表读取应归所属插件。整个查询受 MessageRouteRegistry 在途跟踪保护，停止拒绝新查询、等待已接受查询后释放贡献。builtin.task 为现有使用者，空组合不再隐式扫描任务。

兼容团队服务采用应用层 agents/context.ts 的按需实例，原业务状态由领域服务拥有。原生插件仍是可信宿主代码，接口不提供代码沙箱。完整现状与唯一剩余的固定通道收尾见[迁移审计](PLUGIN_MIGRATION_AUDIT.md)。
