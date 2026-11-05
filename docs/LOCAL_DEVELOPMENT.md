# 本地运行

安装 Bun、Node.js 22 和 pnpm 10。以下命令在仓库根目录执行；不需要 Docker 或服务器。

首次启动后端：

```sh
cd backend
cp .env.example .env
bun install --frozen-lockfile
bunx prisma generate
bun run db:push
bun run dev
```

示例配置将 HTTP 绑定到 `127.0.0.1:8090`。飞书 App ID 和 Secret 都留空时，不创建默认飞书长连接，仍可使用本地管理页面和 Agent/知识 CLI。只填一项或填写错误 App ID 会明确报错；配置凭据后需要重启后端。TAPD、模型和飞书业务操作需要各自的真实配置。

另开终端，在仓库根目录启动前端：

```sh
cd frontend
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

打开 [本地界面](http://localhost:15173/)。[就绪检查](http://localhost:8090/readyz) 返回 `status: "ready"` 表示数据库、Agent Host 和已配置的入站机器人已就绪；未配置飞书时 `required: 0` 是正常状态。

页面初始没有业务数据。项目看板需要配置群组与 TAPD 后生成；个人知识可先按 [Markdown / Obsidian 与公开链接用法](PERSONAL_KNOWLEDGE.md) 在 CLI 中体验。CLI 的检索不需要模型，生成回答需要显式配置模型；持久化与历史引用复核见 [知识变更复核](KNOWLEDGE_IMPACT.md)。

本地管理 API 目前没有登录认证；使用示例中的回环地址运行。`.env`、个人知识文件与本地数据库不要提交到 Git。
