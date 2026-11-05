# 本地文档导入和网页资料收集

网页收集和文档导入插件把外部资料转为带来源的 Markdown；独立资料库插件可收录这些结果。转换结果可以复制或下载，再放入自己选择的 Markdown/Obsidian 目录；不会自动改写笔记。

## 安装文档转换环境

从 backend 执行（Python 3.10–3.14；CI 和本地实测使用 3.13）：

```bash
python3 -m venv .data/markitdown
.data/markitdown/bin/python -m pip install -r src/connectors/markitdown/requirements.txt
```

也可用 uv venv .data/markitdown --python 3.13，再用 uv pip install --python .data/markitdown/bin/python -r src/connectors/markitdown/requirements.txt。固定版本为微软 MarkItDown 0.1.9。安装只在本地执行；应用不会自动安装依赖。

完成原仓库本地初始化后，默认 HTTP 组合已包含两个插件。也可只装采集和资料库三个能力：

```bash
AGENT_PLUGINS_FILE=examples/plugins.collectors.yaml bun run src/index.ts
```

可信插件配置可用 community.markitdown 的 python 字段指定其他虚拟环境的 Python 路径；不接受模型输入提供命令、文件路径或云服务参数。

## 使用

- 在「网页收集」粘贴一个公开文章 URL，收集正文、来源、时间和内容版本。无需模型；不支持登录、交互页面或全站抓取。
- 在「文档导入」选择 PDF、DOCX、PPTX、XLSX、TXT 或 Markdown。单文件最多 10 MiB，转换正文最多 512 KiB。扫描 PDF 的 OCR 暂未接入。
- 检查成功结果后点击「收录到资料库」，保存到应用自己的目录；/library 可立即检索。重复收录不新增副本，已有改动不覆盖。
- 在资料库点击「设为知识来源」并重启后端，可在知识库中使用已有 RAG 回答和引用复核。显式插件配置以文件为准；生成回答需要自己的模型配置。
- 结果抽屉提供「复制 Markdown」「下载 Markdown」，原始来源凭证保存在详情中。文档下载正文包含原文件名、SHA-256、时间和引擎版本。

文件只上传到本机后端；本适配器使用流式转换、关闭上游插件且不提供模型/Azure 客户端。原始暂存成功/失败转换后移除，未使用文件在 24 小时后由下一次上传清理。转换结果保存在本地运行记录中。复杂排版、图表、公式和缺字需要自行核对；当前不是敌对文件或多人公开上传沙箱。

契约与验证见[网页收集功能卡](../backend/src/knowledge/capture/FEATURE.md)和[文档导入功能卡](../backend/src/connectors/markitdown/FEATURE.md)。上游代码与许可见[微软 MarkItDown](https://github.com/microsoft/markitdown)。
