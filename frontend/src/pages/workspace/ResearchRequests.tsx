import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, Checkbox, Input, Select, Skeleton } from 'antd';
import { api } from '@/api';
import { errorMessage } from './state';
import { toolArguments } from './toolInput';

interface Tool { id: string; description: string; inputSchema: unknown; destination: string; contractSha256: string }
interface ExternalRequest { toolId: string; arguments: Record<string, unknown>; contractSha256: string }
export interface ResearchRequestSelection { requests: ExternalRequest[]; confirmed: boolean }
export default function ResearchRequests({ value, onChange, disabled }: { value: ResearchRequestSelection; onChange: (value: ResearchRequestSelection) => void; disabled: boolean }) {
  const { data, error: loadingError, isLoading, mutate } = useSWR<{ tools: Tool[] }>('research-tools', api.fetchResearchTools);
  const [toolId, setToolId] = useState<string>(), [argumentsText, setArgumentsText] = useState('{}'), [error, setError] = useState('');
  const selected = data?.tools.find(tool => tool.id === toolId);
  const add = () => {
    setError('');
    try {
      if (!selected || value.requests.length >= 3) throw new Error('请选择工具，最多添加三份固定请求。');
      onChange({ requests: [...value.requests, { toolId: selected.id, arguments: toolArguments(argumentsText), contractSha256: selected.contractSha256 }], confirmed: false });
    } catch (e) { setError(errorMessage(e)); }
  };
  return <details className="research-requests">
    <summary>调用已接入工具（可选）</summary>
    <p>为这次研究准备最多三份固定请求。Agent 按需选择，工具和参数保持原样；整次研究最多四次委派，固定请求可能重复使用。</p>
    {loadingError ? <Alert type="error" title="工具目录加载失败" action={<Button onClick={() => mutate()}>重试</Button>} /> : isLoading ? <Skeleton active paragraph={{ rows: 2 }} /> : !data?.tools.length ? <p className="muted">接入 MCP 或 OpenAPI 读取插件后，可在这里选择工具。未选择时，研究沿用知识库等现有资料能力。</p> : <>
      <label htmlFor="research-tool">已装配的读取工具</label>
      <Select id="research-tool" className="research-tool-select" value={toolId} disabled={disabled} placeholder="选择本次需要的工具" showSearch optionFilterProp="label" options={data.tools.map(tool => ({ value: tool.id, label: tool.id }))} onChange={id => { setToolId(id); setArgumentsText('{}'); setError(''); onChange({ ...value, confirmed: false }); }} />
      {selected && <><p className="muted break-text">实际服务：{selected.destination}</p><p className="muted break-text">{selected.description}</p><details><summary>查看参数契约</summary><pre className="json-view">{JSON.stringify(selected.inputSchema, null, 2)}</pre></details></>}
      <label htmlFor="research-tool-arguments">固定参数（JSON 对象，最多 32 KiB）</label>
      <Input.TextArea id="research-tool-arguments" rows={4} value={argumentsText} disabled={disabled} spellCheck={false} onChange={event => { setArgumentsText(event.target.value); onChange({ ...value, confirmed: false }); }} />
      {error && <Alert type="error" title="未能添加请求" description={error} />}
      <div className="form-actions"><Button disabled={disabled || !selected || value.requests.length >= 3} onClick={add}>加入本次研究</Button></div>
    </>}
    {value.requests.map((request, index) => {
      const current = data?.tools.find(tool => tool.id === request.toolId && tool.contractSha256 === request.contractSha256);
      return <div key={index} className="research-request-item">
        <p className="break-text"><strong>{index + 1}. {request.toolId}</strong></p>
        <p className="muted break-text">{current ? current.destination : '当前契约不可用，请移除后重新添加'}</p>
        <details><summary>核对固定参数</summary><pre className="json-view">{JSON.stringify(request.arguments, null, 2)}</pre></details>
        <Button disabled={disabled} onClick={() => onChange({ requests: value.requests.filter((_, i) => i !== index), confirmed: false })} aria-label={`移除第 ${index + 1} 份工具请求`}>移除</Button>
      </div>;
    })}
    {!!value.requests.length && <Checkbox disabled={disabled} checked={value.confirmed} onChange={event => onChange({ ...value, confirmed: event.target.checked })}>我已核对以上服务和固定参数，允许本次研究按需发送；实际服务行为由提供者实现</Checkbox>}
    <p className="muted">固定参数也会发给当前模型，并保存在本机确认记录中。未执行的请求不会算作研究资料；暂停后继续不能新增或修改请求，服务或契约变化需重新发起。</p>
  </details>;
}
