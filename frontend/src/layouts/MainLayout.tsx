import { Suspense, useState } from 'react';
import { Button, Drawer, Layout, Menu, Spin } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { AppstoreOutlined, CheckSquareOutlined, CodeOutlined, DashboardOutlined, DatabaseOutlined, DesktopOutlined, FileTextOutlined, HistoryOutlined, MenuOutlined, RobotOutlined, ScheduleOutlined, SettingOutlined, UnorderedListOutlined, ApiOutlined } from '@ant-design/icons';
import logo from '../assets/logo.svg';
import { useWorkspace } from '@/pages/workspace/state';

const link = (path: string, label: string) => <Link to={path}>{label}</Link>;
const items = [
  { key: '/', icon: <AppstoreOutlined aria-hidden />, label: link('/', '工作台') },
  { key: '/runs', icon: <HistoryOutlined aria-hidden />, label: link('/runs', '运行记录') },
  { key: '/agents', icon: <RobotOutlined aria-hidden />, label: link('/agents', 'Agent') },
  { key: '/knowledge', icon: <DatabaseOutlined aria-hidden />, label: link('/knowledge', '知识库') },
  { key: '/plugins', icon: <AppstoreOutlined aria-hidden />, label: link('/plugins', '插件') },
  { type: 'divider' as const },
  { key: 'team', label: '团队交付', icon: <ScheduleOutlined aria-hidden />, children: [
    { key: '/dashboard', icon: <DashboardOutlined aria-hidden />, label: link('/dashboard', '项目看板') },
    { key: '/human-gantt', icon: <ScheduleOutlined aria-hidden />, label: link('/human-gantt', '人力甘特图') },
    { key: '/standups', icon: <CheckSquareOutlined aria-hidden />, label: link('/standups', '站会统计') },
    { key: '/weekly-reports', icon: <FileTextOutlined aria-hidden />, label: link('/weekly-reports', '周报') },
    { key: '/debug', icon: <CodeOutlined aria-hidden />, label: link('/debug', '业务任务') },
  ] },
  { key: 'manage', type: 'group' as const, label: '管理', children: [
    { key: '/connections', icon: <ApiOutlined aria-hidden />, label: link('/connections', '连接与模型') },
    { key: '/config', icon: <SettingOutlined aria-hidden />, label: link('/config', '定时与团队配置') },
    { key: '/logs', icon: <UnorderedListOutlined aria-hidden />, label: link('/logs', '审计日志') },
    { key: '/contexts', icon: <DatabaseOutlined aria-hidden />, label: link('/contexts', '上下文') },
  ] },
];
const titles: Record<string, string> = { '/': '工作台', '/runs': '运行记录', '/agents': 'Agent', '/knowledge': '知识库', '/plugins': '插件', '/connections': '连接与模型', '/config': '定时与团队配置', '/logs': '审计日志', '/contexts': '上下文', '/dashboard': '项目看板', '/human-gantt': '人力甘特图', '/standups': '站会统计', '/weekly-reports': '周报', '/debug': '业务任务' };

export const MainLayout = () => {
  const location = useLocation();
  const { data, error } = useWorkspace();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigation = <nav aria-label="主导航"><Menu mode="inline" selectedKeys={[location.pathname]} items={items} onClick={() => setNavigationOpen(false)} /></nav>;
  return <Layout className="app-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <Layout.Sider width={216} theme="light" className="app-sidebar">
      <Link className="brand" to="/"><img src={logo} alt="" /><span>Delivery Agent<small>个人 Agent 工作空间</small></span></Link>
      {navigation}
      <div className="sidebar-footer"><DesktopOutlined aria-hidden /><span>本地工作区</span></div>
    </Layout.Sider>
    <Layout className="app-body">
      <header className="app-header"><div className="header-location"><Button className="mobile-menu" type="text" aria-label="打开导航" aria-expanded={navigationOpen} aria-controls="mobile-navigation" icon={<MenuOutlined aria-hidden />} onClick={() => setNavigationOpen(true)} /><span className="header-workspace">工作空间</span><span className="header-separator">/</span><span>{titles[location.pathname] || '项目看板'}</span></div>
        <span className="runtime-status" role="status"><span className={data?.health.started && !error ? 'status-dot ready' : 'status-dot'} />{error ? '后端未连接' : data?.health.started ? '本地运行中' : '连接中'}</span>
      </header>
      <main id="main-content" tabIndex={-1} className={`shell-outlet${location.pathname === '/human-gantt' ? ' shell-outlet--immersive' : ''}`}><Suspense fallback={<Spin size="large" style={{ display: 'block', margin: '120px auto' }} />}><Outlet /></Suspense></main>
    </Layout>
    <Drawer title="导航" placement="left" open={navigationOpen} onClose={() => setNavigationOpen(false)} width={280}><div id="mobile-navigation">{navigation}</div></Drawer>
  </Layout>;
};
