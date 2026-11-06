import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Empty, Input, Skeleton, Tag } from 'antd';
import { ArrowRightOutlined, AppstoreOutlined, RobotOutlined } from '@ant-design/icons';
import { agentDescription, capabilityName, needsModel, pluginName, useWorkspace } from './state';
import { agentPageHref } from './pages';

export default function CatalogPage({ plugins = false }: { plugins?: boolean }) {
  const { data, error, isLoading } = useWorkspace();
  const [search, setSearch] = useState('');
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const visiblePlugins = data?.plugins.filter(p => matches(`${pluginName(p.id, p.name)} ${p.name} ${p.id}`)) || [];
  const visibleAgents = data?.agents.filter(a => matches(`${a.name} ${agentDescription(a)} ${a.capabilities.map(cap => capabilityName(cap, a.name)).join(' ')}`)) || [];
  return <div className="workspace-page">
    <div className="page-heading"><div><h1>{plugins ? '插件' : 'Agent'}</h1><p>{plugins ? '每个功能独立装配，组合成你的工作空间。' : '选择适合当前工作的能力，交给对应的 Agent 执行。'}</p></div>{plugins && data?.pages.some(page => page.view.kind === 'builtin' && page.view.id === 'profile-composer') && <Link to="/plugin-profiles">接入与组合 <ArrowRightOutlined aria-hidden /></Link>}</div>
    {error && <Alert type="error" title="能力列表加载失败" description={error.message} />}
    <Input.Search className="catalog-search" aria-label={plugins ? '搜索插件' : '搜索 Agent'} placeholder={plugins ? '搜索插件…' : '搜索 Agent 或能力…'} value={search} onChange={e => setSearch(e.target.value)} allowClear />
    {isLoading ? <Skeleton active /> : <div className="catalog-grid">
      {plugins ? visiblePlugins.map(plugin => <article className="catalog-card" key={plugin.id}>
        <div className="catalog-card-top"><span className="icon-tile"><AppstoreOutlined aria-hidden /></span><Tag>v{plugin.version}</Tag></div>
        <h2>{pluginName(plugin.id, plugin.name)}</h2><p>{data?.agents.find(agent => plugin.agents.includes(agent.agentId)) ? agentDescription(data.agents.find(agent => plugin.agents.includes(agent.agentId))!) : plugin.description}</p><div className="capability-tags"><Tag>已装配</Tag><span className="muted">{plugin.agents.length} 个 Agent</span></div>
        <details><summary>插件详情</summary><code>{plugin.id}</code><p className="muted">依赖：{plugin.requires?.join('、') || '无'}</p></details>
      </article>) : visibleAgents.map(agent => <article className="catalog-card" key={agent.agentId}>
        <div className="catalog-card-top"><span className="icon-tile"><RobotOutlined aria-hidden /></span><Tag>{agent.runtime === 'model-loop' ? '模型循环' : agent.runtime === 'native' ? '固定流程' : '外部 Agent'}</Tag></div>
        <h2>{capabilityName(agent.capabilities[0] || agent.name, agent.name)}</h2><p>{agentDescription(agent)}</p>
        <div className="capability-tags">{agent.capabilities.map(cap => <Tag key={cap}>{capabilityName(cap, agent.name)}</Tag>)}</div>
        {needsModel(agent) && !data?.modelConfigured ? <Link to="/connections">先连接模型 <ArrowRightOutlined aria-hidden /></Link> : <Link to={agentPageHref(data?.pages, agent.capabilities[0])}>发起任务 <ArrowRightOutlined aria-hidden /></Link>}
      </article>)}
    </div>}
    {!isLoading && !(plugins ? visiblePlugins : visibleAgents).length && <Empty description={search ? '没有匹配的能力，试试其他关键词' : '当前没有装配能力'} />}
    {plugins && <div className="catalog-footnote">插件通过本地配置文件装配，重启后生效。<a href="https://github.com/KlayPeter/AI-Delivery-Ops-Agent/blob/main/docs/PLUGIN_AUTHORING.md" target="_blank" rel="noreferrer">查看插件规范 <ArrowRightOutlined aria-hidden /></a></div>}
  </div>;
}
