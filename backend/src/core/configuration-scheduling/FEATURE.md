---
feature_id: configuration-scheduling
name: 配置、通讯录与定时调度
status: active
agent_mapping: []
last_reviewed: 2026-07-29
---

# 配置、通讯录与定时调度

管理群、成员、公司目录、模块开关、运行参数与定时计划，并把确定性调度转换为带作用域的功能触发。

## 功能定位

配置与调度属于系统控制面。配置决定“哪些群、成员、机器人和功能可以运行”，调度决定“在什么时间创建一次执行”；它们不负责生成日报、统计站会或构造看板。

把控制面和业务逻辑分开，可以避免配置页面、Scheduler 和手动 Debug 入口各自实现一套业务规则。无论请求来自定时器还是管理员手动触发，最终都进入相同的业务 Service 或 Agent Runtime。

## 实现流程图

```mermaid
flowchart TD
    A["Config Page / API"] --> B["Schema 校验与持久化"]
    C["飞书通讯录与群"] --> D["成员同步服务"]
    D --> B
    B --> E["Scheduler 重载"]
    E --> F["按时区计算到期计划"]
    F --> L{"调度类型"}
    L -- "一般计划" --> G["Job / Trigger 执行记录"]
    L -- "工作窗口半小时扫描" --> S["本轮共享 ScheduledJobs"]
    S --> T["一次 TAPD 全量同步"]
    T --> M["逐群 overdueScan"]
    M --> P["TaskService 层级投影"]
    P --> Q{"活跃未完成叶子项?"}
    Q -- "是" --> V{"负责人 open_id 可解析?"}
    Q -- "否" --> R["不催交"]
    V -- "是" --> N["负责人私聊"]
    V -- "否" --> U["记录未解析槽位"]
    G --> H["站会功能"]
    G --> I["日报 Agent"]
    G --> W["周报 Agent"]
    G --> J["看板 Agent"]
    H --> K["Outbox / 审计"]
    I --> K
    W --> K
    J --> K
```

## 能力边界

### 目标

- 配置变更可校验、可持久化，并能安全地重载 Scheduler。
- 群与成员配置为站会、日报、看板和 Bot 路由提供一致范围。

### 非目标

- Scheduler 只决定何时和以什么作用域触发，不实现业务规则。
- 配置页面不是 Agent，不需要模型参与确定性管理操作。

## 核心规则

1. **配置先校验再持久化。** Cron、时区、群、Bot、模块开关和外部服务参数必须通过服务端 Schema；前端校验只改善体验。
2. **保存成功只代表配置已持久化。** Scheduler 当前按轮询周期读取新配置，页面提示约 30 秒内生效；配置 API 不能把未来的调度执行描述成已经成功。
3. **Scheduler 只创建执行。** 到点后写入 Job/Trigger 记录，再调用对应 Agent 或领域服务；Scheduler 不复制日报、站会和看板规则。
4. **每个群独立调度。** 群配置、时区、计划和 Bot Binding 共同确定运行 Scope，一个群失败不阻塞其他群。
5. **定时执行使用稳定幂等键。** 功能、群、计划时间或业务日期共同识别一次执行，服务重启不会重复完成同一业务动作。
6. **计划任务失败按固定次数重试。** 当前调度链路对失败任务额外重试一次，并分别记录每次尝试；业务副作用仍需自身幂等。业务返回发送跳过或拒绝时记录 `completed_with_warnings`，不得伪装为干净完成。
7. **通讯录同步采用保守全量快照。** 飞书返回空列表、分页不完整或请求失败时保留最近成功成员，不用异常结果清空配置；仅在完整的非空公司通讯录快照成功时，将本次缺失的公司成员标为离职，并同步停用其群成员配置，避免离职人员继续出现在站会、看板和甘特范围中。
8. **Secret 只保存引用。** 密钥不进入普通动态配置、前端完整响应、日志、Prompt 或 Artifact。
9. **模块开关影响入口，不改变历史数据。** 关闭功能停止新的调度和消息处理，但不删除既有记录。
10. **超期扫描限制在工作窗口且可按群关闭。** `overdue_scan_enabled` 是每个群的总开关，关闭后 Scheduler 不创建该群的扫描或私聊提醒；开启时默认使用 `Asia/Shanghai`，在工作日 09:00–18:30 每 30 分钟扫描；开始、结束、间隔和时区分别由 `overdue_scan`、`overdue_scan_end`、`overdue_scan_interval_minutes`、`overdue_scan_timezone` 配置。每次扫描的幂等键包含北京时间业务日期和实际时分。
11. **扫描频率与提醒频率分离。** Scheduler 只按半小时创建扫描；任务域按 10:00、16:00 或整点提醒槽决定是否私聊。18:30 扫描用于重试 18:00 的失败提醒，不创建 18:30 提醒；旧配置 `task_reminder_frequency_hours` 不再参与提醒判断。
12. **调度不判断任务是否可催。** 同一 tick 复用一个 `ScheduledJobs`，所有到期群共享一次 TAPD 全分页同步；同步失败使 Job 明确失败并进入调度重试。同步成功后由任务域选择唯一提醒群和活跃叶子项；负责人未解析、临时失败或永久拒绝由业务结果统计，Scheduler 记录部分完成。
13. **周报按周五、显式时区和站会资格触发。** `weekly_report`、`weekly_report_timezone`、`weekly_report_enabled` 和 `module_weekly_report_enabled` 分别控制时刻、时区、任务开关和模块开关；此外必须由 `StandupService.isGroupEnabled` 判定该群已开启日报站会。周报是周级归档，即使周五是节假日也不受 `workdays_only` 跳过。
14. **全局维护任务独立于群业务任务。** 默认每天 `Asia/Shanghai` 03:30 清理 90 天以前的审计日志和临时调度幂等记录；使用日期幂等键、批量上限和内部错误隔离，一个维护失败不能阻塞任一群的业务 Job。
15. **AI 新闻默认复用现有机器人。** 未设置 `AI_NEWS_ENABLED` 时功能保持启用，直接使用 `bot-default` 和已有 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`；默认单页为 15 条，`AI_NEWS_DEFAULT_LIMIT` 可在 1–20 范围覆盖。“查看更多”固定使用下一批最多 20 条。`AI_NEWS_ENABLED=false` 只关闭新入口，不删除历史 Run。只有配置了不同的 `FEISHU_AI_NEWS_APP_ID` 时才创建独立 BotInstance，并通过 Secret 引用读取对应 App Secret。
16. **公开版集成配置默认不连接真实租户。** `TAPD_WORKSPACE_ID` 默认值为 `0`，`TAPD_WORKITEM_TYPE_ID`、飞书凭证和模型密钥默认留空；使用者必须显式提供自己的测试或生产配置。

## 用户能力

- 配置群、项目、成员、邮箱、Bot 绑定和功能开关。
- 同步飞书群成员与公司通讯录。
- 设置日报、周报、站会、看板和超期催办计划；可在每个群的高级配置「其他基础配置」中开启或关闭超期催办，并通过 Debug 页面或 Agent API 手动验证任务。

## 入口与触发

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| Config API/页面 | 配置 Patch 或同步动作 | 保存结果与当前配置 |
| 服务启动/配置重载 | 持久化配置 | Scheduler 任务注册 |
| Scheduler | Cron、群、Bot、业务参数 | Agent Trigger 或 Job Execution |

## 运行逻辑

1. Config Page 调用后端 API 读取或提交受 Schema 约束的配置。
2. Core Config 合并允许字段并持久化，Secret 只保存引用或受控值。
3. 群成员/公司目录服务通过飞书 Adapter 同步身份数据；公司目录完整快照会停用缺失成员及其动态群成员配置，空或失败结果不写入。
4. Scheduler 根据启用模块和计划重建任务；一般计划按配置时刻触发，超期扫描按显式时区、工作窗口和扫描间隔触发。
5. 到期任务创建 Job/Trigger 执行记录，再调用站会、日报、周报、看板或超期扫描入口；同轮传统 Job 复用一个 `ScheduledJobs`，超期扫描只做一次 TAPD 同步。周报只对开启日报站会的群在配置时区周五触发，超期扫描由任务域判断唯一提醒群和活跃叶子项。

## Agent、Tool 与服务边界

| 对象 | 职责 | 禁止承担 |
| --- | --- | --- |
| Config Service/API | 校验、保存和读取配置 | 执行业务 Job |
| Scheduler | 时间编排和触发作用域 | 复制日报/站会/看板规则 |
| Group/Company Member Service | 同步身份和群范围 | 自行创建业务任务 |
| Scheduled Agent Dispatcher | 将调度请求交给 Agent Runtime | 绕过 Run 和 Trigger 记录 |

## 数据与状态

- 动态配置、群配置、成员目录和 Job Execution 是不同数据对象。
- 动态配置先持久化，Scheduler 再按轮询周期读取；实际业务执行由独立 Job/Trigger 状态记录。
- 调度幂等键至少包含功能、群、计划时间或业务日期；超期扫描包含时区内的实际执行时分，同一半小时扫描不能重复执行。
- 任务提醒槽和原子发送领取由任务域持久化。扫描执行成功不等于已经发送提醒；临时失败时下一个扫描周期可重试，永久接收人错误按负责人和槽位抑制，负责人未解析时同槽只记录一次。存在跳过或失败时 Job 状态为 `completed_with_warnings`。

## 失败、安全与降级

- 虽为内网系统，配置接口仍应限制到管理员或可信网络边界；不能依赖前端隐藏按钮。
- Secret 不得进入日志、Agent Prompt、Artifact 或前端完整响应。
- 通讯录同步失败时使用最近成功快照并记录时间，避免错误清空成员。
- 非法 Cron、时区或群/Bot 绑定必须在保存前拒绝。

## 代码地图

### 主要实现

- `backend/src/core/config.ts`：动态配置读取与保存。
- `backend/src/core/scheduler.ts`：定时器装配。
- `backend/src/core/dataRetention.ts`：全局维护任务的保留边界与分批清理。
- `backend/src/core/scheduleTime.ts`：时区时钟、工作窗口和循环触发判断。
- `backend/src/services/jobs.ts`：业务调度动作。
- `backend/src/services/jobExecution.ts`：执行记录。
- `backend/src/services/groupMembers.ts`、`companyMembers.ts`：成员同步。
- `backend/src/platform/bootstrap/scheduledAgentDispatcher.ts`：调度到 Agent Runtime。
- `frontend/src/pages/ConfigPage.tsx`、`frontend/src/components/config/GroupConfigList.tsx`、`frontend/src/pages/DebugPage.tsx`：配置和手动验证。

### 主要测试

- `backend/test/config.test.ts`：配置校验和持久化。
- `backend/test/scheduler.test.ts`：计划注册与执行。
- `backend/test/dataRetention.test.ts`、`maintenanceScheduler.test.ts`：维护配置、每日领取和失败隔离。
- `backend/test/jobs.test.ts`、`jobExecution.test.ts`：业务 Job 和记录。
- `backend/test/groupMembers.test.ts`、`companyMembers.test.ts`：成员同步、完整目录快照和离职停用。

## 变更记录

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-07-29 | 公开版移除真实项目默认值，TAPD Workspace 与 Workitem Type 改为安全空值，并统一公开项目与机器人名称 | `config.test.ts` |
| 2026-07-29 | AI 新闻默认数量从 10 提升到 15，继续保留 1–20 的配置边界，续页固定最多 20 条 | `config.test.ts`、`aiNewsRadar.test.ts` |
| 2026-07-29 | AI 新闻改为默认启用并复用现有机器人凭证，关闭开关和独立机器人凭证均为可选配置 | `config.test.ts`、`agentHost.test.ts` |
| 2026-07-29 | 增加独立的每日数据维护调度；按时区和日期幂等执行，清理失败不影响群业务 Job | `dataRetention.test.ts`、`maintenanceScheduler.test.ts` |
| 2026-07-27 | 同一 tick 复用 Job 实例，使多群超期扫描只做一次 TAPD 全量同步；业务投递告警记录为部分完成 | `scheduler.test.ts`、`jobs.test.ts` |
| 2026-07-27 | 超期扫描增加负责人接收人校验；未解析 `open_id` 时按提醒槽记录业务跳过，不再调用飞书空 `receive_id` | `jobs.test.ts`、类型检查 |
| 2026-07-27 | 公司通讯录同步改为完整非空快照：缺失成员标为离职，并停用其动态群成员配置；分页或部门请求失败时不写入，避免部分数据误判离职 | `companyMembers.test.ts`、类型检查 |
| 2026-07-27 | 超期催办开关保留在群高级配置的「其他基础配置」中；关闭后 Scheduler 不再为该群创建超期扫描或私聊提醒 | `scheduler.test.ts`、前端类型检查 |
| 2026-07-27 | Scheduler 增加周报群站会资格校验，关闭站会模块或每日推送的群不创建周报 Trigger | `scheduler.test.ts` |
| 2026-07-27 | 配置页增加周报模块与周五生成时间，Scheduler 按群时区派发 `native.weekly-report` | `scheduler.test.ts`、前后端类型检查 |
| 2026-07-23 | 超期扫描改为只催活跃未完成叶子项，开发完成、已实现、父项和完成父项子树均不进入催交 | `tapdHierarchy.test.ts`、`jobs.test.ts`、类型检查 |
| 2026-07-22 | 超期扫描改为北京时间工作日 09:00–18:30 每 30 分钟触发，配置页增加窗口、间隔和时区 | `config.test.ts`、`scheduler.test.ts`、前后端类型检查 |
| 2026-07-22 | 超期扫描从每日一次调整为每小时一次，并按实际小时建立调度幂等键 | `scheduler.test.ts`、`jobs.test.ts`、类型检查 |
| 2026-07-22 | 补充配置保存、调度重载、成员同步和 Secret 规则，精简文档结构 | CodeGraph 与配置调度测试 |
| 2026-07-22 | 建立配置与调度功能卡，明确调度不承载业务规则 | CodeGraph 架构审查 |
