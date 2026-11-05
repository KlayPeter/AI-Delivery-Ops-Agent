import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Checkbox, Empty, Form, Input, Select, Skeleton, Tag } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';
import { capabilityName, errorMessage, useWorkspace } from './state';
import RunDrawer from './RunDrawer';
import { noteBody } from './noteBody';

interface Proposal { id: string; title: string; state: 'draft' | 'approved' | 'saved'; sourceRunId: string; filename: string; content: string; approvalSha256: string; createdAt: string; savedAt?: string; checkedAt: string; references: { path: string; documentVersion: string; sourceKind: string }[] }
interface Proposals { directory: string; proposals: Pick<Proposal, 'id' | 'title' | 'state' | 'sourceRunId' | 'createdAt' | 'savedAt'>[] }
export default function KnowledgeWritebackPage() {
  const { data: workspace, mutate: refreshWorkspace } = useWorkspace();
  const { data, error: loadingError, isLoading, mutate: refresh } = useSWR<Proposals>('knowledge-note-proposals', api.fetchNoteProposals);
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reviewed, setReviewed] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null), [patch, setPatch] = useState(''), [runId, setRunId] = useState<string | null>(null), [lastRunId, setLastRunId] = useState<string | null>(null);
  const candidates = (workspace?.runs || []).filter(run => !run.parentRunId && run.status === 'succeeded' && ['knowledge.answer', 'release.prepare'].includes(run.capability));
  const resetPreview = () => { setProposal(null); setPatch(''); setReviewed(false); };
  const source = async (id: string) => {
    setBusy(true); setError(''); resetPreview(); form.setFieldsValue({ title: '', markdown: '' });
    try { const value = await api.fetchNoteSource(id); form.setFieldsValue({ title: `${value.capability === 'knowledge.answer' ? '知识回答' : '发布准备'} · ${id.slice(0, 8)}`, markdown: value.markdown }); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const execute = async (input: Record<string, unknown>) => {
    const result = await api.runAgent('knowledge.note.writeback', input, crypto.randomUUID());
    setLastRunId(result.runId);
    const detail = await api.fetchRun(result.runId);
    if (detail.run.status !== 'succeeded') throw new Error(detail.run.error?.message || '操作未完成，请查看运行记录');
    const artifact = detail.artifacts.find((value: { metadata?: { artifactRole?: string } }) => ['knowledge.note.proposal', 'knowledge.note.receipt'].includes(value.metadata?.artifactRole || ''));
    if (!artifact) throw new Error('记录缺少笔记提案或保存回执');
    setProposal(artifact.content.proposal); setPatch(artifact.content.patch); setReviewed(false);
  };
  const prepare = async (values: { sourceRunId: string; title: string; markdown: string }) => {
    setBusy(true); setError(''); resetPreview();
    try { await execute({ operation: 'prepare', ...values }); }
    catch (e) { setError(errorMessage(e)); } finally { await Promise.allSettled([refresh(), refreshWorkspace()]); setBusy(false); }
  };
  const approve = async () => {
    if (!proposal || !reviewed) return;
    setBusy(true); setError('');
    try { await execute({ operation: 'apply', proposalId: proposal.id, reviewedSha256: proposal.approvalSha256, confirmed: true }); }
    catch (e) { setError(errorMessage(e)); } finally { await Promise.allSettled([refresh(), refreshWorkspace()]); setBusy(false); }
  };
  const openProposal = async (id: string) => {
    setBusy(true); setError(''); resetPreview();
    try { const value = await api.fetchNoteProposal(id); setProposal(value); setPatch(value.patch); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const download = () => {
    if (!proposal || !patch) return;
    const url = URL.createObjectURL(new Blob([patch], { type: 'text/plain;charset=utf-8' })), link = document.createElement('a');
    link.href = url; link.download = `${proposal.filename}.patch`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>笔记回写</h1><p>把值得保留的回答或发布草稿，审查后存成一份带来源的新笔记。</p></div><div className="form-actions">{lastRunId && <Button onClick={() => setRunId(lastRunId)}>查看本次记录</Button>}<Button disabled={busy} onClick={() => { refresh(); refreshWorkspace(); }}>刷新列表</Button></div></div>
    {loadingError ? <Alert type="error" showIcon title="笔记提案加载失败" description={errorMessage(loadingError)} /> : isLoading ? <Skeleton active /> : <>
      <p className="muted break-text">收件目录：{data?.directory}。只新建文件，已有笔记保持原样。</p>
      {error && <Alert type="error" showIcon title="笔记操作未完成" description={error} />}
      <section className="knowledge-search"><details open={!proposal}><summary><strong>1. 整理要保留的内容</strong></summary>
        {!candidates.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="最近 50 次根运行中还没有成功的知识回答或发布草稿" />}
        <Form form={form} layout="vertical" disabled={busy} onFinish={prepare} onValuesChange={resetPreview}>
          <Form.Item name="sourceRunId" label="来源结果" rules={[{ required: true, message: '请选择成功的回答或发布草稿' }]} extra="仅接受带可核验知识引用的成功记录；不会把模型输出自动认定为事实。"><Select showSearch optionFilterProp="label" placeholder="从最近的成功结果中选择" options={candidates.map(run => ({ value: run.id, label: `${capabilityName(run.capability)} · ${dayjs(run.createdAt).format('MM-DD HH:mm')} · ${run.id.slice(0, 8)}` }))} onChange={source} /></Form.Item>
          <Form.Item name="title" label="笔记标题" rules={[{ required: true, whitespace: true, message: '请填写标题' }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="markdown" label="要保存的正文（Markdown）" rules={[{ required: true, whitespace: true, message: '请填写正文' }, { validator: async (_, value: string) => { if (new TextEncoder().encode(value || '').length > 64 * 1024) throw new Error('正文最多 64 KiB'); } }]} extra="可以修改措辞和结论。生成提案后，完整文件会附上原运行与引用版本供你审查。"><Input.TextArea rows={8} spellCheck={false} /></Form.Item>
          <div className="form-actions"><Button type="primary" htmlType="submit" loading={busy} disabled={!candidates.length}>生成新笔记提案</Button></div>
        </Form></details>
      </section>
      {proposal && <section className="knowledge-search"><div className="connection-title"><h2>2. 审查完整笔记</h2><Tag color={proposal.state === 'saved' ? 'success' : 'warning'}>{proposal.state === 'saved' ? '已有保存回执' : proposal.state === 'approved' ? '已确认，待核对写入结果' : '尚未写入'}</Tag></div>
        <p className="break-text">{proposal.title} · {proposal.filename}</p><p className="muted break-text">保存位置：{data?.directory}</p>
        <p className="muted">来源版本检查于 {dayjs(proposal.checkedAt).format('YYYY-MM-DD HH:mm:ss')}。{proposal.state === 'saved' ? '这是保存前的核验；来源和文件的后续变化不会自动复查。' : '确认时会重新检查；来源变化、缺失或无法核验会拒绝新建。'}</p>
        <pre className="json-view">{noteBody(proposal.content)}</pre>
        <details><summary>审查完整文件（含来源记录）</summary><pre className="json-view">{proposal.content}</pre></details>
        <details><summary>查看引用版本与内容指纹</summary><p className="muted break-text">审查指纹：{proposal.approvalSha256}</p><ul>{proposal.references.map((value, index) => <li key={index} className="break-text">{value.path} · {value.documentVersion}</li>)}</ul></details>
        {patch && <details><summary>查看新建文件补丁</summary><pre className="json-view">{patch}</pre><Button onClick={download}>下载补丁供审查</Button></details>}
        <div className="form-actions"><Button disabled={busy} onClick={() => setRunId(proposal.sourceRunId)}>查看原结果</Button><Button disabled={busy} onClick={() => setRunId(proposal.id)}>查看提案记录</Button></div>
        {proposal.state === 'saved' ? <Alert type="success" showIcon title="笔记已创建并在保存时读回验证" description={`保存时间：${dayjs(proposal.savedAt).format('YYYY-MM-DD HH:mm:ss')}。回执不表示此文件现在仍未变化；原结果与已有笔记保持。`} /> : <>
          <div className="form-actions"><Checkbox checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)}>我已核对完整内容和收件目录，确认新建这份笔记</Checkbox></div>
          <div className="form-actions"><Button type="primary" loading={busy} disabled={!reviewed} onClick={approve}>确认新建笔记</Button></div>
          <p className="muted">此步骤会写入上方目录。没有模型调用；重读网页引用可能联网。版本核验不证明笔记结论正确。重复确认同一提案只创建一份文件。</p>
        </>}
      </section>}
      <section className="knowledge-search"><h2>最近的笔记提案</h2>{!data?.proposals.length ? <p className="muted">还没有提案。生成预览不会写入笔记目录。</p> : <ul className="review-list">{data.proposals.map(item => <li className="review-row" key={item.id}><div className="review-content"><strong className="break-text">{item.title}</strong><p className="muted">{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')} · {item.state === 'saved' ? '已有保存回执' : item.state === 'approved' ? '已确认，待核对结果' : '待审查'}</p></div><Button disabled={busy} onClick={() => openProposal(item.id)}>打开提案</Button></li>)}</ul>}</section>
    </>}
    <RunDrawer key={runId || 'closed'} runId={runId} onClose={() => setRunId(null)} onSelectRun={setRunId} />
  </div>;
}
