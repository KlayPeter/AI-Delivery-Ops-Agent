import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { App as AntdApp, ConfigProvider, Spin, theme } from 'antd';
import { MainLayout } from '@/layouts/MainLayout';
import { isLegacyDashboardSearch } from '@/pages/workspace/input';

// 页面组件
import ConfigPage from '@/pages/ConfigPage';
import DashboardPage from '@/pages/DashboardPage';
import LogsPage from '@/pages/LogsPage';
import DebugPage from '@/pages/DebugPage';
import ContextsPage from '@/pages/ContextsPage';
import MeetingSummariesPage from '@/pages/MeetingSummariesPage';
import WeeklyReportsPage from '@/pages/WeeklyReportsPage';
const HumanGanttPage = lazy(() => import('@/pages/HumanGanttPage'));
const WorkspacePage = lazy(() => import('@/pages/workspace/WorkspacePage'));
const CatalogPage = lazy(() => import('@/pages/workspace/CatalogPage'));
const ConnectionsPage = lazy(() => import('@/pages/workspace/ConnectionsPage'));
const KnowledgePage = lazy(() => import('@/pages/workspace/KnowledgePage'));
const PluginPage = lazy(() => import('@/pages/workspace/PluginPage'));

function WorkspaceEntry() {
  return isLegacyDashboardSearch(useLocation().search) ? <DashboardPage /> : <WorkspacePage />;
}

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: {
      colorPrimary: '#1e40af', colorBgLayout: '#f8fafc', colorText: '#182230', colorTextSecondary: '#596579', colorTextPlaceholder: '#667085', colorBorder: '#dfe4ec',
      borderRadius: 8, fontSize: 15, fontWeightStrong: 600, controlHeight: 40,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    }, components: { Menu: { itemHeight: 44, itemSelectedBg: '#edf2ff', itemSelectedColor: '#1e40af' }, Button: { primaryShadow: 'none' } } }}>
      <AntdApp>
        <BrowserRouter>
          <Routes>
          {/* 使用 MainLayout 包裹所有需要通用导航的页面 */}
          <Route path="/" element={<MainLayout />}>
            <Route index element={<WorkspaceEntry />} />
            <Route path="runs" element={<WorkspacePage key="history" history />} />
            <Route path="agents" element={<CatalogPage />} />
            <Route path="plugins" element={<CatalogPage key="plugins" plugins />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="human-gantt" element={<Suspense fallback={<Spin size="large" style={{ margin: '120px auto' }} />}><HumanGanttPage /></Suspense>} />
            <Route path="weekly-reports" element={<WeeklyReportsPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="debug" element={<DebugPage />} />
            <Route path="contexts" element={<ContextsPage />} />
            <Route path="meeting-summaries" element={<MeetingSummariesPage />} />
            <Route path="config" element={<ConfigPage />} />
            {/* 兼容已被推送到群里的包含具体 .html 文件名的旧版本长链接 */}
            <Route path="*" element={<PluginPage />} />
          </Route>
          </Routes>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
