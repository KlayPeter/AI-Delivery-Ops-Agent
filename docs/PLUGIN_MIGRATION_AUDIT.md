# 插件架构收尾验收记录

审计日期：2026-11-06。范围是公开仓库的本地架构；真实模型效果按用户决定稍后配置验证，不涉及服务器或 Docker 改造。

本轮业务与传输装配收尾已完成：业务入口、维护、上下文查询与飞书通信均按插件控制。当前传输契约限定一个组合一个提供者，Bot 模型仍仅声明飞书；不宣称任意通信协议、多协议并行或热替换已实现。

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
| 飞书入站/投递/就绪 | channel.feishu 与 TransportRegistry | 不建立连接、不领取 Outbox、不消耗重试；应用默认 Adapter 也不可访问 | transportPlugins、applicationContext |
| 停机和失败清理 | Host、注册表在途集合、Cordis effect | 等待已接受消息/查询/任务/Run 后释放注册；保留事实数据 | messagePlugins、replyContextPlugins、maintenancePlugin、aiHotPlugin |

插件契约、依赖、声明和示例见 [插件规范](PLUGIN_AUTHORING.md)，功能 Owner 见[功能索引](features/README.md)。TaskService、StandupService 等继续拥有强一致业务状态，不为每个确定性功能额外创建 Agent。

## 实际本地验证

使用全新临时 SQLite、公开样例和真实后端入口依次启动：

1. 空组合：0 插件 / 0 Agent，AI Hot 快捷安装返回 404。
2. Echo 独立插件：1 插件 / 1 Agent，经 HTTP 启动真实异步 Run，成功保存文本产物。
3. 仅 AI Hot 安装插件：旧安装 URL 返回 200，保存外部 Manifest/Installation/Binding；未请求远端服务。
4. 再切到空组合：快捷安装返回 404，外部持久化包仍可由通用控制面管理；原 Echo Run、步骤和产物的完整响应逐字不变。

四个实例的 readiness 均通过，模型均未配置，退出均正常。另用真实 SQLite 验证维护分批与白名单删除，并逐字比较旧 Run/Step/Artifact 三条记录；未使用个人资料库、真实邮箱、模型或飞书/TAPD 凭据。

最终收尾节点：后端类型通过，826 项测试通过、1 项真实 TAPD 跳过。前端本批未修改；此前类型、29 项测试、lint 和构建已通过，159 项既有 lint warning 与大包提示保留。远端 CI 以每个实际提交为准。

真实启动发现并修复 CORS OPTIONS /* 被误判为插件路由冲突的问题；回归使用真实 cors()。冲突判定同时检查方法与路径，ALL、GET/HEAD、参数、通配符和尾斜杠冲突仍拒绝。

## 飞书通道收尾：已验收

channel.feishu 拥有原 Manager/Ingress、路由投递 Adapter 与健康信息，Host 使用通用 TransportRegistry。index 不再构造这些对象或 FeishuAdapter；默认应用 Adapter 按需提供，并在每次访问时检查传输是否安装，防止旧直接业务调用绕过停用。显式 SDK Adapter 仍由调用者拥有，不是原生代码沙箱。

- 团队 SDK/team.yaml 包含通道，为 **16 插件 / 7 Agent**；个人默认仍 **16 / 9**，GitHub 组合仍 **18 / 10**。个人和独立配置需显式加入通道及对应 Bot/功能能力；填写凭据不会自动连接。
- initialize 只装配；start 在 Catalog/Binding 恢复后启动连接与 Worker。并发 start 共用启动，重复 stop 共用收尾。停止立即拒绝新消息/调度/Run，关闭入站，等待已接受工作和 Worker，再关闭资源并释放插件。
- start 失败会走完整停机，释放其他插件的 effect；失败连接本身与先前成功的连接都会关闭；启动被停止后不会再打开后续 Bot。默认/专用路由、secretRef、去重、Scope 和 Outbox 租约/回执沿用原实现。
- 缺通道时 Worker 不领取队列，既不消耗重试，也不标成成功或删除；重装后继续同一条记录。健康接口读取实际通道，缺通道为零必需连接，不意味着排队消息已投递。

六项专项测试覆盖缺通道零尝试、恢复仅投递一次、真实消息 Router 及停机等待、重复事件、启动失败关闭、启动中途停止、注册约束与健康快照。applicationContext 另外验证停用时连已缓存的默认 Adapter 都不可访问。保留原生命周期回归，确保 stop 调用当下就拒绝新确定性消息。

全新临时 SQLite 实际生成 Echo Run、排队一条最多一次投递的消息：无通道零尝试；装配真实飞书插件工厂并注入本地假发送器后仅投递一次、保存回执；再移除通道保持回执和三条 Run/Step/Artifact 历史逐字不变。没有发送真实飞书消息。

实际后端 HTTP 另外验证五种组合：无通道的前四种带虚构完整飞书配置，均就绪且不建立飞书连接；第五种仅安装通道、凭据留空，也正常就绪。各次切换保留原成功运行，子进程正常退出。此验证补充单测，不代表真实凭据权限、网络收发或模型质量已通过。

## 继续保留的产品边界

本轮路线图 B 已闭环。真实模型质量按用户决定稍后验收；用户重复使用价值、认证/多人权限、OAuth、向量检索、服务器部署和原生插件沙箱仍分别受既有路线图和产品说明约束，不作为本轮已完成能力。平台可替换的是当前协议下的插件与传输提供者，不等于所有第三方项目无需适配就能执行。
