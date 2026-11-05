# 本地使用自己的 Markdown / Obsidian 笔记

当前支持只读文件源、内容版本、链接关系、增删改同步、关键词检索，以及显式启用的 RAG 回答。query/sync 默认只在本机检索；ask 将问题和选中片段发送给配置的模型。网页接入和知识回写尚未实现。来源契约见[来源功能卡](../backend/src/knowledge/markdown/FEATURE.md)，生成与引用检查见[回答功能卡](../backend/src/knowledge/answer/FEATURE.md)，后续目标见[设计方案](PERSONAL_KNOWLEDGE_DESIGN.md)。

## 先运行虚构样例

在仓库的 `backend` 目录执行：

```bash
bun install --frozen-lockfile
bun run src/scripts/knowledge.ts --root examples/knowledge-vault --query 'API 迁移说明'
```

返回 `runId`、`status`、来源同步报告和 `hits`。命中项包含 `path`、`documentVersion`、`lineStart/lineEnd`、`excerpt` 与 `citationId`。样例来自仓库内两份虚构笔记，不是模型生成的演示结果。

只查看同步状态：

```bash
bun run src/scripts/knowledge.ts --root examples/knowledge-vault
```

这些 query/sync 命令不需要模型密钥、飞书或 TAPD。CLI 只启动本地 Host，运行记录和索引保存在内存；不启动 HTTP 服务，也不连接消息平台。

## 连接选定笔记目录

将路径替换成你选择的文件夹；不必连接整座 Vault。

```bash
bun run src/scripts/knowledge.ts \
  --root /path/to/selected-vault \
  --exclude Private \
  --exclude Archive \
  --vault-name 'My Vault' \
  --query '发布规则' \
  --limit 5
```

`--exclude` 可以重复，表示相对于 root 的文件或目录前缀，不能使用 glob、绝对路径或 `..`。隐藏路径（包括默认 `.obsidian`）、符号链接均跳过。自定义的非隐藏配置目录需要显式排除。

`--vault-name` 可选，用于生成 `obsidian://open` 原文打开链接。名称应与本机已打开的 Vault 匹配；远端挂载路径不等于本机 Obsidian 路径。URI 用于打开原文，不能授予文件读取权限。

输入目录仅来自启动配置，工具查询不能覆盖 root。笔记内容不会触发脚本或外部动作。解析、索引和关键词检索在本机完成；生成式回答的片段去向见下文。

## 根据资料生成回答

先配置你信任的模型接口。以下地址和模型名仅为占位示例，需要替换成已部署的 OpenAI 兼容接口；本地服务不校验密钥时，也要提供其允许的占位值以满足 SDK 配置。

```bash
export KNOWLEDGE_API_BASE='http://127.0.0.1:8000/v1'
export KNOWLEDGE_MODEL='your-model-name'
export KNOWLEDGE_API_KEY='local-placeholder'
bun run src/scripts/knowledge.ts --root examples/knowledge-vault --ask 'API 不兼容变更发布前需要什么？'
```

这三个环境变量必须显式设置；不会自动使用团队的 AI_API_KEY 等配置。可选 KNOWLEDGE_PROVIDER 默认使用现有 OpenAI 兼容网关配置；其他模型适配沿用宿主 Gateway 的支持范围。API 地址必须是 HTTP(S)，且不在 URL 中包含凭据、query 或 fragment。

`--ask` 与 `--query` 互斥。生成开始前，CLI 向 stderr 显示模型地址和数据发送提示，stdout 保持 JSON。问题与选中的片段 ID、标题、小标题和正文会发送给模型；不发送整份 Vault、未命中文件、同步失败路径或 Obsidian URI。模型服务后端如何处理数据仍需由使用者确认。

回答中 `status=answered` 的每条 claim 都带 citationId 和原文 quote。系统检查 ID 来自本次供给证据，quote 是对应片段的精确子串；**这只验证引用存在和引文吻合，不证明结论语义正确或资料完整**。`verification.semanticSupport=not_verified` 明确保留这个边界。

无关键词命中时直接返回 `insufficient_evidence`，不调用模型；模型判断证据不足时也可返回该状态。非法 JSON、伪造引用、错误引文、无引用结论和模型服务错误会让运行失败，不生成答案 Artifact。部分索引与上下文截断会在 `retrieval` 中保留标记。当前使用关键词检索增强生成，不包括向量检索。

生成阶段没有 Tool 或人工输入函数，也不会进入等待恢复状态。补充笔记后可重新提问。答案保留检索时的内容版本；源文件随后改变时，尚不会自动标记历史答案过期。

## 看懂结果

- `retrieval: keyword`：按中文分词及标题、别名、标签和正文匹配。分数是排序值，不是事实置信度；用词不同的同义表达可能找不到。
- `source.version` 与 `documentVersion`：当前内容哈希。内容更新后版本改变，引用 ID 随对应段落版本改变。
- `added/changed/removed`：相对于当前进程上次成功同步的变化，每类最多列 25 条，同时返回完整数量和截断标记。每次 CLI 启动都会重建索引，首次视为新增。
- `partial/failed/failures`：有文件读取失败时 partial=true；过大、无法读取、非法 UTF-8 或属性格式错误等文件没有进入本轮索引。失败详情最多 25 条。命令执行完成不代表所有文件都已索引。
- `links`：区分已解析、同名歧义、缺失、附件、越界、外部链接和未支持块引用；不会自动读取附件或展开关联笔记正文。检索结果只带部分关系及候选总数。
- 空 hits：当前关键词没有命中；不能据此断言笔记里没有相关知识。

源文件删除或失效后不会继续出现在新查询中。根目录、遍历或整轮预算失败时命令以非零状态退出，不返回旧索引。单个文件失败则在报告中明确列出，其他有效笔记仍可查询。

默认上限为 2000 份 Markdown、单份 1 MiB、整轮 32 MiB；另有遍历、深度、段落与链接数量限制。更大知识库需要后续持久化索引与规模验证，不能直接扩大上限来承诺性能。

## 插件方式

插件模块位于 `backend/src/knowledge/markdown/plugin.ts` 与 `backend/src/knowledge/answer/plugin.ts`，可以通过现有 `FeaturePlugin` 装配。参考 `backend/profiles/agents/knowledge-demo.yaml` 和 `knowledge-answer-demo.yaml`；root 相对于进程启动目录解析，样例假设从 `backend` 启动。SDK/宿主装配回答插件时使用宿主 config.ai 的模型执行器，调用者负责配置与数据授权；CLI 才使用上述专用环境变量。

默认团队配置不安装个人知识插件。当前只允许无群/会话的手动调用及其 Agent 调用；拒绝聊天范围。这个范围检查不构成用户认证。现有 Web 管理端缺少登录/RBAC，真实私人知识优先通过本地 CLI 使用，不能直接作为共享网站开放。

Obsidian 的常用 YAML `title/aliases/tags`、ATX 标题、普通 Wikilink 和简单行内 Markdown 链接已处理。复杂行内链接、引用式链接、Setext 标题、块引用、Canvas、Bases、Dataview 与附件正文不在本次兼容范围。
