# 文档中心

本文档中心按读者角色组织内容。首次使用请从根
[README](../README.md) 的快速开始开始。

## 使用者

- [本地运行与工作台](LOCAL_DEVELOPMENT.md)：无需部署的启动步骤、连接表单与实际 Agent 运行。
- [MCP 工具](MCP_TOOLS.md)：连接本地 stdio 或公开 HTTPS 服务、明确授权范围并查看运行证据。
- [Context7 与标准 Skill](COMMUNITY_PLUGINS.md)：真实社区工具、SKILL.md 导入和独立配置档。
- [网页与文档收集](DOCUMENT_IMPORT.md)：安装 MarkItDown、导入资料、明确收录及资料库来源切换。
- [本地个人知识库](PERSONAL_KNOWLEDGE.md)：只读连接 Markdown/Obsidian 目录；本地关键词检索或显式配置模型后生成带引用的 RAG 回答。
- [知识变更复核](KNOWLEDGE_IMPACT.md)：检查历史引用，保留原结果和独立评估。
- [发布准备](RELEASE_PREPARATION.md)：仓库事实、个人规则与可核查草稿。
- [结果验收功能卡](../backend/src/quality/FEATURE.md)：插件声明的规则、执行版本和两次运行的结构对比。
- [用户指南](AI-Delivery-Ops-Agent-用户使用指南.md)：在飞书中创建任务、
  更新进度、提交站会和触发报告。
- [第三方平台接入配置指南](第三方平台接入配置指南.md)：配置飞书、TAPD、
  模型和外部 HTTP Agent。

## 部署者

- [部署与开发协作流程](项目部署与开发协作流程.md)：本地验证、分支、CI、
  Docker、SQLite 和发布边界。
- [Kubernetes 模板说明](../deploy/k8s/README.md)：清单、占位符和单写约束。
- [Kubernetes 手动部署](../deploy/k8s/DEPLOY.md)：构建、发布、健康检查和
  回滚步骤。
- [安全策略](../SECURITY.md)：漏洞报告和部署安全边界。

## 维护者

- [项目演示与验证证据](PROJECT_EVIDENCE.md)：实际截图、复现路径、测试边界、简历描述和仍待验证的能力。
- [产品方向与插件化路线](PROJECT_DIRECTION.md)：目标用户、创新取舍、插件规范草案、演示与阶段验收；目标能力与已实现能力分开记录。
- [个人知识库设计](PERSONAL_KNOWLEDGE_DESIGN.md)：链接与 Obsidian 接入、知识驱动任务、来源变更影响和分期验收；设计目标部分实现，以使用指南和功能卡为准。
- [功能插件规范 v1](PLUGIN_AUTHORING.md)：当前可用的插件 SDK、真实模板、依赖与资源清理约定，以及尚未迁移的边界。
- [系统架构与业务逻辑](系统架构与业务逻辑详解.md)：运行链路、领域边界和
  主要数据流。
- [Agent 架构设计记录](Agent架构升级与系统评估-2026-07.md)：Agent Host
  设计背景、成熟度评估和后续约束。
- [后端存储与协作架构](后端存储与协作架构探究.md)：SQLite、Prisma 和
  协作数据模型。
- [功能卡索引](features/README.md)：各功能的事实源、边界、流程图、代码和
  测试地图。

## 文档维护规则

- 用户可见行为变化时，更新用户指南和对应 `FEATURE.md`。
- 配置项、环境变量或权限变化时，更新第三方平台接入指南和 `.env.example`。
- 部署、数据或安全边界变化时，更新根 README、部署文档和 `SECURITY.md`。
- 示例只使用虚构名称、占位 ID 和测试地址。
- 禁止写入真实凭据、人员信息、内部域名、私有项目链接或生产日志。

代码与测试是运行行为的最终事实源。文档与代码冲突时，应先确认实际行为，
再在同一变更中修正文档。
