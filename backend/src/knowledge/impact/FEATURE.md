---
feature_id: knowledge-change-impact
name: 知识变更与历史产物复核
status: active
agent_mapping:
  - native.knowledge-impact
last_reviewed: 2026-11-05
---

# 知识变更与历史产物复核

检查历史回答和发布草稿实际引用的知识版本，标记需要复核、无法核验或内容未变化，保存原产物与证据。

## 功能定位

`knowledge.impact` 是独立确定性功能插件。选择 Markdown 或网页来源版本 Tool，通过现有 Run/Artifact 存储读取指定历史运行，并保存独立评估。它不调用模型、不复制来源读取、不修改原 Artifact。

当前是显式选择 Run ID 的本地检查，不是全库自动监控或文件变更推送。本机工作台已提供原结果的显式复核入口；自动索引和全局变更提示仍待实现；本功能提供其来源身份、版本协议和评估记录。

## 实现流程图

```mermaid
flowchart TD
    FS[可选 CLI 状态：已有文件仅元数据检查] --> LK[SQLite 独占会话锁]
    LK --> U
    U[本地 CLI --state --check-run / SDK / 工作台插件动作] --> P[Cordis: knowledge.impact]
    P --> V[校验个人 Scope、最多二十个 Run]
    V --> R[先核对所有目标 Run 的 workspace 与 bot]
    R --> A[读取原 JSON Artifact，核对引用并提取实际被引用知识]
    A --> B[CAS 领取目标评估版本]
    B --> S{需要当前来源核验?}
    S -- 否 --> N[无知识引用或旧证据身份不足]
    S -- 是 --> T[Tool Gateway: 来源 versions]
    T --> C[同名来源身份、当前版本、可用性与范围]
    C --> O[分别判断变化、缺失、不可读与范围不匹配]
    N --> O
    O --> G[CAS 写独立最新评估，旧检查不得覆盖新检查]
    G --> J[检查报告 Artifact]
    A -. 原产物与原引文保持 .-> H[历史证据]
    L[CLI --impact-status / 动作状态 GET] --> K[只读取最近评估与检查时间]
    K --> PANEL[StatusPanel 1.0：时间、引用版本与检查记录]
    J --> PANEL
    PANEL --> NAV[原结果与独立检查报告互相查看]
```

## 能力边界

### 目标

- 只对有记录的实际引用建立文档依赖，未被引用的命中片段不造成误报。
- 检查更新、删除/改名、来源失效、排除项与错误来源，保留旧证据。
- 使用可选本地 SQLite 保存跨进程记录和评估，不需要模型密钥或服务器。

### 非目标

- 不判断语义影响、结论正确性、规则适用性或没有记录引用的隐含依赖。
- 不自动重生成、执行外部写入、全库扫描历史 Run、持续监控或发送通知。
- 不提供共享 Web 身份、多用户权限或敌对本机进程的文件系统沙箱。

## 核心规则

1. 仅允许无 chatId/conversationId 的手动或 Agent Scope。一次最多二十个不同 Run；必须先核对全部目标的 workspaceId/botInstanceId，再读取 Artifact。这个入口检查不是认证。
2. 当前支持成功的 knowledge.answer 与 release.prepare。必须有一个受支持的 privateKnowledge JSON Artifact。检查其中实际 claims / draft citations，重新验证引用身份和精确 quote，再提取被引用知识；发布草稿的 GitHub 事实不作为知识源依赖。
3. 多个片段引用同一文档版本合并，保留 citationIds。最多每个产物十个知识文档，总共二百个版本请求，来源 Tool 在一次刷新中比较，不按查询词重搜旧引用。
4. 新引用携带 sourceKind/sourceKey。Markdown 身份绑定逻辑来源 ID 与 canonical root；网页身份绑定来源 ID 与原始规范 URL。相同相对路径出现在其他 Vault 时不能据此核验旧资料。路径迁移或来源 ID 改变会要求重新确认范围。
5. 引用 ID 也绑定来源身份；旧 Artifact 保持原引用，不迁移或伪造旧身份。缺少新身份的记录返回 legacy_unverifiable，不能按当前目录猜测来源。
6. 文档版本相同为 current，不同为 changed。Markdown 在成功扫描范围内找不到旧路径时为 missing；改名按旧路径缺失处理。读取/解析失败为 unavailable，排除/符号链接/来源身份不匹配为 out_of_scope。网页请求失败不能证明页面删除，因此为 unavailable。
7. 目标有 changed/missing 时 needs_review；只有全部可核验且版本相同才为 current。其余未知情况为 unverifiable；没有实际知识引用为 not_applicable。current 仅表示文档字节/提取版本吻合，不证明旧结论仍正确。
8. 使用文档级版本：同一被引用文档的其他段落变化也会要求复核，不宣称精确判断语义影响。未引用文档的修改不影响结果。
9. 根目录/整轮读取失败或跨插件协议不一致时，把本次检查记为 unverifiable，不回退旧 current。取消则中止运行，留下的不完整评估在 status 中显示 check_incomplete。
10. 每次检查以 CAS 领取新 revision；完成时仅更新自己仍持有的 revision。后完成的旧检查不能覆盖更新检查。独立检查 Artifact 仍记录其实际结果，并返回 recordedAsLatest。
11. 原 Run/Artifact/正文/引文不修改。评估按 workspace/bot/目标 Run 独立保存；状态读取返回最近评估及其 checkedAt，不刷新来源，不声称是当前实时状态。
12. knowledge.review 动作由本插件注册，匹配成功的回答/发布 Run。GET 只读评估；POST 固定一个目标 Run，经既有 Capability 执行，不重新调用模型。文本面板显示检查时间；旧检查未成为最新评估时明确提示，不伪装最新结论。卸载插件不删除历史。
13. CLI 默认仍为内存；显式 --state 才保存记录。文件私有权限、专用数据库身份和独占会话锁由 SQLitePersistentKeyValueStore 提供。同一状态文件不允许两个 CLI 同时启动 Host，避免重启恢复误标仍活跃的运行。

## 用户能力

- 保存回答/发布草稿，之后修改知识并按旧 Run ID 检查受影响结果。
- 区分内容变化、文档缺失、来源不可读和选错来源。
- 无模型读取最近一次评估，查看检查时间与原产物 ID。

## 入口与触发

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| 工作台「检查引用变化」 | 当前成功回答/草稿 | 独立检查 Run、缓存状态与报告跳转 |
| knowledge.impact.check | runIds、可选 operation=check/status | 独立评估、原 Artifact ID 与检查报告 |
| knowledge.ts --check-run | 目录或网页、原状态文件、重复 Run ID | 刷新来源并检查 |
| --impact-status | 同一状态文件、--check-run | 最近评估，不发起来源读取 |
| --state | 新建或既有专用私有 SQLite 文件 | 跨 CLI 进程运行记录；不持久化来源索引 |

## 运行逻辑

1. 验证并读取目标，提取实际引用与来源身份。
2. 为选定目标领取评估 revision。
3. 通过一次来源 versions Tool 检查唯一文档版本，或明确返回不可核验。
4. 形成每个目标的独立结论，经 CAS 保存最新状态并产生新的检查 Artifact。
5. 显式 status 只读取评估缓存；需要实时核验时重新 check。

## Agent、Tool 与服务边界

| 对象 | 职责 | 禁止承担 |
| --- | --- | --- |
| Impact Native Agent | Scope、取证、预算和报告编排 | 调用模型或读取任意目录 |
| Impact Service | 原引用提取、目标归属、评估 CAS | 修改历史产物或证明语义 |
| 来源 versions Tool | 固定范围当前版本与可用性 | 静默切换来源或猜测旧身份 |
| SQLite Store | KV 原子操作、持久化和本地单会话 | 替代应用认证或多机数据库 |

## 本地状态锁保护

CLI 状态文件与会话锁文件仅在不存在时独占创建，创建/关闭在同步段内完成；已有文件通过 lstat 验证常规文件、单链接与私有权限，不额外打开并关闭它们。这样重复打开被拒绝后，不会因原始文件句柄 close 取消同进程的 SQLite POSIX 锁，另一进程仍不能进入活跃状态会话。 原因见 [SQLite 官方锁说明](https://www.sqlite.org/howtocorrupt.html#posix_close_bug)。

## 数据与状态

- 原证据仍在原 Artifact；独立评估只保存引用路径/身份/版本/片段 ID，不复制旧正文。
- 最新状态键为 knowledge:impact:workspace:bot:targetRun 的编码组合，CAS revision 防止检查竞争。
- SQLite 记录包含其他原 Run/Tool/Artifact 中的个人问题、原文片段和仓库事实；不是加密存储。默认文件 0600/新目录 0700，使用者仍需管理备份和设备访问。
- .lock 使用独立 SQLite 独占事务作为操作系统会话锁，不以 PID 或超时猜测进程存活；锁与状态提交分离，进程意外退出后锁释放、已提交数据保持。

## 失败、安全与降级

来源失败、未知旧格式和未完成检查不会显示为 current。另一个 workspace/bot 的目标整体拒绝。状态文件拒绝符号链接、硬链接、共享文件权限和其他应用的数据库；当前支持符合 POSIX 私有权限语义的本地文件系统（如 macOS/Linux），不支持网络共享或多个后端共同打开同一状态文件。

## 代码地图

### 主要实现

- `backend/src/knowledge/impact/plugin.ts`：检查编排、协议核对、插件动作和 Artifact。
- `backend/src/knowledge/impact/presentation.ts`：评估到通用文本面板，拒绝缺少证据/时间的绿色状态。
- `backend/src/knowledge/impact/service.ts`：原引用提取、Scope、CAS 与缓存。
- `backend/src/knowledge/impact/webPlugin.ts`：网页版本来源组合。
- `backend/src/knowledge/versions.ts`：版本请求/响应协议。
- `backend/src/knowledge/markdown/source.ts`、`backend/src/knowledge/web/source.ts`：来源身份与版本读取。
- `backend/src/platform/persistence/sqliteStore.ts`：私有本地状态实现与会话锁。
- `backend/src/scripts/knowledge.ts`、`backend/src/scripts/release.ts`：可选持久化和检查命令。
- `backend/profiles/agents/knowledge-impact-demo.yaml`、`backend/profiles/agents/knowledge-web-impact-demo.yaml`：独立组合。

### 主要测试

- `backend/test/runActions.test.ts`、`backend/test/workspaceActions.test.ts`：状态不刷新、显式复核、原 Artifact 不变、独立报告与错误呈现。

- `backend/test/knowledgeImpact.test.ts`：引用准确性、变化/缺失/失败/范围、旧格式、Scope、竞争、网页与真实跨进程 CLI。
- `backend/test/localState.test.ts`：重开、原子 KV、权限、拒绝外部数据、并发进程和强制退出后的恢复。
- `backend/test/knowledgeAnswer.test.ts`、`backend/test/releasePreparation.test.ts`：原生成与引用回归。

## 变更记录

| 日期 | 变更 | 验证 |
| --- | --- | --- |
| 2026-11-05 | 插件贡献工作台复核动作、检查时间与原结果/检查记录跳转，保持历史证据不变 | 插件动作/API 专项、后端回归、前端检查与桌面/375px 浏览器验收 |
| 2026-11-05 | 修复已有 CLI 状态文件的文件检查释放 POSIX 会话锁，重复拒绝不能放行其他进程 | 本地状态与知识复核专项、类型检查、后端回归 |
| 2026-11-05 | 新增显式历史知识复核、稳定来源身份与本地持久化 | 15 项新增专项；干净安装类型检查与后端 502 通过 / 1 TAPD 跳过；跨进程模拟模型验证，不连接服务器或执行外部写入 |
