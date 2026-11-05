# 前端

前端是 AI Delivery Ops Agent 的本地工作台，使用 React、TypeScript、Vite、
Ant Design、React Router、SWR 和 Axios。

## 功能

- Agent 任务发起、真实运行历史、步骤、产物与人工继续
- 插件目录和随装配变化的导航、页面与运行后续动作
- 个人知识、网页收集、文档导入、资料库与结果验收
- 可填写的模型、知识来源、GitHub、飞书和 TAPD 连接
- 可选团队看板、站会、周报、审计与调度配置

## 本地开发

需要 Node.js 22 与 pnpm 10；运行单元测试还需要 Bun 1.3.x：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev --host 127.0.0.1
```

`VITE_API_BASE` 指向后端 API。示例配置使用
`http://localhost:8090/api`，前端默认端口 15173。复制 .env 仅用于首次初始化，
保留已有配置。不要把任何凭据放入前端环境变量。
完整启动与无密钥体验见[本地运行](../docs/LOCAL_DEVELOPMENT.md)。

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
