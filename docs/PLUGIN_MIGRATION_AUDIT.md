# 插件架构收尾验收记录

审计日期：2026-11-06。范围是公开仓库的本地架构；真实模型效果按用户决定稍后配置验证，不涉及服务器或 Docker 改造。

目前业务能力的注册与入口已按插件控制，仍有一项明确的底层收尾：飞书入站与投递通道。不能把当前状态写成“所有平台集成都已完全插件化”。

## 已闭环的边界

| 边界 | 所属位置 | 缺少插件时的行为 | 验证 |
| --- | --- | --- | --- |
| Agent / Tool / Skill / 模型提供者 | Cordis FeaturePlugin 与各 Registry | 不隐式补装业务能力；外部持久化安装单独恢复 | pluginRuntime、pluginConfiguration、workspaceComposition |
| 消息、帮助、确定性 Bot 入口 | MessageRouteRegistry 与功能插件 | 不命中已移除的指令、帮助或新闻会话入口 | messagePlugins、botEntryPlugins、multiBotIngress |
| 自动任务回复推断 | builtin.task.context.lookupContext | 不扫描任务或任务更新表来猜测上下文 | replyContextPlugins |
| 群计划、轮询、通讯录、审计维护 | 各功能插件与 ScheduleRegistry | 空组合无业务计划、目录读取或审计删除 | schedulePlugins、directoryPlugin、maintenancePlugin |
| 业务页面与 API | PluginWebRegistry 与所属插件 | 404；不消费无归属请求正文，不创建执行器 | pluginWeb、configurationPlugin、projectVisibilityApi、reportWeb |
| AI Hot 专用安装与定时调度 | builtin.ai-hot-schedule | 旧快捷 API 和定时调度关闭；已安装外部包保留 | aiHotPlugin |
| 原团队手动任务 | 插件声明授权，agents/jobsApi.ts 执行业务规则 | 创建 Job 前拒绝；平台旧导出仅兼容 | pluginWeb、jobExecution |
| 旧团队服务构造 | agents/context.ts 的按需端口 | 空/个人/Echo 启动不创建 TAPD、旧 LLM、邮件或看板服务 | applicationContext |
| 停机和失败清理 | Host、注册表在途集合、Cordis effect | 等待已接受消息/查询/任务/Run 后释放注册；保留事实数据 | messagePlugins、replyContextPlugins、maintenancePlugin、aiHotPlugin |

插件契约、依赖、声明和示例见 [插件规范](PLUGIN_AUTHORING.md)，功能 Owner 见[功能索引](features/README.md)。TaskService、StandupService 等继续拥有强一致业务状态，不为每个确定性功能额外创建 Agent。

## 实际本地验证

使用全新临时 SQLite、公开样例和真实后端入口依次启动：

1. 空组合：0 插件 / 0 Agent，AI Hot 快捷安装返回 404。
2. Echo 独立插件：1 插件 / 1 Agent，经 HTTP 启动真实异步 Run，成功保存文本产物。
3. 仅 AI Hot 安装插件：旧安装 URL 返回 200，保存外部 Manifest/Installation/Binding；未请求远端服务。
4. 再切到空组合：快捷安装返回 404，外部持久化包仍可由通用控制面管理；原 Echo Run、步骤和产物的完整响应逐字不变。

四个实例的 readiness 均通过，模型均未配置，退出均正常。另用真实 SQLite 验证维护分批与白名单删除，并逐字比较旧 Run/Step/Artifact 三条记录；未使用个人资料库、真实邮箱、模型或飞书/TAPD 凭据。

业务上下文与查询节点：后端类型通过，819 项测试通过、1 项真实 TAPD 跳过。前端本批未修改；此前类型、29 项测试、lint 和构建已通过，159 项既有 lint warning 与大包提示保留。远端 CI 以每个实际提交为准。

真实启动发现并修复 CORS OPTIONS /* 被误判为插件路由冲突的问题；回归使用真实 cors()。冲突判定同时检查方法与路径，ALL、GET/HEAD、参数、通配符和尾斜杠冲突仍拒绝。

## 唯一剩余的本轮架构节点：固定飞书通道

当前 index.ts 仍创建 FeishuAdapter、FeishuBotConnectionManager 和 FeishuBotMessageIngress；AgentHost 仍构造 RoutedFeishuDeliveryAdapter。配置了有效身份或恢复了专用 Bot 后，是否连接通道还未由独立通信插件统一拥有。现有业务插件可停用消息能力，但这不等于移除了飞书传输本身。

下一节点的验收必须同时满足：

- 用宿主通用传输/生命周期端口，让飞书插件拥有入站连接、投递 Adapter 和 readiness 信息；不把飞书分支继续加回 Host。
- 空组合即使提供虚构的完整飞书配置也不创建 WebSocket 或外部读写；安装后继续沿用原默认/专用机器人、secretRef、Bot Binding 和入站去重。
- 先停止新入站，再等待已接受执行与投递，最后关闭资源；启动失败清理已创建连接。未安装时不能丢弃或冒充成功投递已有 Outbox，重装后可继续处理。
- 对齐 SDK 的 initialize/start/stop、HTTP readiness 和既有协议；用模拟连接、持久化回归与真实本机 HTTP 验证，不发送真实消息。

这项完成前，路线图 B 保留未完成标记。认证、远端部署、向量检索、OAuth、原生插件沙箱和真实模型质量属于分别声明的产品边界，不用新增这些能力来替代上述收尾。
