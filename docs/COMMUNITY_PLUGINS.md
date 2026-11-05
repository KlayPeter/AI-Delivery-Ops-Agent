# 接入 GitHub 社区插件与 Skill

GitHub 仓库可以通过已有扩展协议接入。仓库本身不必改写成我们的框架；选择它实际提供的入口，再写薄适配器。当前已经用真实 Context7 MCP 服务和其官方 Skill 验证这一点。

| 上游提供什么 | 本项目接入方式 | 当前范围 |
| --- | --- | --- |
| 标准 `SKILL.md` | `readAgentSkill` 读取 name/description/正文，再交给现有 Prompt Skill Runtime | 显式本地导入，宿主决定工具、预算、模型 Agent 兼容性；不自动运行脚本或展开引用资源 |
| MCP 服务 | `connector.mcp` 连接 stdio 或公开 HTTPS Streamable HTTP 并选择工具 | 已审查的读取工具、真实 Schema、取消/超时、Run/Step 与连接清理 |
| 独立 HTTP Agent | 现有 HTTP Agent Manifest/Adapter | 显式 endpoint、请求与响应协议、主机范围和凭据引用 |
| TypeScript 功能模块 | `FeaturePlugin` 包装上游函数或 SDK | 注册 Agent/Tool/Skill、消息、计划、Web 等贡献，Cordis 管理生命周期 |

本规范与 [Agent Skills 格式](https://agentskills.io/specification) 对接；原生插件与页面/API 规范见 [插件作者说明](PLUGIN_AUTHORING.md)。没有提供这些协议的小项目需要适配入口，不能把任意仓库下载后直接当作原生插件启动。

## Context7 实际样例

上游：[upstash/context7](https://github.com/upstash/context7)，MIT 许可。它提供开发库文档检索，我们复用上游服务，不复制搜索实现。固定来源、提交和校验值见 [上游说明](../backend/src/connectors/context7/upstream/NOTICE.md)。

插件提供两种能力：

- **Context7 文档查询**：无需宿主模型，查询选定开发库，返回当次检索正文、来源链接和 Tool Step。默认 React。
- **Context7 文档研究**：需要宿主模型，使用官方 `context7-mcp/SKILL.md` 搜索文档库、查询并组织回答。Skill 工具权限由宿主单独授予。

本地验收使用 Node 22.23.0、Bun 1.3.13、`@upstash/context7-mcp@4.5.0`。匿名连接实际完成了 React 库搜索、`useEffect` 文档查询和工作台 Run；这不是模型生成的模拟文档。真实模型研究尚未调用付费模型，Skill 执行链以受控替身模型验证。匿名可用性和限额由 Context7 决定，可能变化。

## 本地运行

按[本地说明](LOCAL_DEVELOPMENT.md)初始化数据库后，从 backend 可直接连接官方在线 MCP，不安装额外进程：

```bash
AGENT_PLUGINS_FILE=examples/plugins.context7-http.yaml bun run dev
```

该配置使用官方 https://mcp.context7.com/mcp，已实际验证 React 查询、真实 Tool/Agent Step 和零模型调用。可在自己的配置副本中取消 tokenRef: env://CONTEXT7_API_KEY 的注释，通过环境注入 API key，SDK 以 Bearer 发送。远端服务版本及匿名限额由上游维护，本地 Skill 仍固定到已审查来源；不把远端后端当作固定版本本地包。

也可继续安装固定版本本地 stdio 包。它放在本地数据目录，不修改项目依赖或编辑器全局配置：

```bash
cd backend
npm install --prefix .data/context7 --ignore-scripts --no-audit --no-fund --save-exact @upstash/context7-mcp@4.5.0
OTEL_SDK_DISABLED=true AGENT_PLUGINS_FILE=examples/plugins.context7.yaml bun run src/index.ts
```

另开终端按 [本地开发说明](LOCAL_DEVELOPMENT.md) 启动前端，打开「开发文档」。显式插件配置完全管理组合；此示例只选择 MCP 与 Context7，不自动叠加团队或个人知识插件。`.data` 与本地配置不要提交。

普通输入直接查询默认 React 文档库，例如：

```text
React useEffect cleanup function for a window event listener
```

高级参数支持先搜索文档库：

```json
{ "prompt": "How to configure Prisma relations", "operation": "search", "libraryName": "Prisma" }
```

再使用上一步返回的完整 `libraryId` 查询：

```json
{ "prompt": "How to configure Prisma relations", "libraryId": "/实际搜索返回的文档库ID" }
```

查询问题会发往 Context7，请使用适合交给该服务处理的内容。本地 stdio 方式需要 API key 时，在自己的配置副本中添加 `envRefs.CONTEXT7_API_KEY: env://CONTEXT7_API_KEY`；HTTP 使用上面的 tokenRef。不要把 key 写入命令参数或公开 YAML。上游限流/认证失败会显示失败，不自动重发工具调用或启动 OAuth/编辑器安装流程；连接安全与范围见[MCP 说明](MCP_TOOLS.md)。

## 导入其他 Skill

将审查过的仓库固定到明确版本，保留其许可。Skill 目录名需与 frontmatter.name 一致，文件必须是包含有效 YAML frontmatter 和非空正文的普通 `SKILL.md`，至多 128 KiB。

在自己的插件 apply 中读取并注册：

```ts
const imported = await readAgentSkill('/absolute/path/to/repository/skills/example-skill', {
  id: 'community.example-skill', version: '1.0.0',
  inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
  allowedTools: ['a.reviewed.read.tool'], compatibleAgents: ['my.model-agent'],
  riskLevel: 'medium', maxToolCalls: 3, timeoutSeconds: 30,
});
ctx.delivery.skills.register(imported.manifest, imported.instructions);
```

`readAgentSkill` 从 `backend/src/platform/skills/packageLoader.ts` 导出。原 `manifest.yaml + SKILL.md` 包保持兼容，不会自动把技能目录中的其他 Markdown 当成可执行 Skill。上游 `allowed-tools`、execution 或 compatibleAgents 元数据不会扩大宿主权限；目录中的 scripts、references 和 assets 也不会自动执行或加载。需要它们时应明确适配为受治理 Tool，补齐输入范围与结果核验。

Context7 插件的页面由元数据贡献，Agent、Skill、Tool 和本地进程均随插件清理；历史运行产物保留。它证明了可用的接入链路，仍不等于支持所有上游客户端、资源或脚本执行环境。
