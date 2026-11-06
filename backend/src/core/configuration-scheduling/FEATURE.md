---
feature_id: configuration-scheduling
name: 配置、通讯录与定时调度
status: active
agent_mapping: []
last_reviewed: 2026-11-06
---

# 配置、通讯录与定时调度

管理群、成员、公司目录、模块开关、运行参数与定时计划，并把确定性调度转换为带作用域的功能触发。

## 功能定位

配置与调度属于系统控制面。配置决定“哪些群、成员、机器人和功能可以运行”，调度决定“在什么时间创建一次执行”；它们不负责生成日报、统计站会或构造看板。

把控制面和业务逻辑分开，可以避免配置页面、Scheduler 和手动 Debug 入口各自实现一套业务规则。无论请求来自定时器还是管理员手动触发，最终都进入相同的业务 Service 或 Agent Runtime。

## 实现流程图

```mermaid
flowchart TD
    RETENTION_PLUGIN[可选 platform.maintenance] --> RETENTION_TICK[全局 tick：无群也执行；自主检查时刻与每日 Claim]
    RETENTION_TICK --> RETENTION_SERVICE[原 DataRetentionService：批量审计及白名单临时键]
    RETENTION_SERVICE --> RETENTION_KEEP[保留 Run、Step、Artifact 与业务事实]
    KWP[可选知识工作台插件] --> LC[本机连接与知识表单]
    LC --> LF[私有文件·校验·原子保存]
    LF --> BOOT[重启注入环境配置]
    BOOT --> PH
    PERSONAL[HTTP 默认个人组合：十六插件九 Agent] --> PH
    TEAM[显式 team.yaml：十五插件七 Agent] --> PH
    PC["可信插件配置 / 重启生效"] --> PH["Agent、Tool、Skill、消息与群调度装配"]
    PH --> COL[可选网页/文档插件及其页面、上传 API]
    COL --> E
    PH --> VIS[五类团队 Web 入口按插件装配；纪要仍隐藏]
    WREQ[本机插件 API 请求] --> WMATCH{声明方法与路径匹配?}
    WMATCH -- 是 --> WHANDLER[原 Request 交给所属 Fetch handler]
    WMATCH -- 否 --> W404[404；不解析正文或调用插件]
    VIS --> E
    PH --> E
    PH --> CONFIG_PLUGIN[builtin.configuration：原页面与 API]
    CONFIG_PLUGIN --> A[原 Config Page / API]
    A --> BODY[有界 JSON、完整动态字段与群成员身份检查]
    BODY --> B[持久化后重载；失败区分已保存和未保存]
    DIRECTORY[可选 builtin.directory；个人与空组合不装配] --> DAPI[五项本机通讯录 API]
    DAPI -- 手动写入前 --> RELOAD{宿主提供配置重载?}
    RELOAD -- 否 --> UNSUPPORTED[503；不读取或写入]
    RELOAD -- 是 --> D
    DIRECTORY --> GP[全局轮询；在逐群任务前按低频间隔执行]
    GP --> D
    C["飞书通讯录与群"] --> D["带页数/时长/总请求预算的成员同步"]
    D --> B
    D -- 单群读取失败且无成员变更 --> MSFAIL[保留原成员并记录 group_members_sync 失败结果]
    B --> E["Scheduler 重载并合并重叠 tick"]
    E --> F["按时区计算到期计划"]
    F --> HC{"群日期策略与指定日期允许?"}
    HC -- "是" --> L{"调度类型"}
    HC -- "否" --> HS["跳过，不创建执行记录"]
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
    D2["Debug 页面 / 手动 Job API"] --> OWNER{所属插件已装配?}
    OWNER -- 否 --> REJECT[404，不创建执行器]
    OWNER -- 是 --> G2{"发送到群聊?"}
    G2 -- "是" --> G
    G2 -- "否" --> U2["只执行生成/更新，不创建群投递"]
    H --> K["Outbox / 审计"]
    G --> TS["任务型站会：按 task_standup_template 时间发送群模板"]
    TS --> TR["原群提醒负责人引用回复"]
    TR --> K
    I --> K
    W --> K
    J --> K
    G -. "重复 Trigger" .-> X["记录重复触发已跳过"]
    COL --> KLIB[资料库来源；明确保存设置、重启切换]
    COL --> QCR[可选保存记录验收；无新计划任务]
```

## 能力边界

### 目标

- 配置变更可校验、可持久化，并能安全地重载 Scheduler。
- 群与成员配置为站会、日报、看板和 Bot 路由提供一致范围。

### 非目标

- Scheduler 只决定何时和以什么作用域触发，不实现业务规则。
- 配置页面不是 Agent，不需要模型参与确定性管理操作。

## 本地连接配置

工作台的「连接与模型」独立保存飞书、模型和 TAPD 配置；知识来源由可选 knowledge.workspace 界面调用该私有设置服务保存。显式插件文件管理来源时页面关闭编辑入口，避免无效覆盖；默认应用保存后重启切换。文件位于数据目录 connections.json，权限 0600、原子写入、密钥不回显；重启后应用，不热替换在途执行。启动时设置覆盖同名环境值，模型供应商/地址/名称与 TAPD 项目/地址/类型环境值优先于旧 config.json。现有动态群与计划 API 仍只保存 runtime、schedule、groups。详见 [工作台功能卡](../../platform/workspace/FEATURE.md)。

默认个人组合增加网页收集和文档导入；文档 Python 路径仅来自可信插件配置，应用不自动安装依赖，不继承模型/Azure 凭据。移除插件关闭对应页面与 API；没有新增业务计划或后台清理任务。上传过期只在下次上传时清理。

## 团队配置插件（2026-11-06）

builtin.configuration 拥有原 /config 页面和 GET/POST /api/config，使用已打包 team-configuration 视图。团队 SDK 与 team.yaml 默认包含该插件，合计十五插件、七 Agent；个人和空组合不装配。移除插件后页面、导航与 API 同时关闭；保存的系统设置、群/成员与 Run 不删除。builtin.directory 独立控制通讯录 API 与自动同步，配置插件自身不注册 Agent、Tool 或定时任务。

POST 仅接受完整的 runtime/schedule 对象和 groups 数组；groups 是完整替换快照，空数组会清空群配置，群 chat_id 与提供的成员 open_id 必须非空；现有前端已只发送这三个字段。错误/缺失字段、非法 JSON、超过 1 MiB 或读取十秒超时均在 Store 前拒绝，避免把错误请求当空群配置。旧客户端不能直接回传 GET 的整份脱敏 AppConfig；应只提交动态字段。字段的时间、日历与模块归一化仍沿用原配置加载器及 Store，不宣称新增了完整的计划语言校验。

读取始终使用 maskedConfig，HEAD 按 GET 处理。无 reloadConfiguration 的 SDK 宿主保留只读入口，POST 返回 503 且不消费正文或写入。保存调用原 saveDynamicConfig 的事务；存储失败返回 saved=false，持久化成功但重载失败返回 saved=true 与明确提示，禁止将这两种状态合并成“从未保存”。成功后返回原 ok/message/config 形状。主 index 不再注册业务配置 API，实际插件路由仍经过本机 Host/Origin 与声明检查，Host 停止先等待已接受的写入，再释放贡献。

代码地图：agents/plugins/configuration.ts、builtins.ts、profiles/agents/team.yaml；本目录 configApi.ts/publicConfig.ts；platform/workspace/requestBody.ts 共用有界正文读取，配方继续使用原 40 KiB/十秒限制；frontend/src/App.tsx、pages/workspace/PluginPage.tsx、pages.ts、layouts/MainLayout.tsx 和 pages/ConfigPage.tsx。配置入口只根据实际页面贡献出现在运行管理，其他团队业务菜单不会重复配置项。

验证：configurationPlugin.test.ts 六项覆盖脱敏与实际保存、停用/缺重载、非法/超限/中断请求零写入、存储与重载失败区分、在途清理与跨 Host 保留；pluginConfiguration.test.ts、workspaceComposition.test.ts、pluginWeb.test.ts 与 runRecipes.test.ts 回归组合及共享读取。隔离 HTTP/浏览器验证个人关闭、团队保存、只移除配置插件后的关闭及重新装配后恢复原设置；未使用真实飞书凭据验证目录权限、消息投递、模型或邮件业务。

## 核心规则

`AGENT_PLUGINS_FILE` 属于重启生效的可信代码装配配置，选择 Agent、Tool、Skill、确定性消息与群业务调度贡献。团队 SDK/显式团队组合为十二个功能/平台插件和三个模型插件，继续提供七个 Agent；移除插件关闭其指令、引用、帮助和群业务计划。builtin.directory 同时拥有通讯录 API 与自动群同步；审计维护由 platform.maintenance 独立贡献；专用外部 Agent 安装与业务服务构造仍有宿主耦合。动态业务配置重载复用同一个消息注册表，不重复装配路由。

自动调度统一通过 `backend/src/core/scheduleCalendar.ts` 判断群级 `schedule.calendar`。指定日期的触发/暂停优先于基础策略；`workdays` 使用中国工作日（含调休），`every_day` 不限制节假日，`selected_dates` 仅执行指定触发日。日期放行不绕过模块开关、任务开关或原定时刻，手动触发不受该日历限制。未配置或 `legacy` 保留原有 `workdays_only` 规则及周报、承诺到期提醒的例外；无效日期与非布尔覆盖值在读取配置时丢弃。

1. **动态配置先校验再持久化。** 配置插件要求 runtime/schedule 对象和 groups 数组；群 chat_id 与提供的成员 open_id 必须非空，格式不正确时不进入 Store。时间、日历等仍使用既有配置规范化和领域校验；前端校验只改善体验。飞书发送与模型重试次数统一限制为 0–3，非法值回退安全默认值。
2. **保存成功只代表配置已持久化。** Scheduler 当前按轮询周期读取新配置，页面提示约 30 秒内生效；配置 API 不能把未来的调度执行描述成已经成功。
3. **Scheduler 只执行插件贡献。** 群计划、日期资格、周五/跨午夜/工作窗口和模块开关由所属插件声明。 到点后写入 Job/Trigger 记录，再调用对应 Agent 或领域服务；Scheduler 不复制日报、站会和看板规则。
4. **每个群独立调度。** 群配置、时区、计划和 Bot Binding 共同确定运行 Scope，一个群失败不阻塞其他群。
5. **定时执行使用稳定幂等键并禁止本进程重入。** 功能、群、计划时间或业务日期共同识别一次执行，服务重启不会重复完成同一业务动作；前一轮 `tick` 尚未结束时，后续 tick 复用同一进行中 Promise，不并行启动另一轮扫描。同一分钟的后续轮询若由 Agent Trigger Store 判定为 `duplicate`，只记录 `job_duplicate_skipped`，不能再次记录任务完成。
6. **计划任务只重试临时失败。** 当前调度链路对可重试失败额外尝试一次，并分别记录每次尝试；供应商给出 `Retry-After` 时优先使用，明确不可重试的权限、参数、月额度耗尽、分页预算耗尽或分页游标异常直接失败。Native Agent 的错误码和 `retryable` 必须穿透 Dispatcher，不能在外层重新变成默认可重试错误。业务副作用仍需自身幂等，发送跳过或拒绝记录 `completed_with_warnings`，不得伪装为干净完成。
7. **通讯录同步采用低频保守快照和硬预算。** 群成员后台自动同步默认每 6 小时一次，管理员手动同步立即执行；群/群成员通用分页最多 100 页、总计 30 秒。公司通讯录的部门及逐部门成员分页各最多 100 页，整次最多 200 个请求、60 秒；缺失或重复游标立即以不可重试错误终止。群成员职务查询按 Bot Adapter 缓存 24 小时、最多 5000 人。飞书返回空列表、分页不完整或请求失败时保留最近成功成员，不用异常结果清空配置；仅在完整的非空公司通讯录快照成功时，将本次缺失的公司成员标为离职，并同步停用其群成员配置。
8. **Secret 只保存引用。** 密钥不进入普通动态配置、前端完整响应、日志、Prompt 或 Artifact。
9. **模块开关影响入口，不改变历史数据。** 关闭功能停止新的调度和消息处理，但不删除既有记录。
10. **超期扫描限制在工作窗口且可按群关闭。** `overdue_scan_enabled` 是每个群的总开关，关闭后 Scheduler 不创建该群的扫描或私聊提醒；开启时默认使用 `Asia/Shanghai`，在工作日 09:00–18:30 每 30 分钟扫描；开始、结束、间隔和时区分别由 `overdue_scan`、`overdue_scan_end`、`overdue_scan_interval_minutes`、`overdue_scan_timezone` 配置。每次扫描的幂等键包含北京时间业务日期和实际时分。
11. **扫描频率与提醒频率分离。** Scheduler 只按半小时创建扫描；任务域按 10:00、16:00 或整点提醒槽决定是否私聊。18:30 扫描用于重试 18:00 的失败提醒，不创建 18:30 提醒；旧配置 `task_reminder_frequency_hours` 不再参与提醒判断。
12. **调度不判断任务是否可催。** 同一 tick 复用一个 `ScheduledJobs`，所有到期群共享一次 TAPD 全分页同步；任务域再对相邻 30 秒的其他日报、看板或周报请求复用成功刷新并合并并发。单次 TAPD 项目同步最多 50 页、30 秒；预算耗尽标记为不可重试，其他临时失败不缓存并允许 Job 重试。同步成功后由任务域选择唯一提醒群和活跃叶子项；负责人未解析、临时失败或永久拒绝由业务结果统计，Scheduler 记录部分完成。
13. **周报按周五、显式时区和站会资格触发。** `weekly_report`、`weekly_report_timezone`、`weekly_report_enabled` 和 `module_weekly_report_enabled` 分别控制时刻、时区、任务开关和模块开关；此外必须由 `StandupService.isGroupEnabled` 判定该群已开启日报站会。周报仍固定周五；沿用原规则时不受 `workdays_only` 跳过，选择新日期策略后按周报配置时区的日期统一过滤。
14. **全局维护任务独立于群业务任务。** 默认每天 `Asia/Shanghai` 03:30 清理 90 天以前的审计日志、临时调度幂等记录、`feishu:event:` 入站去重键和 `history-sync:` 历史补齐完成键；使用日期幂等键、批量上限和内部错误隔离，一个维护失败不能阻塞任一群的业务 Job。
15. **AI 新闻默认复用现有机器人。** 未设置 `AI_NEWS_ENABLED` 时功能保持启用，直接使用 `bot-default` 和已有 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`；默认单页为 15 条，`AI_NEWS_DEFAULT_LIMIT` 可在 1–20 范围覆盖。“查看更多”固定使用下一批最多 20 条。`AI_NEWS_ENABLED=false` 只关闭新入口，不删除历史 Run。只有配置了不同的 `FEISHU_AI_NEWS_APP_ID` 时才创建独立 BotInstance，并通过 Secret 引用读取对应 App Secret。
16. **公开版集成配置默认不连接真实租户。** `TAPD_WORKSPACE_ID` 默认值为 `0`，`TAPD_WORKITEM_TYPE_ID`、飞书凭证和模型密钥默认留空；使用者必须显式提供自己的测试或生产配置。
17. **调度不得吞掉业务降级语义。** 日报、站会汇总和周报的 AI 失败由对应业务服务记录并生成带说明的确定性版本；Scheduler 仍把该次业务投递视为已执行，不能移除降级提示或再次调用模型重生成。
18. **普通站会与任务型站会独立调度。** 普通站会使用 `standup_push`，任务型站会使用独立的 `task_standup_template`；两者都受站会模块总开关约束，但互不依赖，可单独开启或同时开启。任务型模板按群和业务日期持久化领取，`standup_push_enabled` 关闭不会阻止任务型模板发送。
19. **任务型站会使用轮询到期扫描。** Scheduler 每轮调用站会域检查该群已到交付时间且未完成的承诺事项。提醒按任务、交付时间和负责人持久化领取，同一交付时间只发送一次；单群扫描失败记录审计但不阻塞其他群及常规定时任务。
20. **手动触发默认不发群。** Debug 页面和 `/api/jobs/:jobName` 的 `sendToGroup` 只有明确为 `true` 才发送群消息；关闭时仍执行日报生成、看板快照、站会统计及其他数据更新，站会/任务的私聊提醒不因该开关关闭。

## 插件拥有的手动任务

Debug 与 /api/jobs 统一使用 PluginWebRegistry 的 manualJobs。站会声明六项，任务/日报/看板各声明一项，默认仍为九项；空组合拒绝所有原有业务手动任务，不再回退全局执行器。执行遵守原有日期、工作日、预览与 sendToGroup；Host 停止等待在途任务。它是原有确定性 Job 的选择协议，不是另一种工作流语言或任意命令入口。

来源设置新增 library，明确选择应用资料库；不接受另一个写入目录。宿主用启动时实际 data_path 装配对应 Markdown 来源；保存后仍需重启。资料库插件创建独立范围目录并在启动时恢复自身暂存，无新增定时器。默认 HTTP 为十四个插件/九个 Agent，显式组合优先。验证：backend/test/knowledgeLibrary.test.ts 及 workspace.test.ts。

默认个人组合增加独立结果验收插件，无新增定时器或外部连接；SDK 默认组合保持。规则来自已装配 FeaturePlugin.checks，不能经页面上传新 Schema 或脚本。卸载提供者释放规则，卸载 quality.checks 关闭页面/API/Agent。验证：backend/test/pluginChecks.test.ts。

## 默认个人与按需团队

HTTP 不再隐式加载团队插件。团队业务导航由可见团队页面或手动任务决定；定时配置入口与 /api/config 现由 builtin.configuration 拥有，仅在装配该插件时提供。默认个人组合没有团队业务任务/站会、看板及周报插件 API。飞书/TAPD 仍可填写并保存连接，但使用相应业务需要显式选择 profiles/agents/team.yaml；切换同一目录保留配置与历史。验证：backend/test/workspaceComposition.test.ts、frontend/src/pages/workspace/pages.test.mjs 与浏览器个人/团队切换。

## 用户能力

- 群高级配置「自动任务日期与节假日」支持四种策略、日历选择具体日期并设置触发或暂停；同日再次添加会更新，移除后恢复基础策略。例外日期仍沿用各任务时刻，不新增单日专属时刻。
- 超期扫描和周报按各自配置时区判断日期；其他任务沿用服务器本地日期，跨午夜补充汇总仍按被汇总的业务日期判断。全局维护、通讯录同步、公开源/Discord 轮询及已入 Outbox 的投递不受群日历限制。

- 配置群、项目、成员、邮箱、Bot 绑定和功能开关。
- 同步飞书群成员与公司通讯录。
- 设置日报、周报、站会、看板和超期催办计划；可在每个群的高级配置「其他基础配置」中开启或关闭超期催办，并通过 Debug 页面或 Agent API 手动验证任务。
- 在站会收集模块中单独开启任务型站会并设置任务模板发送时间；它可与普通站会并行，也可独立使用。

## 入口与触发

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| Config API/页面 | 配置 Patch 或同步动作 | 保存结果与当前配置 |
| 服务启动/配置重载 | 持久化配置 | Scheduler 任务注册 |
| Scheduler | Cron、群、Bot、业务参数 | Agent Trigger 或 Job Execution |
| Debug 页面/API | Job、群、日期、`sendToGroup` | 业务执行结果；按开关选择群投递 |

## 运行逻辑

1. Config Page 调用后端 API 读取或提交受 Schema 约束的配置。
2. Core Config 合并允许字段并持久化，Secret 只保存引用或受控值。
3. 群成员/公司目录服务通过飞书 Adapter 同步身份数据；公司目录完整快照会停用缺失成员及其动态群成员配置，空或失败结果不写入。
4. Scheduler 根据启用模块和计划重建任务；一般计划按配置时刻触发，超期扫描按显式时区、工作窗口和扫描间隔触发。
5. 到期任务创建 Job/Trigger 执行记录，再调用站会、日报、周报、看板或超期扫描入口；Agent Trigger 命中同一幂等键时记录“重复触发已跳过”，不伪装成第二次完成。同轮传统 Job 复用一个 `ScheduledJobs`，普通站会和任务型站会分别按 `standup_push`、`task_standup_template` 触发，超期扫描只做一次 TAPD 同步。周报只对开启日报站会的群在配置时区周五触发，超期扫描由任务域判断唯一提醒群和活跃叶子项。
6. Debug 页面调用手动 Job API；后端只接受布尔 `sendToGroup`，默认关闭。关闭时业务方法仍生成 Artifact、快照或统计并写审计，但跳过群消息发送；定时任务不经过该选项，保持原有投递行为。

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
- 调度幂等键至少包含功能、群、计划时间或业务日期；任务型站会模板使用 `standup-task-template:<group>:<date>`，超期扫描包含时区内的实际执行时分，同一半小时扫描不能重复执行。
- 任务提醒槽和原子发送领取由任务域持久化。扫描执行成功不等于已经发送提醒；临时失败时下一个扫描周期可重试，永久接收人错误按负责人和槽位抑制，负责人未解析时同槽只记录一次。存在跳过或失败时 Job 状态为 `completed_with_warnings`。

## 失败、安全与降级

- 虽为内网系统，配置接口仍应限制到管理员或可信网络边界；不能依赖前端隐藏按钮。
- Secret 不得进入日志、Agent Prompt、Artifact 或前端完整响应。
- 通讯录同步失败时使用最近成功快照并记录时间，避免错误清空成员。
- 非法 Cron、时区或群/Bot 绑定必须在保存前拒绝。
- 定时报告中的 AI 降级由业务 Job 负责审计和显式展示，不能因为定时链路仍成功投递就丢失失败证据。

## 代码地图

### 主要实现

- `backend/src/platform/workspace/jobsApi.ts`、`backend/src/platform/plugins/web.ts`：手动入口所有者、装配状态与生命周期。

- `backend/src/core/scheduleCalendar.ts`：共享日期规则、旧配置兼容与日期值规范化。
- `frontend/src/components/config/ScheduleCalendarEditor.tsx`：受控日期策略与日历选择表单。

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

- `backend/test/pluginWeb.test.ts`：默认/空组合、非法日期、预览、投递和停机等待。

- `backend/test/schedulePlugins.test.ts`：群调度贡献、空组合、插件禁用、错误隔离与在途停止。

- `backend/test/scheduleCalendar.test.ts`：节假日、调休、日期覆盖、时区、旧规则与调度入口。

- `backend/test/config.test.ts`：配置校验和持久化。
- `backend/test/scheduler.test.ts`：计划注册与执行。
- `backend/test/dataRetention.test.ts`、`maintenanceScheduler.test.ts`：维护配置、每日领取和失败隔离。
- `backend/test/jobs.test.ts`、`jobExecution.test.ts`：业务 Job 和记录。
- `backend/test/groupMembers.test.ts`、`companyMembers.test.ts`：成员同步、完整目录快照和离职停用。

本批验证：`backend/test/projectVisibilityApi.test.ts` 覆盖插件关闭后的读写拒绝、文件边界、计划校验和审计；`frontend/src/pages/workspace/pages.test.mjs` 覆盖旧看板链接的所有权。配合后端全量回归、前端门禁和桌面/移动端浏览器验收。

后台 syncAll/syncGroup 即使没有成员变更，只要包含单群失败也记录 group_members_sync，避免 scheduler 模式静默丢失失败。失败不覆盖现有成员，专项覆盖两个入口。

## 变更记录

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-11-05 | 手动 Job API 随功能插件授权，保留原调度执行与审计规则 | 插件 Web/站会 API 专项、后端回归、前端检查及默认/空配置/MCP 浏览器验收 |
| 2026-11-05 | 新增可填写连接与私有文件保存，明确重启和环境优先级 | 工作台专项、后端回归、前端检查与本地浏览器验收 |
| 2026-11-05 | 群业务调度改为可释放插件贡献，新增外部 AI Hot 调度插件；空组合不隐式执行群任务；停机等待本轮结束 | 调度/日历/插件回归、后端 428 通过 / 1 TAPD 跳过、类型检查 |
| 2026-11-05 | 插件组合扩展到消息指令、引用与帮助；动态配置重载复用共享注册表，业务调度边界保留 | 插件配置、消息与调度全量回归、类型检查 |
| 2026-11-05 | 增加可信 YAML Agent 插件选择与本地/已安装包加载；未启用模块不导入，消息 AI/新闻分流检查实际 Capability | 配置加载、插件/Host 测试与后端全量回归 |
| 2026-07-29 | 公开版移除真实项目默认值，TAPD Workspace 与 Workitem Type 改为安全空值，并统一公开项目与机器人名称 | `config.test.ts` |
| 2026-10-05 | 自动调度增加群级节假日策略与日历日期覆盖，保留旧配置兼容 | `scheduleCalendar.test.ts`、`scheduler.test.ts`、`config.test.ts`、前后端类型检查 |
| 2026-08-19 | 普通站会与任务型站会拆分独立时间和调度任务；手动触发页增加独立任务型模板任务 | `jobs.test.ts`、`scheduler.test.ts`、前后端类型检查 |
| 2026-08-12 | 站会模块增加群级任务型站会开关；Scheduler 每轮扫描任意交付分钟并按持久化领取在原群提醒，配置页说明与默认值同步 | `jobs.test.ts`、`scheduler.test.ts`、前后端类型检查 |
| 2026-08-13 | 手动触发页增加“发送到群聊”开关，默认关闭；关闭时仍执行数据生成/更新，仅跳过群投递，定时任务行为不变 | `jobs.test.ts`、`jobExecution.test.ts`、前端 `typecheck` / `lint` / `build` |
| 2026-08-04 | Agent 定时任务命中重复 Trigger 时改记 `job_duplicate_skipped`，不再在同一分钟产生第二条“任务完成”审计 | `scheduler.test.ts`、前端日志类型检查 |
| 2026-08-03 | 群与通讯录分页增加重复/缺失游标、页数、总请求和总时长熔断；Scheduler 合并重叠 tick；TAPD 同步限制 50 页/30 秒并穿透不可重试错误；外部重试配置限制为 0–3 | `adapters.test.ts`、`dashboardData.test.ts`、`scheduler.test.ts`、`config.test.ts`、全量回归 |
| 2026-08-03 | 日报飞书历史分页预算、超时与游标保护错误标记为不可重试，防止 Scheduler 在异常分页后重新执行整份历史同步 | `adapters.test.ts`、`jobs.test.ts`、`scheduler.test.ts` |
| 2026-08-03 | 群成员后台同步由 30 分钟降为 6 小时，职务缓存 24 小时；TAPD 相邻功能刷新合并并发并复用 30 秒；维护清理历史同步完成键 | `adapters.test.ts`、`dashboardData.test.ts`、`dataRetention.test.ts`、全量 Scheduler 回归 |
| 2026-08-03 | 调度重试识别不可重试错误与供应商等待时间；维护任务纳入过期飞书事件 Claim | `scheduler.test.ts`、`dataRetention.test.ts` |
| 2026-07-31 | 明确定时日报、站会和周报在 AI 失败时由业务 Job 保持投递并携带降级说明，Scheduler 不重生成或隐藏失败证据 | `jobs.test.ts`、报告域回归 |
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

## 模型提供者配置

AI_PROVIDER=ollama 且 API 地址为空时使用 http://127.0.0.1:11434/v1，不要求 AI_API_KEY。默认/团队组合显式增加三个模型插件，Agent 和业务任务数量不变；连接文件仍按原私有保存与重启规则生效，配置诊断不等于连接探测。 完整协议、实现与验证边界见[模型提供者功能卡](../../platform/models/FEATURE.md)。验证：backend/test/modelProviders.test.ts、knowledgeAnswer.test.ts、personalResearch.test.ts 及既有回归。

```mermaid
flowchart LR
    MP_PLUGIN[显式模型插件] --> MP_REG[Host 共享模型网关]
    MP_REG --> MP_RUN[原有 Agent 或生成管线]
```

## 插件 API 声明分发边界（2026-11-06）

PluginWebRegistry 注册时为每项 API 建立现有 Elysia 路由；前缀只标识所有者，方法与路径必须匹配声明才进入原 Fetch handler。未知路径、未声明方法和已释放贡献返回 404；本机来源检查与 Host 停机等待保持。代理不预先解析正文，参数路径、通配与 ALL 沿用应用路由规则。可信原生插件仍需自行校验参数、数据范围与写入授权。

代码：backend/src/platform/plugins/web.ts。验证：backend/test/pluginWeb.test.ts 先复现前缀内未声明请求返回 200，再覆盖直接/HTTP 两个入口、声明匹配、原始 POST 正文、不读取错误正文、处理器未调用、卸载、初始化回滚与在途等待；现有业务 API 回归检查声明完整性。

## 通讯录独立插件（2026-11-06）

builtin.directory 拥有原五项 /api/feishu API 与 directory.members-sync 全局轮询，不新增 Agent。团队 SDK/显式 team.yaml 为十三插件七 Agent，个人默认和空组合不安装；停用不读取飞书、不改写既有成员或历史。Scheduler 不再导入成员服务，global-poll 在逐群任务前执行，HTTP 保留六小时低频与尝试时间记录；第三个构造参数位置保持，SDK 默认一小时、非正值禁用。同步继续调用原 GroupMemberSyncService / CompanyMemberService，保留分页预算、空/失败快照保护、离职停用与审计。

Host 可选 reloadConfiguration 只供可信原生插件重载应用配置；HTTP 注入原 reloadConfig。手动写入在缺少回调时返回 503，不先读取或写入；变化后重载并脱敏返回配置。读取、全局同步、生命周期清理与停机等待复用现有平台。同步写入后重载失败仍返回错误，不能声称回滚。

代码：agents/plugins/directory.ts、core/configuration-scheduling/api.ts / publicConfig.ts、platform/scheduling/registry.ts、core/scheduler.ts、platform/plugins/contracts.ts、platform/bootstrap/agentHost.ts、index.ts、agents/plugins/builtins.ts、profiles/agents/team.yaml（均在 backend）。验证：backend/test/directoryPlugin.test.ts（五接口、脱敏、禁用零调用、重载条件、逐群前同步、六小时间隔、失败保留与停机等待），schedulePlugins.test.ts（无群全局轮询、频率、错误隔离）及原群同步、配置、调度和插件回归。

配置页同步：frontend/src/pages/ConfigPage.tsx 根据实际 builtin.directory 装配状态使用 SWR 请求群列表；缺少插件时不挂载通讯录树，GroupConfigList 停用远端刷新、保留成员配置并允许直接输入群 ID。配置保存与业务表单保持。验证包含前端类型/lint/测试/构建与本地禁用状态浏览器检查。


## 运行链接与调度授权边界（2026-11-06）

共享 WebContribution 新增 runLinks，只贡献成功根运行到已装配页面的导航；不注册 manualJobs、定时器或新的调度权限。声明校验与释放覆盖于 backend/test/pluginWeb.test.ts；知识重新回答由用户明确发起个人 manual 根运行，详见 [知识回答](../../knowledge/answer/FEATURE.md)。

## 审计维护插件（2026-11-06）

原维护任务现由 platform.maintenance 拥有，注册 maintenance.cleanup / global-tick，不新增 Agent。个人默认十六插件/九 Agent、GitHub 组合十八插件/十 Agent、团队 SDK/profile 十五插件/七 Agent；显式空组合或未包含该插件的独立文件不再隐式清理。base: personal 继承维护插件；可用 MAINTENANCE_ENABLED=false 关闭执行。安装插件不改变原九十天保留、03:30 Asia/Shanghai、每批五百条/最多二十批的默认策略。

Scheduler 先执行到期 global-poll，再执行每 tick 的 global-tick，随后处理既有 Outbox 和逐群任务；同一阶段按 priority 排序。global-tick 无 group、不受低频轮询间隔或群日历限制，插件自己判断时刻、领取每日键和记录结果。维护失败保留失败凭证并继续其他任务；全局贡献抛出错误仍走 scheduler_poll_failed。停止先拒绝并等待在途 tick，再释放贡献，不删除历史。

DataRetentionService 策略未改：只删除严格早于保留边界的审计和 scheduled:/maintenance:/feishu:event:/history-sync: 四类有效过期键；不扩展到 Agent Run、Step、Artifact、业务消息或未知/无有效时间键。审计与临时键共用单次批数预算，可能分多日消化积压；每日失败不在同日自动重试。

代码地图：backend/src/agents/plugins/maintenance.ts、builtins.ts；platform/scheduling/registry.ts；core/scheduler.ts / dataRetention.ts；platform/workspace/knowledge.ts；profiles/agents/team.yaml。验证：maintenancePlugin.test.ts（空组合零清理、时刻/批量/跨 Host 每日去重、关闭、失败隔离、在途停止与阶段顺序），maintenanceScheduler.test.ts 显式安装维护贡献，dataRetention.test.ts 保留策略不变；workspaceComposition.test.ts / pluginConfiguration.test.ts 及导出组合测试同步数量。另在全新临时 SQLite 中生成真实 Echo Run，验证分批清理、四类临时键、历史三条 Run/Step/Artifact 字节不变与卸载释放；不使用模型或个人库。
