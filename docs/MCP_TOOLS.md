# 接入 MCP 工具

已有 MCP 接口的开源项目可以通过独立 connector.mcp 插件接入，不需要把其业务代码复制到 Host。支持已审查的本地 stdio 和公开 HTTPS Streamable HTTP 读取工具，统一通过 Tool Gateway、预算和 Run/Step/Artifact 执行。

MCP 插件不在默认组合中。它不提供在线安装、任意仓库分析、OAuth、写工具或 OS 沙箱。工具的 readOnlyHint 仅是上游提示，不能作为授权证明；配置者需要审查所选工具与服务权限。

## 在工作台发现并接入

默认工作台的「接入工具」输入匿名公开 HTTPS 地址和本地服务标识；预填 Context7 官方地址。点击「发现工具」只执行握手和目录发现，不运行目录内工具或读取宿主凭据。展开参数契约，审查并勾选最多 50 个读取工具，明确确认后生成配置。上游 readOnlyHint 只是未受信提示，不能代替审查；这与 [MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)的信任边界一致。

页面默认勾选“保留本机个人工作台”。下载 `mcp-<服务标识>.personal.local.yaml`，保存到项目 **backend/examples/**；停止原服务后，在仓库根目录按页面命令重启，例如：

```sh
AGENT_PLUGINS_FILE=examples/mcp-context7.personal.local.yaml bun run local
```

个人模式的配置声明 base: personal，按本机来源/仓库设置重新装配个人工作台，再追加连接器和运行器；接入助手已在基底中。标准基底下共十六插件十 Agent，知识、研究、资料库、配方和模型设置保留。

取消保留时，仍导出原 mcp-<服务标识>.local.yaml，选择连接器、运行器、接入助手三个插件及两位 Native Agent；使用下载的实际文件名启动。API 缺省/false 保持此旧行为，true 采用个人基底。两种模式都不合并其他自定义附加插件或团队组合；重复 ID 拒绝覆盖。重启后在「运行工具」选择已授权工具，按当前 Schema 填写 JSON 对象参数并执行。结果保留 Agent、授权路由 Tool 和上游 Tool 三个步骤，共享两次工具预算，零模型调用；协议资源链接仅保存在结果中，不自动下载。

生成配置尚未修改当前 Host 或安装工具。相对模块路径要求文件放在 examples；其他能力需要在可信 YAML 中明确组合。目录限制八页/200 项/512 KiB，不兼容或超过 16 KiB 的 Schema 项不能在页面勾选；运行参数最多 32 KiB。服务名称和版本是自报信息，不能作为锁定版本。生成配置启动时会重新校验工具是否存在及其当前 Schema。

发现助手只支持匿名公开 HTTPS；认证服务的 Bearer 引用仍须在可信本地 YAML 中手动配置，不通过运行输入选取 Secret。stdio、OAuth、私网服务与在线热安装不在助手范围内。完整边界与可复现测试见 [接入与运行功能卡](../backend/src/connectors/mcp-workbench/FEATURE.md)。

## 直接连接在线 MCP

从已初始化的 backend 目录运行以下配置，即可在「开发文档」查询 Context7，无需安装上游进程或配置模型：

```sh
AGENT_PLUGINS_FILE=examples/plugins.context7-http.yaml bun run dev
```

Context7 的[官方地址](https://github.com/upstash/context7#installation)为 https://mcp.context7.com/mcp。匿名访问和限额由上游决定；实际验收已取得 React 文档，记录一个工具步骤、一个 Agent 步骤和零模型调用。固定本地 Skill 与在线服务版本分开，远端后端版本不能由本配置锁定。

其他服务按同一协议填写配置，只选择审查过的读取工具：

```yaml
servers:
  - id: documents
    transport: http
    url: https://mcp.example.com/mcp
    tokenRef: env://MY_MCP_API_KEY # 可选，作为 Authorization: Bearer 发送
    tools:
      - alias: search
        name: search_docs
        description: Search the explicitly selected documentation service.
        readOnly: true
```

这里只是配置形状，example.com 不提供该服务。地址必须使用公开 HTTPS 标准端口，不带用户名、密码、查询参数或片段；令牌只用环境变量引用。不支持任意自定义请求头、OAuth、旧 HTTP+SSE 地址或私网服务。配置属于可信装配入口，运行任务不能更改地址或扩大工具白名单。

每次请求重新检查所有 DNS 结果并固定实际连接 IP，保留原域名的 Host 和 TLS 证书验证；拒绝重定向。SDK 处理 JSON/SSE 协议、会话和取消。请求正文最多 64 KiB，每个 HTTP 响应含 SSE 累计最多 2 MiB，头部最多 16 KiB；响应全程使用同一配置超时。工具自身仍受原 32 KiB 输入和输出预算限制。

停止时等待在途运行，尝试 DELETE 终止本客户端会话并关闭本地流；远端终止失败不阻止本地资源释放，也不证明服务内部操作已停止。不会自动重发 tools/call，SDK 可以建立或恢复接收流。完整使用见[社区插件](COMMUNITY_PLUGINS.md)。

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

本地 *.local.yaml 配置被 Git 忽略。浏览器助手导出配置后保存并重启生效；当前没有运行中启停。

## 失败与验证范围

初始化失败会回滚工具注册并等待进程关闭。正常停止先等待在途 Run；取消会发送协议通知，但不能证明服务内部已经停止。超时和连接断开不自动重试或重新启动服务，需检查配置后重启 Host。

自动测试使用真实 stdio 子进程，覆盖分页发现、未授权工具、Schema、预算、Scope、输出错误/超限、取消、初始化失败、停止与环境隔离。另已使用官方文件服务 2.2.0 实际验证目录内读取与目录外拒绝，无模型调用或外部写入。其他 MCP 仓库需要逐项验收，不能凭协议握手成功就宣称业务正确。

HTTP 自动测试使用真实 TCP 服务及 SDK，覆盖 JSON/SSE、会话和 Bearer 引用、固定 IP/Host/TLS 参数、DNS/URL 拒绝、流取消、超时、字节超限、重定向与错误失败；测试传输映射至回环服务，真实 TLS 另由官方 Context7 在线验收覆盖，不声称测试了所有第三方服务。

协议与 SDK 依据：[Client 连接](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)、[工具调用](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 在研究助手中使用

启用对应读取运行器并保留个人工作台后，可在研究页选择当前授权工具、核对实际服务和固定参数，再明确允许本次研究调用。最多三份固定请求，不允许模型改写参数；暂停后继续保持原确认，服务/授权/契约变化须新建任务。实际读取保留独立子任务及原共享预算，确认记录不算资料。详见[研究流程](PERSONAL_RESEARCH.md#让已接入工具参与研究)。
