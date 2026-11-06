import { Suspense, useState } from 'react';
import { Button, Drawer, Layout, Menu, Spin } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { AppstoreOutlined, CheckSquareOutlined, CodeOutlined, DashboardOutlined, DatabaseOutlined, DesktopOutlined, FileTextOutlined, HistoryOutlined, MenuOutlined, RobotOutlined, ScheduleOutlined, SettingOutlined, UnorderedListOutlined, ApiOutlined } from '@ant-design/icons';
import logo from '../assets/logo.svg';
import { useWorkspace } from '@/pages/workspace/state';
import { activePluginPage, hasTeamNavigation, homeTasks, navigationSection, type PluginPage } from '@/pages/workspace/pages';

const link = (path: string, label: string) => <Link to={path}>{label}</Link>;
const pluginIcons: Record<string, React.ReactNode> = { 'knowledge-reviews': <HistoryOutlined aria-hidden />, knowledge: <DatabaseOutlined aria-hidden />, standups: <CheckSquareOutlined aria-hidden />, dashboard: <DashboardOutlined aria-hidden />, 'human-gantt': <ScheduleOutlined aria-hidden />, 'weekly-reports': <FileTextOutlined aria-hidden />, 'meeting-summaries': <FileTextOutlined aria-hidden /> };
const pluginLinks = (pages: PluginPage[], section: PluginPage['section']) => pages.filter(page => page.section === section && page.navigation !== false).map(page => ({ key: page.path, icon: page.view.kind === 'builtin' ? pluginIcons[page.view.id] || <RobotOutlined aria-hidden /> : <RobotOutlined aria-hidden />, label: link(page.path, page.label) }));
const items = (pages: PluginPage[], manualJobs: string[]) => [
  { key: '/', icon: <AppstoreOutlined aria-hidden />, label: link('/', '工作台') },
  { key: '/runs', icon: <HistoryOutlined aria-hidden />, label: link('/runs', '运行记录') },
  ...homeTasks(pages).flatMap(task => pluginLinks(pages.filter(page => page.path === task.path), 'workspace')),
  { key: '/connections', icon: <ApiOutlined aria-hidden />, label: link('/connections', '连接与模型') },
  { key: 'extensions', label: '工具与插件', icon: <AppstoreOutlined aria-hidden />, children: [
    ...pluginLinks(pages.filter(page => navigationSection(page, page.path) === 'extensions'), 'workspace'),
    { key: '/agents', icon: <RobotOutlined aria-hidden />, label: link('/agents', 'Agent') },
    { key: '/plugins', icon: <AppstoreOutlined aria-hidden />, label: link('/plugins', '插件') },
  ] },
  ...(hasTeamNavigation(pages, manualJobs) ? [{ type: 'divider' as const },
  { key: 'team', label: '团队交付', icon: <ScheduleOutlined aria-hidden />, children: [
    ...pluginLinks(pages, 'team'),
    ...(manualJobs.length ? [{ key: '/debug', icon: <CodeOutlined aria-hidden />, label: link('/debug', '业务任务') }] : []),
  ] }] : []),
  { key: 'manage', label: '运行管理', icon: <SettingOutlined aria-hidden />, children: [
    ...(hasTeamNavigation(pages, manualJobs) ? [{ key: '/config', icon: <SettingOutlined aria-hidden />, label: link('/config', '定时与团队配置') }] : []),
    { key: '/logs', icon: <UnorderedListOutlined aria-hidden />, label: link('/logs', '审计日志') },
    { key: '/contexts', icon: <DatabaseOutlined aria-hidden />, label: link('/contexts', '上下文') },
  ] },
];
const titles: Record<string, string> = { '/': '工作台', '/runs': '运行记录', '/agents': 'Agent', '/plugins': '插件', '/connections': '连接与模型', '/config': '定时与团队配置', '/logs': '审计日志', '/contexts': '上下文', '/debug': '业务任务' };

export const MainLayout = () => {
  const location = useLocation();
  const { data, error, applyingConfig } = useWorkspace();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>([]);
  const pages = data?.pages || [];
  const activePage = activePluginPage(pages, location.pathname, location.search);
  const activeSection = navigationSection(activePage, location.pathname);
  const navigation = <nav aria-label="主导航"><Menu mode="inline" openKeys={activeSection ? [...new Set([...openSections, activeSection])] : openSections} onOpenChange={setOpenSections} selectedKeys={[activePage?.path || location.pathname]} items={items(pages, data?.manualJobs || [])} onClick={() => setNavigationOpen(false)} /></nav>;
  return <Layout className="app-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <Layout.Sider width={216} theme="light" className="app-sidebar">
      <Link className="brand" to="/"><img src={logo} alt="" /><span>Delivery Agent<small>个人 Agent 工作空间</small></span></Link>
      {navigation}
      <div className="sidebar-footer"><DesktopOutlined aria-hidden /><span>本地工作区</span></div>
    </Layout.Sider>
    <Layout className="app-body">
      <header className="app-header"><div className="header-location"><Button className="mobile-menu" type="text" aria-label="打开导航" aria-expanded={navigationOpen} aria-controls="mobile-navigation" icon={<MenuOutlined aria-hidden />} onClick={() => setNavigationOpen(true)} /><span className="header-workspace">工作空间</span><span className="header-separator">/</span><span>{activePage?.label || titles[location.pathname] || '页面'}</span></div>
        <span className="runtime-status" role="status"><span className={data?.health.started && !error ? 'status-dot ready' : 'status-dot'} />{applyingConfig ? '正在应用配置' : error ? '后端未连接' : data?.health.started ? '本地运行中' : '连接中'}</span>
      </header>
      <main id="main-content" tabIndex={-1} inert={applyingConfig} aria-busy={applyingConfig} className={`shell-outlet${activePage?.view.kind === 'builtin' && activePage.view.id === 'human-gantt' ? ' shell-outlet--immersive' : ''}`}><Suspense fallback={<Spin size="large" style={{ display: 'block', margin: '120px auto' }} />}><Outlet /></Suspense></main>
    </Layout>
    <Drawer title="导航" placement="left" open={navigationOpen} onClose={() => setNavigationOpen(false)} size={280}><div id="mobile-navigation">{navigation}</div></Drawer>
  </Layout>;
};
