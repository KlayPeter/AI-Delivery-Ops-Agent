import { lazy } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useWorkspace } from './state';
import { findPluginPage, pluginAgentHref } from './pages';
import DashboardPage from '@/pages/DashboardPage';

const StandupsPage = lazy(() => import('@/pages/StandupsPage'));

export default function PluginPage() {
  const { data, error, isLoading, mutate } = useWorkspace();
  const { pathname } = useLocation();
  if (pathname.endsWith('.html')) return <DashboardPage />;
  if (error) return <div className="workspace-page"><Alert type="error" title="无法确认页面是否已启用" description="检查本地后端连接后重试。" action={<Button onClick={() => mutate()}>重试</Button>} /></div>;
  if (isLoading) return <div className="workspace-page"><Skeleton active /></div>;
  const page = findPluginPage(data?.pages, pathname);
  if (page?.view.kind === 'agent') return <Navigate replace to={pluginAgentHref(page.view.capability)} />;
  if (page?.view.kind === 'builtin' && page.view.id === 'standups') return <StandupsPage />;
  return <div className="workspace-page"><Empty description={page ? '当前界面版本尚不支持此插件页面' : '此页面不存在或对应插件未启用'}><Link className="primary-link" to="/plugins">查看已装配插件</Link></Empty></div>;
}
