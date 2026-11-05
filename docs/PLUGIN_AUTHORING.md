# 功能插件规范 v1

当前 SDK 面向本仓库内或由部署者审查的 TypeScript 原生插件。使用 Cordis 4.1.0，协议版本为 `1.0`。现阶段提供 Agent、Tool、Skill、消息路由和群业务调度的独立装配、依赖校验和资源清理；页面、全局维护/成员同步、业务 API 与基础服务的完整插件化继续按路线图迁移。

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

## 用配置文件选择 Agent 插件

从 `backend` 目录启动时，可设置：

```bash
AGENT_PLUGINS_FILE=profiles/agents/team.yaml bun run dev
```

未设置变量时默认组合为九个功能插件、七个 Agent；会议纪要和外部 AI Hot 调度插件没有独立 Agent。会议纪要仍受原有模块开关控制，外部 AI Hot 能力仍需另行安装。示例还包括 `profiles/agents/native-demo.yaml` 和 `profiles/agents/empty.yaml`，分别选择 Echo 模板和零业务插件。所选插件同时决定消息指令、引用上下文、能力提示和群业务调度；这些配置尚不关闭原 Web、飞书连接、业务 API、全局维护或成员同步，也不等同完整的最小产品部署配置档。

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

通过 `ctx.delivery.nativeAgents.register`、`modelAgents.register`、`tools.register`、`skills.register`、`messageRoutes.register`、`schedules.register` 注册。它们自动将 disposer 加入当前 Cordis 插件作用域；启动失败或 Host 停止时释放。静态消息和调度优先声明在对应数组，依赖配置的贡献也可在 `apply` 中注册。

连接、监听器和计时器使用 `ctx.effect` / `ctx.on`。插件需要在持久化控制面恢复后协调配置时，监听 `delivery/restored`；该回调失败同样使 Host 启动失败并释放插件。

业务数据不随卸载删除。Host 停止时拒绝新消息和调度执行，等待在途消息、调度轮次、Run 和投递结束，再释放插件；停止后的对象不能重新启动，应创建新实例。应用先 `await scheduler.stop()` 再停止 Host，避免正在执行的调度再向已关闭的 Host 派发。尚未提供运行中单插件热卸载。

## 消息路由贡献

协议见 `backend/src/services/messageHandler/routes.ts`。每条路由声明全局唯一 ID、数值 `priority`、`sources` 和异步 `handle(request)`。同一阶段的优先级不能重复，注册顺序不决定执行顺序。请求包括当前 `ctx`、`resolver`、消息、来源和引用上下文。

- `phase: 'context'` 必须提供纯判断 `matches`；引用上下文存在时只选择第一条匹配路由。它返回空结果后进入普通消息阶段，不能继续尝试其他上下文路由，防止结构化站会被任务引用吞掉。
- 默认 `phase: 'message'` 按优先级逐条尝试，首个非空结果结束路由；可用 `matches` 做额外筛选。Handler 通过领域服务维护状态。
- `prepare` 在上下文仲裁前对本次消息副本执行一次，适合恢复任务追问的原始文本；不可产生外部副作用。`help` 只对本条路由支持的消息来源展示。
- `acceptsUnmentionedReply` 声明可免去再次 @机器人的群引用类型；默认不放行。站会插件仅开放原有两类任务站会引用。
- `requiresProjectMember` 保留团队组合原有的私聊身份门槛：只要所选私聊路由有一条要求成员识别，整个默认私聊链路先做成员绑定检查。这不是逐路由授权或 RBAC；纯个人插件组合不声明此项时不查询项目成员。

应用组合层创建一个 `MessageRouteRegistry`，同时传给 `HandlerContext.messageRoutes` 和 `AgentHostOptions.messageRoutes`。参考 `backend/src/index.ts`。注册表缺失或为空时没有隐式业务默认项；测试通过显式选择插件贡献构造所需路由。

## 群业务调度贡献

协议见 `backend/src/platform/scheduling/registry.ts`。每条贡献有唯一 `id`、唯一数值 `priority` 和 `kind`，按优先级从高到低执行，不依赖插件装配顺序。

- `kind: 'timed'` 的纯函数 `plan(context)` 返回 `{day, date, time}`，不满足日期、时刻、资格或开关条件时返回 `null`。插件拥有这些业务规则；共用日历工具保留全局工作日兜底和群覆盖。`run` 接收相同上下文、明确业务日期和 `retryAttempt`。
- 默认由 Scheduler 使用 `scheduled:id:group:date:time` 原子领取并记录执行结果。`agent: true` 仅在提供 Agent Dispatcher 时将幂等交给 Agent Trigger Store；执行函数必须实际通过对应 Runtime 派发，不能借此跳过幂等。
- 临时执行错误最多额外重试一次，遵守 `retryAfterMs`；`retryable: false` 不重试。重复 Trigger 与带警告完成沿用原语义，计划错误单独记录且不执行。
- `kind: 'poll'` 在每轮逐群调用，函数拥有自身的到期检查、领取与结果记录方式，不套用分钟计划 Claim 或通用重试。站会承诺提醒复用原来的领域幂等及错误审计。其他插件抛出的轮询错误被隔离，不阻塞其余贡献。
- 每轮共享 `resources` Map，插件可按稳定键惰性复用资源。内置 `scheduledPluginJobs` 让多群扫描复用同一个 `ScheduledJobs`，不重复创建 TAPD 同步上下文。资源只在本轮使用，不跨轮保存私有业务事实。

应用组合层创建共享 `ScheduleRegistry`，传给 `HandlerContext.schedules` 与 `AgentHostOptions.schedules`。无注册表或空列表时不隐式运行群业务任务；全局维护、成员同步及 Outbox Worker 当前仍为基础服务。默认十项定时任务与一项站会轮询由功能插件贡献；`builtin.ai-hot-schedule` 只负责外部 AI Hot 调度，不自动安装外部服务。

## 权限与数据边界

原生插件运行在宿主进程，属于受信任代码。`ctx.delivery.getContext` 仍可访问现有应用服务，插件声明不是原生 JavaScript 的沙箱。没有审查的远程仓库不能直接变成原生插件执行。

模型可调用的动作必须通过受治理 Tool。写操作调用领域服务，不能让模型直接拼接数据库写入或扩大权限。Secret 使用引用，不放入 Prompt、产物或插件源码。

已有外部服务可继续通过 HTTP Agent Manifest、网络 allowlist、Secret 引用和超时契约接入。MCP 接入助手与隔离的 CLI 适配属于后续节点。采用 Cordis 不代表现有 DeepSeek Harness 插件可以直接使用；必须适配它所依赖的服务。

## 插件提交验收

1. 在真实 Host 中执行至少一个合法输入，检查结果和 Artifact。
2. 非法配置和不兼容契约必须明确失败。
3. 模拟初始化或配置恢复失败，确认没有残留 Tool、Agent Handler、消息路由、调度、安装或绑定。
4. 停止时释放自己的资源；已完成运行和用户配置仍可从持久化存储读取。
5. 有外部写入时验证幂等、重试与结果不确定的处理，不把网络成功等同于业务成功。
6. 同步功能卡、代码与测试地图，运行受影响回归和 `git diff --check`。

当前规范的运行证据见 `backend/test/pluginRuntime.test.ts`、`backend/test/agentHost.test.ts`、`backend/test/messagePlugins.test.ts` 和 `backend/test/schedulePlugins.test.ts`。面向业务结果的插件验收契约与版本回放实验室仍在产品路线图中。
