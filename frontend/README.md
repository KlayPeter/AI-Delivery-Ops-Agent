# 前端

前端是 AI Delivery Ops Agent 的管理控制台，使用 React、TypeScript、Vite、
Ant Design、React Router、SWR 和 Axios。

## 功能

- 项目看板与人力甘特图
- 审计日志与对话上下文
- 站会和周报历史
- 手动任务与 Agent 触发
- 群组、成员、邮件、运行参数和调度配置

## 本地开发

需要 Node.js 22 与 pnpm 10；运行单元测试还需要 Bun 1.3.x：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`VITE_API_BASE` 指向后端 API。示例配置使用
`http://localhost:8090/api`。不要把任何凭据放入前端环境变量。

## 检查

```bash
pnpm lint
pnpm typecheck
bun test
pnpm build
```

生产构建输出到 `dist/`。公共 Docker 镜像通过 Nginx 提供静态文件，并把
`/api` 转发到 `BACKEND_UPSTREAM`。

## 安全边界

控制台没有内置身份认证。只能在可信网络中使用，或由带身份认证、TLS、限流
和访问审计的反向代理保护。
