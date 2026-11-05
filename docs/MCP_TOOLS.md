# 接入本地 MCP 工具

已有 MCP 接口的开源项目可以通过独立 connector.mcp 插件接入，不需要把其业务代码复制到 Host。当前支持已安装、经审查的本地 stdio 读取工具，仍通过原 Tool Gateway、预算和 Run/Step/Artifact 执行。

MCP 插件不在默认组合中。它不提供在线安装、任意仓库分析、远程 HTTP/OAuth、写工具或 OS 沙箱。工具的 readOnlyHint 仅是上游提示，不能作为授权证明；配置者需要审查所选工具与进程权限。

## 一个可运行的开源例子

下面使用[官方文件服务](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)，不需要模型、飞书、Docker 或服务器。固定 npm 包 @modelcontextprotocol/server-filesystem 2.2.0，单独安装到临时目录；它不成为本项目的默认运行依赖。

在 backend 目录执行：

```sh
mcp_server_dir=$(mktemp -d)
bun add --cwd "$mcp_server_dir" --exact @modelcontextprotocol/server-filesystem@2.2.0
demo_vault=$(mktemp -d)
cp examples/knowledge-vault/*.md "$demo_vault/"
cp profiles/agents/mcp-filesystem.example.yaml profiles/agents/mcp-filesystem.local.yaml
```

编辑复制的 YAML，保持两个 module 路径不变，将 command 改成 bun，将两个占位参数替换成上面目录的实际绝对路径：

```yaml
command: bun
args:
  - /actual/server-folder/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
  - /actual/selected-vault
```

该包声明 Node.js >=24；也可使用符合版本要求的 node。此次真实接入验收使用 Bun 1.3.13；CI 配置使用 Bun 1.3.14，不代表已覆盖所有平台与 Node 版本。上游[许可证](https://github.com/modelcontextprotocol/servers/blob/main/LICENSE)处于 MIT/Apache-2.0 迁移阶段，分发时按所选版本核对；本项目仅提供连接配置与自己的示例，不复制上游服务源码。

按[本地运行说明](LOCAL_DEVELOPMENT.md)初始化数据库，在 backend 目录使用此配置启动：

```sh
AGENT_PLUGINS_FILE=profiles/agents/mcp-filesystem.local.yaml bun run dev
```

前端仍按本地说明启动。前端会出现插件贡献的「MCP 文件读取」导航；点击后打开指定能力的工作台。也可以手动选择 example.mcp.read，任务内容填写演示 Vault 内一份文件的绝对路径，例如 /actual/selected-vault/Release.md，开始执行。结果保存为纯文本，并有 Agent 与 Tool 两个步骤，模型调用次数为零。目录外路径由官方文件服务拒绝，不能返回成功产物。

所选配置仅包含 MCP 连接与读取示例，不额外装配团队或知识问答插件。移除这两项并重启后不再显示该能力与导航入口；既有运行记录保留。

## 工具规范

servers 中每个服务有唯一 id；每个 tools 项声明 alias、上游 name、由安装者编写的 description 与显式 readOnly: true。导入后的 Tool ID 为 mcp.<server>.<alias>。示例只导入 read_text_file 为 mcp.files.read，不自动授权上游其余写文件等工具。

任务 Agent 在 Manifest 的 requirements.tools 中列出 Tool ID，再通过 ctx.delivery.toolGateway.execute 调用，传同一 Run 的 Scope、预算和取消信号。读取示例见 [mcp-reader.ts](../backend/examples/plugins/mcp-reader.ts)，完整功能边界见[功能卡](../backend/src/connectors/mcp/FEATURE.md)。

上游 inputSchema 完整保留，统一校验 additionalProperties、联合类型、引用和长度/数值约束；不自动获取远端 Schema。SDK 按固定工具定义核验 structuredContent 与 outputSchema。isError=true、Schema 不匹配或超出字节限制均为失败，不静默截成成功结果。

## 凭据与进程范围

可选 envRefs 只引用显式环境变量，不把整个宿主环境传给服务：

```yaml
envRefs:
  SERVICE_TOKEN: env://MY_MCP_SERVICE_TOKEN
```

Secret 不写入 YAML 或命令参数。缺少引用时在启动进程前失败。子进程仍继承 SDK 的基础环境（如 PATH/HOME），并具备本机账户权限；这不是阻止恶意进程读取磁盘或联网的沙箱。只连接已审查的服务，并在服务自身配置中限制允许的文件/数据范围。

本地 *.local.yaml 配置被 Git 忽略。保存后重启生效；本阶段没有 MCP 浏览器配置表单或运行中启停。

## 失败与验证范围

初始化失败会回滚工具注册并等待进程关闭。正常停止先等待在途 Run；取消会发送协议通知，但不能证明服务内部已经停止。超时和连接断开不自动重试或重新启动服务，需检查配置后重启 Host。

自动测试使用真实 stdio 子进程，覆盖分页发现、未授权工具、Schema、预算、Scope、输出错误/超限、取消、初始化失败、停止与环境隔离。另已使用官方文件服务 2.2.0 实际验证目录内读取与目录外拒绝，无模型调用或外部写入。其他 MCP 仓库需要逐项验收，不能凭协议握手成功就宣称业务正确。

协议与 SDK 依据：[Client 连接](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)、[工具调用](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)、[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。
