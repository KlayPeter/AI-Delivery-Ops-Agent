import React from 'react';
import { Layout, Menu } from 'antd';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { DashboardOutlined, UnorderedListOutlined, CheckSquareOutlined, CodeOutlined, DatabaseOutlined, SettingOutlined, ScheduleOutlined, FileTextOutlined } from '@ant-design/icons';
import logo from '../assets/logo.svg';

const { Header, Content } = Layout;

export const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const immersive = location.pathname === '/human-gantt';

  const menuItems = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '进度看板',
    },
    {
      key: '/human-gantt',
      icon: <ScheduleOutlined />,
      label: '人力甘特图',
    },
    {
      key: '/logs',
      icon: <UnorderedListOutlined />,
      label: '系统审计日志',
    },
    {
      key: '/standups',
      icon: <CheckSquareOutlined />,
      label: '站会统计',
    },
    {
      key: '/weekly-reports',
      icon: <FileTextOutlined />,
      label: '周报',
    },
    {
      key: '/debug',
      icon: <CodeOutlined />,
      label: '手动触发',
    },
    {
      key: '/contexts',
      icon: <DatabaseOutlined />,
      label: '上下文记忆',
    },

    {
      key: '/config',
      icon: <SettingOutlined />,
      label: '系统配置',
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', height: 58, background: '#101d31', padding: '0 28px', boxShadow: '0 6px 22px rgba(15,29,49,.16)', zIndex: 30, position: 'sticky', top: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', color: '#fff', fontFamily: 'Avenir Next, PingFang SC, sans-serif', fontSize: '22px', fontWeight: 750, marginRight: '42px', letterSpacing: '-.02em', whiteSpace: 'nowrap' }}>
          <img src={logo} alt="logo" style={{ height: '32px', marginRight: '12px' }} />
          AI Delivery Ops Agent
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0, fontSize: '15px', background: 'transparent', lineHeight: '58px', borderBottom: 'none' }}
        />
      </Header>
      <Content style={{ background: '#f2f4f7', padding: immersive ? 0 : '24px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ background: immersive ? 'transparent' : '#fff', flex: 1, borderRadius: immersive ? 0 : '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </div>
      </Content>
    </Layout>
  );
};
