---
feature_id: weekly-report
name: 项目周报
status: active
agent_mapping:
  - native.weekly-report
last_reviewed: 2026-07-28
---

# 项目周报

把开启日报站会的群在每周工作日产生的成员站会、TAPD 当前全量数据、TAPD 状态变更历史和已留存字段变更证据，聚合为一份以成员为首要视角的紧凑 HTML 周报，并支持群命令和周五定时生成后回发原群。

## 功能定位

周报是跨站会域和任务域的只读事实快照。`WeeklyReportService` 负责固定统计口径、同步外部数据、保存事实与渲染产物；Native Agent 负责接入统一 Trigger、Run、Artifact 和 Outbox。LLM 只能归纳文字，不能修改人数、提交率、任务数或任务状态。

## 实现流程图

```mermaid
flowchart TD
    U["@机器人生成本周/上周周报"] --> H["WeeklyReportHandler"]
    S["周五配置时间"] --> G{"群已开启日报站会?"}
    H --> G
    G -- 否 --> X0["提示未开启 / 跳过调度"]
    G -- 是 --> D["ScheduledAgentDispatcher"]
    D --> A["native.weekly-report"]
    A --> W["WeeklyReportService"]
    W --> T["TaskService.syncProjectScope"]
    T --> P{"TAPD 全分页同步成功?"}
    P -- 否 --> X["失败关闭，不生成旧数据周报"]
    P -- 是 --> TH["TapdAdapter /story_changes\n按统计日读取 status 历史"]
    TH --> F["事实快照"]
    ST["StandupService"] --> F
    TU["Task / TaskUpdate"] --> F
    F --> N["LLM 归纳或确定性降级"]
    N --> R["安全 HTML 渲染"]
    R --> DB["WeeklyReport 持久化"]
    DB --> O["Markdown Artifact / Outbox"]
    DB --> API["周报列表与 HTML 查看 API"]
    API --> UI["系统「周报」HTML 预览"]
```

## 能力边界

### 目标

- 支持“生成本周周报”“生成上周周报”和每周五自动生成。
- 输出一份群级 HTML：成员周度统计前置，后接本周新增、本周完成、近期超期任务和以 TAPD 原始变更历史为准的可视化状态流转。
- 保存可审计的事实快照、文字摘要、版本、数据截止时间和 TAPD 同步时间。

### 非目标

- 不从当前 TAPD 状态反推历史状态；状态历史接口不可用时明确标记不可确认。
- 不让模型直接查询 TAPD、修改业务数据或自行计算指标。
- 不为每位成员发送独立文件，群内只投递一个完整周报链接。

## 核心规则

1. **站会开关是前置资格。** 只有 `StandupService.isGroupEnabled` 判定已开启站会模块且每日站会推送未关闭的群才能生成；群命令、Scheduler 和 Service 三层一致拦截。
2. **先同步再生成。** 每次生成都执行 TAPD 全分页同步；任一页失败则本次失败，不使用不明新鲜度的任务数据。
3. **周范围按配置时区计算。** 默认 `Asia/Shanghai`；本周从周一统计到生成日或周五，上周固定为上一个周一至周五。
4. **事实与叙事分离。** `facts_json` 保存确定性指标和证据，`narrative_json` 保存 LLM 或规则摘要；HTML 中所有数字只读事实快照。当前紧凑 HTML 不展示管理叙事。
5. **状态历史直接查询 TAPD。** 每次生成按统计周期的每个自然日分页调用 `/story_changes`，指定 `change_field=status` 和 `need_parse_changes=1`；只展示与当前群成员任务匹配的原始 `field_changes`，优先使用 TAPD 解析后的中文前后值。非状态字段流转仍使用幂等 `TaskUpdate(source=tapd)`；本地 `status`（如超期派生状态）永不展示为 TAPD 流转。历史接口失败时不把“未知”写成“无流转”，而是保留已留存字段变更并明确标记状态历史不可用。
6. **任务范围复用群成员口径。** 使用 `taskBelongsToMembers` 和任务层级投影，只把当前群成员相关任务纳入，进行中数量只统计活跃未完成叶子项。
7. **站会复用统一读模型。** 每个工作日通过 `StandupService.listGroupSubmissions` 与 `buildSummaryView` 计算成员产出、计划、阻塞、风险和提交统计；HTML 不再重复展示每日站会表。
8. **成员视角优先且任务可展开。** 成员矩阵固定在任务区之前；每人只展示最多三条产出、两条近期目标和两条风险。任务按当前分类内可解析的 `parent_id` 深度优先排列，父级匹配同时接受本地任务 ID 和 TAPD Story ID，用缩进和树枝线展示父子层级，并在标题前标记 `STORY`、`DEVELOP` 或 `ARTS`；父项不在当前分类时子项作为根节点展示，异常循环通过已访问集合截断。每类初始展示八项，其余内容由原生 `details` 控件展开和再次收起；展开后的“收起任务”固定在全部内容底部。“本周任务变更”清楚标示状态来源，并完整展示可获得的流转。
9. **状态统一中文并使用语义色。** 任务和 TAPD 状态由渲染器映射为中文；任务概览不显示完成百分比，只显示状态。TAPD 流转沿用看板的深墨绿、蓝、青、琥珀、紫与红色语义，分别区分通用字段、状态、进度、优先级、负责人和截止日；旧值低对比，新值带浅色底与边框。
10. **任务时间按明确范围展示。** 开始时间读取 TAPD `begin_date`，结束时间读取任务 `due_date`，任一侧缺失显示 `-`，不把创建时间冒充计划开始时间。
11. **任务标题只链接可信 TAPD 地址。** 有 `http/https` `tapd_url` 时标题支持 hover、键盘 focus 和新标签页打开；缺少链接或协议不安全时只展示纯文本。
12. **LLM 可选。** 模型失败、空响应或非法 JSON 时自动使用确定性摘要，事实和报告仍可生成。
13. **HTML 默认不信任输入。** 群名、成员名、任务标题和站会内容全部转义；产物只写入 `data_path/weekly-reports`。
14. **访问按记录解析。** API 先按不可猜测的报告 ID 读取数据库记录，再校验文件位于周报目录且扩展名为 `.html`，不接受任意文件名。
15. **重复生成保留版本。** 同一群和周期每次成功生成递增版本，不覆盖旧文件；并发版本冲突最多重算并重试三次，失败尝试产生的 HTML 会被清理；消息和调度级重复由 Agent Trigger 幂等。
16. **投递与生成分离。** Agent 只返回加粗群名、统计周期和直达 HTML 周报的 Markdown Artifact，不在群消息中重复提交率或任务指标；链接固定指向 `/api/weekly-reports/{reportId}`，优先使用 `runtime.public_base_url` 作为服务地址前缀，未配置时使用 `http://localhost:8090`；中台「周报」菜单仍可单独查看历史，但不是群消息跳转目标；Delivery Worker 发送到触发群，报告生成成功不等于飞书已经送达。
17. **定时任务固定周五。** 群配置控制模块、开关、时间和时区；周报是周级任务，不受 `workdays_only` 节假日跳过规则影响。

## 用户能力

- 在已配置群中 `@机器人 生成本周周报`。
- 在已配置群中 `@机器人 生成上周周报`。
- 同时启用日报站会和周报模块后，在每周五指定时间自动收到直达 HTML 周报链接。
- 打开链接优先查看成员产出、近期目标和任务统计，再查看群级任务与 TAPD 流转。
- 在系统导航的「周报」中按群查看历史周报，并在页面内以贴合视口的滚动预览完整 HTML，不留下无意义空白区域。

## 入口与触发

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| 飞书群命令 | `生成本周周报` / `生成上周周报` | 进度回复、Agent Run、周报链接 |
| Scheduler | 群、周五时间、时区 | `summary.weekly.generate` Trigger |
| Agent API/主 Agent | capability 与周期 | Agent Run 与 Markdown Artifact |
| 周报列表 API | 可选群 ID | 已生成周报的安全元数据 |
| 周报查看 API | 报告 UUID | `text/html` 周报 |
| 系统「周报」菜单 | 群与历史报告 | 页面内 HTML 预览 / 新窗口打开 |

## 数据与状态

- `WeeklyReport`：群、周期、截止时间、版本、事实、叙事、HTML 路径、公开 URL、同步时间、触发类型和源消息。
- `TaskUpdate(source=tapd)`：保存 TAPD 非状态字段级变化，ID 由任务、外部修改时间和变化内容计算，重试不重复。
- `TapdAdapter.listStoryStatusChanges`：按统计日分页读取 TAPD `/story_changes` 中不可变的状态变更历史；周报只在内存事实快照中消费，不反写任务状态。
- HTML 是不可变版本产物；数据库记录是访问路径和事实快照的权威索引。

## 失败、安全与降级

- TAPD 不可用：记录 `weekly_report_failed` 并终止，不写周报记录。
- LLM 不可用：使用规则摘要，不影响事实和 HTML。
- DB 保存失败：删除刚写出的孤立 HTML 后向上抛错。
- 文件丢失、越界或记录无效：查看 API 返回 404。
- 周报 API 当前依赖部署网络边界；如开放公网，应在路由前增加用户鉴权和群权限校验。

## 代码地图

### 主要实现

- `backend/src/domains/weeklyReport/period.ts`：周范围和时区口径。
- `backend/src/domains/weeklyReport/facts.ts`：站会、任务、变更事实聚合。
- `backend/src/domains/weeklyReport/narrative.ts`：受约束的 LLM 归纳和确定性降级。
- `backend/src/domains/weeklyReport/renderer.ts`：安全 HTML 和路径校验。
- `backend/src/domains/weeklyReport/service.ts`：同步、版本、持久化与 Artifact 内容。
- `backend/src/adapters/tapd.ts`：TAPD Story、工作项类型和状态变更历史接口。
- `backend/src/agents/native/weeklyReportAgent.ts`：Agent Manifest 与 Native Adapter。
- `backend/src/services/messageHandler/handlers/WeeklyReportHandler.ts`：群命令入口。
- `backend/src/core/scheduler.ts`、`frontend/src/components/config/GroupConfigList.tsx`：周五调度和配置。
- `backend/src/index.ts`：周报列表与 HTML 查看 API。
- `frontend/src/pages/WeeklyReportsPage.tsx`、`frontend/src/layouts/MainLayout.tsx`、`frontend/src/App.tsx`、`frontend/src/api.ts`：周报导航、历史选择与 HTML 预览。

### 主要测试

- `backend/test/weeklyReport.test.ts`：周期、事实、降级、HTML、失败关闭、命令和 TAPD 变更证据。
- `backend/test/scheduler.test.ts`：周五时区调度和 Agent 派发。
- `backend/test/dashboardData.test.ts`：TAPD 全分页同步回归。

## 变更记录

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-07-29 | 将周报页面加载状态的条件表达式改为等价的显式分支，消除会阻断前端 lint 门禁的问题，加载与刷新行为保持不变 | 前端 lint、类型检查、测试、生产构建 |
| 2026-07-28 | 周报状态流转改为直接分页读取 TAPD `/story_changes` 的 `status` 历史；接口不可用时明确标记不可确认，不再误报“暂无流转”；区块更名为「本周任务变更」并标示数据来源 | `weeklyReport.test.ts`、后端类型检查 |
| 2026-07-27 | 周报状态流转只展示 TAPD 原始状态，过滤超期等本地派生状态，避免伪造状态倒退 | `weeklyReport.test.ts`、类型检查 |
| 2026-07-27 | TAPD 流转按字段增加看板主题语义色，并突出字段新值 | `weeklyReport.test.ts`、后端类型检查 |
| 2026-07-27 | 群消息链接改为直达 `/api/weekly-reports/{reportId}`；优先使用服务地址前缀，未配置时回退 `http://localhost:8090`，不再跳转中台页面 | `weeklyReport.test.ts` |
| 2026-07-27 | 周报页面将 HTML 预览固定为视口高度，移除 iframe 下方由伸展容器造成的空白区域 | 前端类型检查、生产构建 |
| 2026-07-27 | 群消息标题改为加粗；移除开发机公网地址回退；新增系统「周报」历史菜单、列表 API 和页面内 HTML 预览 | `weeklyReport.test.ts`、前后端类型检查 |
| 2026-07-27 | 群内周报消息移除提交率及任务统计，只保留群名、统计周期和完整周报链接 | `weeklyReport.test.ts` |
| 2026-07-27 | 周报父子层级兼容 TAPD Story ID，并在任务标题前展示 STORY / DEVELOP / ARTS 类别标签 | `dashboardData.test.ts`、`weeklyReport.test.ts`、本地 HTML 视觉验证 |
| 2026-07-27 | 任务概览按 `parent_id` 展示父子树，并将展开状态下的收起控件移动到列表底部 | `weeklyReport.test.ts`、本地 HTML 交互与视觉验证 |
| 2026-07-27 | 任务列表支持展开/收起、标题安全跳转 TAPD、开始至结束时间范围；修复成员表格对齐，补全指标文案，完整展示 TAPD 流转并删除冗余说明 | `weeklyReport.test.ts`、本地 HTML 交互与视觉验证 |
| 2026-07-27 | 周报改为仅对开启日报站会的群生成；HTML 改为成员矩阵前置、三类任务短看板、中文状态和可视化 TAPD 流转，移除管理摘要、每日站会表及数据提示 | `weeklyReport.test.ts`、`scheduler.test.ts`、本地 HTML 视觉验证 |
| 2026-07-27 | 新增周报事实快照、Native Agent、群命令、周五调度、HTML 访问和 TAPD 字段变更证据 | `weeklyReport.test.ts`、`scheduler.test.ts`、前后端类型检查 |
