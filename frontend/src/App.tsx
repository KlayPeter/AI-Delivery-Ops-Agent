import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { App as AntdApp, ConfigProvider, Spin, theme } from 'antd';
import { MainLayout } from '@/layouts/MainLayout';

// 页面组件
import ConfigPage from '@/pages/ConfigPage';
import DashboardPage from '@/pages/DashboardPage';
import LogsPage from '@/pages/LogsPage';
import DebugPage from '@/pages/DebugPage';
import ContextsPage from '@/pages/ContextsPage';
import StandupsPage from '@/pages/StandupsPage';
import MeetingSummariesPage from '@/pages/MeetingSummariesPage';
import WeeklyReportsPage from '@/pages/WeeklyReportsPage';
const HumanGanttPage = lazy(() => import('@/pages/HumanGanttPage'));

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <AntdApp>
        <BrowserRouter>
          <Routes>
          {/* 使用 MainLayout 包裹所有需要通用导航的页面 */}
          <Route path="/" element={<MainLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="human-gantt" element={<Suspense fallback={<Spin size="large" style={{ margin: '120px auto' }} />}><HumanGanttPage /></Suspense>} />
            <Route path="standups" element={<StandupsPage />} />
            <Route path="weekly-reports" element={<WeeklyReportsPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="debug" element={<DebugPage />} />
            <Route path="contexts" element={<ContextsPage />} />
            <Route path="meeting-summaries" element={<MeetingSummariesPage />} />
            <Route path="config" element={<ConfigPage />} />
          </Route>
          </Routes>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
