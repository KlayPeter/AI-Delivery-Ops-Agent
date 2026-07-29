import React, { useEffect, useState } from 'react';
import { Card, Tree, message, Button, Space, Typography, Spin, Badge } from 'antd';
import { ClusterOutlined, UserOutlined } from '@ant-design/icons';
import { api } from '@/api';

const { Text } = Typography;

interface CompanyMember {
    open_id: string;
    name: string;
    department: string | null;
    is_active: boolean;
}

interface TreeNodeData {
    title: React.ReactNode;
    key: string;
    children?: TreeNodeData[];
    isLeaf?: boolean;
    icon?: React.ReactNode;
}

function buildTree(data: CompanyMember[]): TreeNodeData[] {
    const root: Record<string, any> = {};

    data.forEach(member => {
        const depStr = member.department || '未分组';
        const parts = depStr.split('/').filter(Boolean);
        let currentLevel = root;
        parts.forEach((part, index) => {
            if (!currentLevel[part]) currentLevel[part] = { _members: [], _children: {} };
            if (index === parts.length - 1) currentLevel[part]._members.push(member);
            currentLevel = currentLevel[part]._children;
        });
    });

    const convertToTreeData = (node: Record<string, any>, path: string = ''): TreeNodeData[] => {
        return Object.keys(node).map(key => {
            const currentPath = path ? `${path}/${key}` : key;
            const membersInNode = node[key]._members || [];
            const memberNodes: TreeNodeData[] = membersInNode.map((member: CompanyMember) => ({
                title: (
                    <Space>
                        <Text>{member.name}</Text>
                        {!member.is_active && <Badge status="default" text="离职" />}
                    </Space>
                ),
                key: member.open_id,
                isLeaf: true,
                icon: <UserOutlined style={{ color: '#1677ff' }} />,
            }));
            return {
                title: <Text strong>{key}</Text>,
                key: currentPath,
                children: [...convertToTreeData(node[key]._children, currentPath), ...memberNodes],
                icon: <ClusterOutlined />,
            };
        });
    };

    return convertToTreeData(root);
}

export const CompanyDirectoryTree: React.FC = () => {
    const [members, setMembers] = useState<CompanyMember[]>([]);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [treeData, setTreeData] = useState<TreeNodeData[]>([]);

    const fetchMembers = async () => {
        setLoading(true);
        try {
            const data = await api.fetchCompanyMembers();
            setMembers(data);
            setTreeData(buildTree(data));
        } catch (e: any) {
            message.error('获取公司成员失败：' + e.message);
        } finally {
            setLoading(false);
        }
    };

    const syncDirectory = async () => {
        setSyncing(true);
        try {
            const res = await api.syncCompanyMembers();
            message.success(`同步完成，共更新 ${res.result?.synced ?? res.synced ?? 0} 个成员`);
            await fetchMembers();
        } catch (e: any) {
            message.error('同步失败：' + e.message);
        } finally {
            setSyncing(false);
        }
    };

    useEffect(() => {
        fetchMembers();
    }, []);

    return (
        <Card
            title="公司通讯录"
            extra={
                <Space>
                    <Button
                        type="primary"
                        onClick={syncDirectory}
                        loading={syncing}
                    >
                        全量同步公司通讯录
                    </Button>
                </Space>
            }
            bordered={false}
            style={{ boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)', minHeight: 400 }}
        >
            {loading && members.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px' }}>
                    <Spin />
                </div>
            ) : members.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                    暂无通讯录数据，请点击右上角进行同步
                </div>
            ) : (
                <Tree
                    showIcon
                    defaultExpandAll
                    treeData={treeData}
                    selectable={false}
                    style={{ fontSize: '15px' }}
                />
            )}
        </Card>
    );
};
