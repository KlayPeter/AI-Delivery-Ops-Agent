# 从 GitHub 接入一份文本 Skill

用公开 GitHub 的 SKILL.md 文件链接，查看完整内容、固定版本和可用许可；审查后导出本地配置，再通过已有 Prompt Skill Runtime 运行。适合可用文字完成的写作、规划、设计建议和代码文本任务。

这里只导入指令文本，外部工具权限为 0。不会克隆或安装仓库、执行脚本、读取工作区文件、浏览网页或加载 references/assets。需要这些资源的 Skill 不能完整运行，可继续用[原生插件规范](PLUGIN_AUTHORING.md)或[MCP 工具](MCP_TOOLS.md)适配。

## 本地使用

在仓库根目录启动独立的发现组合：

```bash
AGENT_PLUGINS_FILE=examples/plugins.skills.yaml bun run local
```

该组合包含三个模型提供者和 skills.setup，共四插件、一个 Agent；读取来源无需模型。它完整替换本次默认组合，不叠加团队或个人知识插件。数据库和原历史保留；切回原配置即可恢复原组合。

1. 打开「接入 Skill」，填写 GitHub 文件链接。可以点击填入 Anthropic 前端设计示例，再明确读取。
2. 查看完整 SKILL.md、固定提交、SHA-256、上游环境/工具声明与许可。声明的工具不会被自动授予；许可文件未取得时请自行核对。
3. 核对文本范围与使用权限后，下载审查配置。该操作绑定原成功发现记录和内容指纹，不接受客户端传来的指令正文，也不会启用插件。
4. 把下载的 `plugins.skill-reviewed.local.yaml` 保存到 `backend` 目录，停止当前本地进程，再从根目录启动：

```bash
AGENT_PLUGINS_FILE=plugins.skill-reviewed.local.yaml bun run local
```

新组合增加 skills.prompt，共五插件、两个 Agent，导航出现「使用 Skill」。配置包含完整的固定指令、来源和已取得的许可正文，不含模型密钥；`*.local.yaml` 默认被 Git 忽略。请保留来源和许可，不把包含个人配置的文件提交到仓库。

在「连接与模型」填写自己的标准提供者设置，保存后重启。进入「使用 Skill」填写目标、材料和约束，结果以文本返回；实际经过 SkillRuntime、Prompt Executor 与模型网关，详情中可以查看 Skill/Model Step。SDK 可能重试，不能把一次任务等同于一次计费请求。无需真实模型即可完成读取/审查/导出；没有配置时生成按钮禁用，后端也会拒绝。

## 已实际验证的公开来源

本地浏览器实际读取 [Anthropic frontend-design](https://github.com/anthropics/skills/blob/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design/SKILL.md)：

- 提交：`ca45fc496a3436251f191354091d557da31c15b5`。
- 原始文件：9,390 字节，SHA-256 `d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3`。
- 取得同一提交的[许可文件](https://github.com/anthropics/skills/blob/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design/LICENSE.txt)，10,174 字节，Apache 2.0；许可原文随下载配置保存。其他 Skill 的许可需要逐一核对，系统不作许可判断。

下载的配置已实际保存并重启装配。使用本机受控 OpenAI 协议服务，确认模型请求包含原 Skill 正文，并生成有 Agent/Skill/Model 三个步骤的运行。下图的回答明确标记为固定协议样例，**不代表真实模型质量、前端设计效果或代码执行**。

![真实上游 Skill 与本机协议样例的已保存结果](images/github-skill-result.png)

清空演示模型并重启后，来源、三条历史根运行和结果仍可读取；375px 下的审查、长指纹、完整指令与历史结果没有页面横向溢出。实际使用时换成自己的模型，结果仍需核对。

## 支持范围与版本凭证

- 链接需为公开 github.com 的 blob 文件地址，分支名不含斜杠，路径暂限 ASCII；只使用默认 HTTPS 端口。私有仓库、Enterprise、认证和任意仓库代码执行不在当前范围。
- 分支先解析为完整提交，再读取固定原文；运行使用配置中的快照，不在每次任务开始时拉取 GitHub。上游更新后需重新发现、审查与导出。
- 只加载一个导入 Skill，ID 固定为 community.imported-prompt。上下游元数据不会授予 Bash、Read 或任意其他外部 Tool。
- 原始文件 SHA 对应完整 SKILL.md；执行步骤另存已注册指令 SHA（正文加宿主边界），成功产物也保留。它不代表完整模型请求、权重或语义质量，也不是来源签名。
- Skill 最长 45 秒，输出最多 256 KiB。模型内容与代码文本不等于实际执行、文件修改或渲染验证；附属资源缺失会限制能力。
- Skill 内部不支持持久化人工追问。既有模型执行器的内部追问函数可能使该次 Skill 失败；应补全任务后重新运行。Agent 层已有的暂停/恢复能力保持。
- 读取 GitHub 会把公开仓库路径发给 GitHub；运行时把固定指令与任务发给所选模型。应用仍是本机管理界面，不是公开的多用户服务或进程沙箱。

实现/测试地图见[功能卡](../backend/src/connectors/skill-workbench/FEATURE.md)、[专项测试](../backend/test/skillWorkbench.test.ts)与[取消/超时回归](../backend/test/toolSkillRuntime.test.ts)。标准文件格式参考 [Agent Skills 官方规范](https://agentskills.io/specification)；现有本地导入和 Context7 工具适配见[社区接入指南](COMMUNITY_PLUGINS.md)。
