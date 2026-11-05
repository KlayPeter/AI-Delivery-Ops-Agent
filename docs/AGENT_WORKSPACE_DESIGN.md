# Agent 工作台：前端方向与首版边界

把“配置业务机器人”的旧后台推进为个人 Agent 工作空间。用户进入后首先能选择能力和发起任务，随后看到执行步骤与结果；团队交付是其中一组可用能力。

## 参考与取舍

- [LangSmith Studio](https://docs.langchain.com/oss/python/langgraph/studio) 提供本地 Agent 的步骤、工具调用和中间状态检查；这里把相应交互收敛为运行记录与详情面板。
- [Dify Run History](https://docs.dify.ai/en/cloud/use-dify/debug/history-and-logs) 将结果、详情与执行追踪分开。本项目采用相近的信息分层，数据全部来自真实 Run/Step/Artifact。
- [Dify 知识管线](https://docs.dify.ai/en/cloud/use-dify/knowledge/knowledge-pipeline/knowledge-pipeline-orchestration) 独立管理来源处理和检索。当前先提供选定来源和检索体验，复用已有来源插件。
- [n8n 凭据管理](https://docs.n8n.io/build/understand-workflows/create-and-edit-credentials) 集中配置外部服务。当前提供飞书、模型与 TAPD 表单，密钥脱敏，配置保存在本机。
- 按 UI/UX Pro Max 的 Minimalism & Swiss Style 方向，采用浅色背景、白色表面、细边框、系统字体与少量蓝色强调。使用现有 React/Ant Design，导航在窄屏收起，保留键盘焦点和减少动画设置。

## 页面结构

| 页面 | 核心动作 |
| --- | --- |
| 工作台 | 描述任务、选择 Agent 能力、发起运行 |
| 运行记录 | 查看最近运行、结果、步骤、错误，补充信息继续 |
| Agent | 发现当前实际装配的能力 |
| 知识库 | 连接笔记/公开链接、检索原文、生成引用回答 |
| 插件 | 查看已装配模块、版本和依赖，进入作者规范 |
| 连接与模型 | 填写自己的飞书、模型和 TAPD |
| 团队交付 | 项目看板、站会、周报和业务任务 |

## 产品亮点如何落在界面

第一，个人知识进入真实任务流程：能够先检索原文，再按需生成回答，保留来源行号和版本。第二，能力通过统一插件装配，用户能看见当前加载了什么。第三，运行产物与后续知识变更评估各自保留证据；历史引用复核现在通过插件贡献的「检查引用变化」进入结果详情，显示上次检查时间并可查看独立报告；自动复核队列仍未实现。

页面贡献开始由插件拥有：站会、看板、甘特、周报和隐藏纪要的页面与 API 可随插件移除，旧看板根查询和 HTML 链接同样核对所有者；原有手动业务任务按所属插件授权；MCP 读取示例能只声明元数据就增加导航。前端使用已有视图和通用任务入口，不加载任意第三方 UI 包。隐藏纪要入口不出现在菜单，直达路由仍检查安装；会议生成不重新开启。知识工作台的导航、页面与来源描述 API 已迁入 knowledge.workspace；来源选择显式，卸载 UI 保留底层能力。核心通用输入/结果中的部分知识适配及基础服务生命周期继续解耦。

首版采用可运行的本地纵向链路。插件安装组合仍由可信配置管理，连接保存后重启生效；没有工作流画布、公开插件市场、多人权限、向量联合检索或自动知识监控。详细实现与验证见 [工作台功能卡](../backend/src/platform/workspace/FEATURE.md)，运行步骤见 [本地运行](LOCAL_DEVELOPMENT.md)。
