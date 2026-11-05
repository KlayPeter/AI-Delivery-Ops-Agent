# 用个人知识准备一次发布

当前是只读 CLI/插件：读取明确仓库的合并 PR、当前开放 Issue 和选定个人发布规则，生成带引用的草稿与待确认事项。不会写入 GitHub 或笔记。功能契约见[发布准备](../backend/src/domains/release/FEATURE.md)和[GitHub 连接器](../backend/src/connectors/github/FEATURE.md)。

## 先检查来源，不调用模型

从 `backend` 目录执行，将 owner/repo 和时间段替换成自己的仓库：

```bash
bun install --frozen-lockfile
bun run src/scripts/release.ts \
  --repository owner/repo \
  --since 2026-10-29T00:00:00Z \
  --until 2026-11-05T00:00:00Z \
  --root examples/knowledge-vault \
  --collect
```

示例 Vault 是虚构资料。默认分支来自仓库元数据，也可传 `--base-branch`。PR 按 `[since, until)` 的 merged_at 筛选；省略 until 时使用本轮开始时间。Issue 清单是当前开放状态，不是 until 当时的状态。

公开仓库可以匿名读取；限流额度较低。需要认证时明确传 `--token-ref env://GITHUB_TOKEN`，并在对应环境变量里提供具有所需读取权限的 token。不会自动读取 Git Credential，也不要把 token 写入 YAML、命令参数或仓库。API 固定 api.github.com，不接受任意服务地址；仓库迁移重定向会要求更新配置。

collect 会请求 GitHub、读取选定笔记，返回 evidence_only 与 Run ID，不调用模型。检查 facts.coverage、warnings、knowledge 和 evidence。空 PR/Issue 是实际读取结果，不能编造演示内容；API 失败会报错。

## 使用自己的知识源

把 root 替换成自己的选定目录，可添加 `--exclude Private`、`--vault-name 'My Vault'`。也可改用最多五个 `--url` 公共链接；目录与网页当前互斥。

```bash
bun run src/scripts/release.ts \
  --repository owner/repo \
  --since 2026-10-29T00:00:00Z \
  --url https://example.com/release-policy \
  --policy-query 'release API migration policy' \
  --collect
```

URL 是占位示例，请换成实际公开规则页面。网页不支持登录、JavaScript 交互、全站爬取或附件。完整来源边界见[个人知识使用指南](PERSONAL_KNOWLEDGE.md)。`--policy-query` 选择检索关键词，不保证查全个人规则。

## 生成草稿

先配置可信的模型接口；下面是占位值，需要换成可用服务：

```bash
export KNOWLEDGE_API_BASE='http://127.0.0.1:8000/v1'
export KNOWLEDGE_MODEL='your-model-name'
export KNOWLEDGE_API_KEY='local-placeholder'
bun run src/scripts/release.ts \
  --repository owner/repo \
  --since 2026-10-29T00:00:00Z \
  --root /path/to/selected-vault \
  --policy-query '发布规则 API 迁移说明'
```

省略 collect 即请求生成。CLI 显示模型目的地；仓库事实和选中个人片段会发送到该模型。不自动使用团队 AI_* 设置。不额外发送知识路径/URL 字段，但正文中原本包含的路径、链接仍可能发送。私有仓库文本同样属于需要信任该服务的数据。

result.markdown 是可复制草稿，result.draft 保存结构化条目和发现。每个供给 PR 恰好出现一次；引用 ID 和精确 quote 必须与供给证据匹配，规则发现必须同时关联真实 PR 和知识。伪造/错配引用、漏 PR、非法 JSON 或模型错误会使 Run 失败，不发布草稿。

状态含义：

- evidence_only：仅收集证据，没有生成。
- insufficient_evidence：没有合并 PR 或没有规则关键词命中，未调用模型。
- needs_review：存在覆盖不足、潜在阻塞/待确认，或资料超出生成预算。超预算时没有生成 draft，可缩小范围重试。
- draft：生成草稿未提出上述事项；仍需人工复核，不等于可发布。

始终 requiresHumanReview=true。semanticSupport=not_verified；引用吻合不证明结论语义或规则适用性。未读取 Diff、代码文件、CI 和审核结果，不能凭 PR 正文没有提到某文档就断定文档不存在。

## 覆盖与留存

GitHub 每类默认读取五页、每页三十项；部署配置可调整，但有最大页数、字节和时限。读取结束不构成原子快照，期间并发变化可能导致遗漏。分页不足、重复和正文/输出截断可见。模型上下文超过预算时返回证据并要求复核，不静默删 PR。

只读来源内容、版本和实际引文保存在本次 Artifact。CLI 的索引和运行记录只在内存，退出后消失；JSON 输出可由使用者自行保存，包含个人片段，应按自己的资料管理。知识更新后尚不会自动标记历史草稿过期，也不会执行外部写入。

插件组合见 `backend/profiles/agents/release-demo.yaml` 与 `release-web-demo.yaml`；其中 example/project 需替换，root 相对于启动目录。一个 Host 选择一个 release.prepare 来源组合。默认团队配置不安装这些插件。当前没有共享 Web 的身份和私人 Artifact 隔离，仅推荐可信本机使用。
