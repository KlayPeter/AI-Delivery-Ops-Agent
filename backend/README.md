# 后端

后端提供 Agent 插件宿主、个人知识与资料收集、运行记录、结果验收和本地工作台
API。飞书长连接、TAPD、团队领域规则与可靠投递按需配置。

## 技术栈

- Bun 与 TypeScript
- Elysia
- Prisma 与 SQLite
- 飞书 Node SDK
- AI SDK 与 OpenAI 兼容模型接口

## 本地启动

需要 Bun 1.3.x，在 backend 目录执行。仅首次复制 .env，保留已有配置：

```bash
bun install --frozen-lockfile
cp .env.example .env
bunx prisma generate
bun run setup
```

`bun run setup` 会同步 SQLite schema，然后以 watch 模式启动服务。后端默认
监听 `http://127.0.0.1:8090`。

无需凭据即可启动、检索虚构示例知识和收集公开网页。飞书 App ID 和 Secret
均留空时不连接，只填一项会拒绝启动；TAPD 与模型参数仅在调用相应能力时需要。
前端与自己的资料接入见[本地运行](../docs/LOCAL_DEVELOPMENT.md)。文档导入需另外
安装[固定版本 MarkItDown 环境](../docs/DOCUMENT_IMPORT.md)。

常用命令：

```bash
bun run dev           # 开发模式
bun run start         # 非 watch 模式
bun run db:push       # 安全同步 Prisma schema
bun run db:studio     # 打开 Prisma Studio
bun run get-bot-info  # 查询当前飞书应用的 Bot Open ID
```

## 健康检查

```bash
curl http://localhost:8090/healthz
curl http://localhost:8090/readyz
```

`/healthz` 只检查进程存活；`/readyz` 还检查数据库、Agent Host 和所需机器人
连接；没有配置飞书时 required: 0 是正常状态。

## 测试

全量测试包含实际文档转换，先按[转换环境说明](../docs/DOCUMENT_IMPORT.md)安装
Python 与 MarkItDown。测试必须使用独立数据库：

```bash
bunx prisma generate
bunx prisma validate
bun run typecheck
TEST_DATABASE_PATH="$(mktemp)"
DATABASE_URL="file:${TEST_DATABASE_PATH}" bunx prisma db push --skip-generate
DATABASE_URL="file:${TEST_DATABASE_PATH}" bun test
```

## 代码边界

- `src/domains/`：任务、站会和周报等业务规则。
- `src/services/`：应用服务、消息路由和报告生成。
- `src/platform/`：Agent、Tool、Skill、Session、Trigger、Bot 与 Outbox。
- `src/knowledge/`：Markdown/Obsidian、网页、回答、引用复核、资料收集和资料库插件。
- `src/connectors/`：GitHub、Context7 与 MarkItDown 等明确适配的开源能力。
- `src/quality/`：插件声明规则的结果验收与执行凭证对比。
- `src/adapters/`：飞书、TAPD、模型和邮件适配器。
- `src/core/`：配置、调度、健康检查、存储与数据保留。

领域状态只能通过领域服务写入。Agent、模型、Handler 和外部 Adapter 不应
绕过该边界。

插件契约、组合与清理约定见[插件作者指南](../docs/PLUGIN_AUTHORING.md)。
