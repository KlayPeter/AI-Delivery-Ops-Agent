# 功能插件规范 v1

当前 SDK 面向本仓库内或由部署者审查的 TypeScript 原生插件。使用 Cordis 4.1.0，协议版本为 `1.0`。现阶段提供 Agent、Tool、Skill 的独立装配、依赖校验和资源清理；页面、确定性消息 Handler、Scheduler 与基础服务的完整插件化继续按路线图迁移。

## 包结构

```text
my-feature/
  index.ts       # 导出 FeaturePlugin
  README.md      # 安装、配置、能力与已知限制
  FEATURE.md     # 功能边界、流程、数据和验证
  test/          # 合法输入、非法输入、失败与清理场景
```

对外分发时还应提供许可证、源码地址、固定版本和权限说明。插件描述与测试结果不能替代部署者对原生代码的审查。

## 最小插件

可运行模板见 [echo.ts](../backend/examples/plugins/echo.ts)，其测试通过真实 Host、Trigger、Run 与 Artifact 链路执行，无需模型或飞书凭据。复制模板后替换插件身份、Agent 契约和 handler，不需要修改 Host。

```ts
import { AgentHost } from './src/platform/bootstrap/agentHost';
import { echoPlugin } from './examples/plugins/echo';

const host = new AgentHost(getContext, 1000, undefined, [], {
  plugins: [echoPlugin],
  pluginConfig: {},
});
await host.initialize();
// 使用 host.dispatch 创建受持久化和作用域约束的执行。
await host.stop();
```

`getContext` 提供当前应用的 `HandlerContext`。现阶段插件 SDK 仍依赖已有应用服务，不是已发布的通用 npm SDK。应用默认组合使用 `createDeliveryOpsHost`，保留七个业务 Agent；直接构造 `AgentHost` 默认不装配业务功能。

## 用配置文件选择 Agent 插件

从 `backend` 目录启动时，可设置：

```bash
AGENT_PLUGINS_FILE=profiles/agents/team.yaml bun run dev
```

未设置变量时保留原七个 Agent。示例还包括 `profiles/agents/native-demo.yaml` 和 `profiles/agents/empty.yaml`，分别选择 Echo 模板和零业务 Agent。这些是 Agent 层配置，尚不关闭原 Web、飞书连接、确定性 Handler 或业务定时任务，也不等同完整的最小产品部署配置档。

```yaml
apiVersion: '1.0'
plugins:
  - module: builtin.task
  - module: ./plugins/my-feature/index.ts
    config:
      environment: test
  - module: ./plugins/temporarily-disabled/index.ts
    enabled: false
```

`module` 可以是内置插件 ID、本地文件路径或已安装的 npm 包。相对文件路径以 YAML 文件所在目录解析；外部模块导出 `default FeaturePlugin`，或具名导出 `manifest` 与 `apply`。配置按声明的依赖排序，YAML 行顺序不决定初始化顺序。未启用的模块不导入；依赖仍然要求显式选择，缺失时拒绝启动。

配置文件属于部署者的受信任代码装配入口，修改后重启生效。模块导入会执行其顶层代码，因此只选择已审查的本地文件或依赖；HTTP、Git 和其他 URL 不直接执行，也不会自动安装包。新插件的 Secret 仍应使用引用。

## 声明字段

| 字段 | 规则 |
| --- | --- |
| `manifest.apiVersion` | 固定为 `1.0`，不兼容版本拒绝启动 |
| `manifest.id` | 小写字母开头，仅小写字母、数字、点和连字符；同一 Host 中唯一 |
| `manifest.name`、`description` | 非空显示名称和能力说明 |
| `manifest.version` | `major.minor.patch`，可带预发布后缀 |
| `manifest.requires` | 插件 ID 列表；缺失、重复 ID 和循环依赖在执行插件代码前拒绝 |
| `agents` | Agent Manifest 与安装 ID；Capability、输入输出、资源预算和可使用 Tool 继续由 Agent Manifest 声明 |
| `skillPackages` | Skill 根目录下的直接子包名；声明但缺失时拒绝启动 |
| `Config` | 可选 Standard Schema 校验器，例如 `z.object(...)`；配置从 `pluginConfig[manifest.id]` 传入 |
| `apply(ctx, config)` | 声明能力，配置已经过 `Config` 校验 |

## 注册与清理

通过 `ctx.delivery.nativeAgents.register`、`modelAgents.register`、`tools.register`、`skills.register` 注册。它们自动将 disposer 加入当前 Cordis 插件作用域；启动失败或 Host 停止时释放。

连接、监听器和计时器使用 `ctx.effect` / `ctx.on`。插件需要在持久化控制面恢复后协调配置时，监听 `delivery/restored`；该回调失败同样使 Host 启动失败并释放插件。

业务数据不随卸载删除。Host 停止前等待在途 Run 和投递结束；停止后的 Host 对象不能重新启动，应创建新实例。尚未提供运行中单插件热卸载。

## 权限与数据边界

原生插件运行在宿主进程，属于受信任代码。`ctx.delivery.getContext` 仍可访问现有应用服务，插件声明不是原生 JavaScript 的沙箱。没有审查的远程仓库不能直接变成原生插件执行。

模型可调用的动作必须通过受治理 Tool。写操作调用领域服务，不能让模型直接拼接数据库写入或扩大权限。Secret 使用引用，不放入 Prompt、产物或插件源码。

已有外部服务可继续通过 HTTP Agent Manifest、网络 allowlist、Secret 引用和超时契约接入。MCP 接入助手与隔离的 CLI 适配属于后续节点。采用 Cordis 不代表现有 DeepSeek Harness 插件可以直接使用；必须适配它所依赖的服务。

## 插件提交验收

1. 在真实 Host 中执行至少一个合法输入，检查结果和 Artifact。
2. 非法配置和不兼容契约必须明确失败。
3. 模拟初始化或配置恢复失败，确认没有残留 Tool、Agent Handler、安装或绑定。
4. 停止时释放自己的资源；已完成运行和用户配置仍可从持久化存储读取。
5. 有外部写入时验证幂等、重试与结果不确定的处理，不把网络成功等同于业务成功。
6. 同步功能卡、代码与测试地图，运行受影响回归和 `git diff --check`。

当前规范的运行证据见 `backend/test/pluginRuntime.test.ts` 和 `backend/test/agentHost.test.ts`。面向业务结果的插件验收契约与版本回放实验室仍在产品路线图中。
