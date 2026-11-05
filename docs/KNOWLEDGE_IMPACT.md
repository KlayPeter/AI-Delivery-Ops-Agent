# 检查知识更新影响了哪些旧结果

当前可在本机保存回答和发布草稿，之后显式检查它们实际引用的知识版本。只检查指定 Run 的直接引用，原回答、草稿、引文和来源版本保持不变。尚未实现持续监控、全库自动通知或语义影响判断。

## 保存一次回答

从 `backend` 执行，先按[知识使用指南](PERSONAL_KNOWLEDGE.md)配置可信的 KNOWLEDGE_API_BASE/MODEL/API_KEY。复制虚构资料到临时目录，避免修改自己的笔记：

```bash
demo_vault=$(mktemp -d)
cp examples/knowledge-vault/*.md "$demo_vault/"
bun run src/scripts/knowledge.ts \
  --root "$demo_vault" \
  --state ../data/personal-runtime.sqlite \
  --ask 'API 变更发布前需要哪些迁移说明？'
```

记录输出的 runId。state 文件保存原 Run、Tool 结果、问题、选中片段和 Artifact，包含个人资料；它不是加密存储。默认文件权限为 0600，新建父目录为 0700。项目 data 目录被 Git 忽略，仍需自行管理备份与设备权限。不传 state 时保持原内存模式，退出后不能检查那次运行。

## 修改知识后复核

在同一 shell 中修改虚构发布规则：

```bash
printf '\nAPI 变更发布前还需要人工确认。\n' >> "$demo_vault/Release.md"
bun run src/scripts/knowledge.ts \
  --root "$demo_vault" \
  --state ../data/personal-runtime.sqlite \
  --check-run '<上一步的 runId>'
```

check-run 可重复，最多二十个不同 Run。检查不需要模型配置，不调用模型；网页来源仍会请求用户明确配置的网站。它按实际保存的引用读取当前文档版本，不能把更换后的同名 Vault 当成原来源。源文件改名按旧路径缺失处理。

返回 assessments，每项包含原 runId、artifactIds、checkedAt、references 和 state：

| state | 含义 |
| --- | --- |
| current | 实际被引用文档仍是同一来源与同一内容版本；不表示原结论语义正确 |
| needs_review | 至少一个被引用文档变化或在成功扫描范围内缺失，原产物需复核 |
| unverifiable | 来源不可读、选择了其他范围、旧记录缺少来源身份、格式不受支持或检查失败 |
| not_applicable | 该受支持结果没有实际知识引用，例如仅取证的发布运行或未引用规则的草稿 |

文档级版本变化会触发复核；同一文档的其他段落变化也可能触发。未被引用的其他笔记变化不会误报。网页请求失败不证明页面删除，所以标为 unavailable/unverifiable。旧格式没有 sourceKey 时明确标为 legacy_unverifiable，不按当前目录猜测来源。

## 查看上次评估

```bash
bun run src/scripts/knowledge.ts \
  --root "$demo_vault" \
  --state ../data/personal-runtime.sqlite \
  --check-run '<原 runId>' \
  --impact-status
```

这条命令不刷新知识，只返回最近一次评估和时间。没有检查为 not_checked；上次检查中断为 check_incomplete，不能当成 current。需要实时结果时去掉 impact-status。

## 检查发布草稿或网页知识

发布命令也可加 `--state ../data/personal-runtime.sqlite`，见[发布准备指南](RELEASE_PREPARATION.md)。之后用相同状态文件和知识目录执行 check-run。规则同时被供给模型但没有被实际引用时，不会当作已记录依赖。

网页模式使用与生成时对应的公开 URL：

```bash
bun run src/scripts/knowledge.ts \
  --url https://example.com/policy \
  --state ../data/personal-runtime.sqlite \
  --check-run '<网页回答或发布草稿的 runId>'
```

URL 是占位示例。当前每个组合仍只选择 Markdown 或网页一类来源，检查来源不同则标记范围不匹配。不能拿普通 query/sync 的 Run 当成生成答案；检查当前支持 knowledge.answer 和 release.prepare 的成功记录。

## 本地状态的边界

同一文件只允许一个活跃 CLI 会话，避免第二个 Host 把第一个仍运行的任务误认为进程重启遗留。锁由单独 .lock SQLite 事务持有；进程退出后自动释放，不要手工删除正在使用的锁文件。强制退出后的已提交记录可恢复，未完成运行与检查明确保留失败/未知状态。

备份时先结束使用该文件的 CLI，完整关闭后再复制状态文件。运行时 WAL/SHM 文件可能包含已提交数据，不能只复制主文件冒充一致备份。不要指向已有业务数据库：带其他应用数据或不支持版本的文件会拒绝，不覆盖它们。

当前面向 macOS/Linux 等具有 POSIX 文件权限的可信本地文件系统，不用于网络共享、多主机协作或公共网站认证。来源索引仍是可重建内存数据，state 并不把整座 Vault 复制成永久知识库。

实现与验证见[功能卡](../backend/src/knowledge/impact/FEATURE.md)。验证使用本地模拟模型及真实 CLI 子进程，包含只改未引用笔记、改名、失效、同名不同 Vault、旧格式、作用域、并发评估和进程强制退出恢复。
