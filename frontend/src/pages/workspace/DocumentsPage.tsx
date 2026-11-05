import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Input, Tag } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import { api } from '@/api';
import { errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';

export default function DocumentsPage() {
  const { mutate } = useWorkspace();
  const { data, error: statusError, mutate: check, isLoading, isValidating } = useSWR<{ available: boolean; version?: string }>('documents-status', api.fetchDocumentStatus);
  const [file, setFile] = useState<File>(), [stage, setStage] = useState(''), [error, setError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const convert = async () => {
    if (!file) return;
    setError(''); setStage('正在上传');
    try {
      const uploaded = await api.uploadDocument(file);
      setStage('正在转换');
      const result = await api.runAgent('knowledge.document.convert', { documentId: uploaded.documentId }, crypto.randomUUID());
      setRunId(result.runId); await mutate();
    } catch (e) { setError(errorMessage(e)); } finally { setStage(''); }
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>文档导入</h1><p>把 PDF、Word、PPT 和 Excel 转成便于阅读与检索的 Markdown。</p></div><Tag>本地转换</Tag></div>
    <section className="knowledge-search">
      <div className="connection-title"><span className="icon-tile"><FileTextOutlined aria-hidden /></span><h2>转换一份资料</h2></div>
      {isLoading && <p role="status" className="muted">正在检查本地转换环境…</p>}
      {(statusError || (!isLoading && !data?.available)) && <Alert type="warning" showIcon title="文档转换环境尚未就绪" description="请按仓库 docs/DOCUMENT_IMPORT.md 安装本地 MarkItDown 环境，然后重新检查。" action={<Button loading={isValidating} onClick={() => check()}>重新检查</Button>} />}
      <label htmlFor="document-file">选择文件</label><Input id="document-file" type="file" accept=".pdf,.docx,.pptx,.xlsx,.txt,.md" onChange={event => { setFile(event.target.files?.[0]); setError(''); }} disabled={Boolean(stage)} />
      <p className="muted">单文件不超过 10 MiB。提取可读取的文字，暂不支持扫描件 OCR；转换结果需核对格式和内容。</p>
      {error && <Alert type="error" showIcon title="文档未能转换" description={error} />}
      <div className="form-actions"><Button type="primary" onClick={convert} loading={Boolean(stage)} disabled={!file || !data?.available}>{stage || '转成 Markdown'}</Button>{data?.available && <span className="muted">MarkItDown {data.version}</span>}</div>
      <p className="muted">文件只发送到本地后端，不调用模型服务。转换后原始暂存文件移除，结果和来源指纹保存在运行记录。</p>
    </section>
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
