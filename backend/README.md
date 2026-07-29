# 后端

后端负责飞书长连接、TAPD 集成、领域规则、定时任务、Agent Runtime、可靠
投递和管理 API。

## 技术栈

- Bun 与 TypeScript
- Elysia
- Prisma 与 SQLite
- 飞书 Node SDK
- AI SDK 与 OpenAI 兼容模型接口

## 本地启动

需要 Bun 1.3.x。先复制示例配置，并使用测试环境凭据：

```bash
bun install --frozen-lockfile
cp .env.example .env
bunx prisma generate
bun run setup
```

`bun run setup` 会同步 SQLite schema，然后以 watch 模式启动服务。后端默认
监听 `http://localhost:8090`。

公开版不会提供可直接使用的集成凭据。至少需要配置有效的飞书 App ID、
App Secret 和 Bot Open ID；TAPD 与模型参数只在启用相应能力时需要。

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
连接。

## 测试

测试必须使用独立数据库：

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
- `src/adapters/`：飞书、TAPD、模型和邮件适配器。
- `src/core/`：配置、调度、健康检查、存储与数据保留。

领域状态只能通过领域服务写入。Agent、模型、Handler 和外部 Adapter 不应
绕过该边界。

部署入口统一放在仓库根目录的 `docker/` 和 `deploy/`。详细步骤见
[根 README](../README.md)。
