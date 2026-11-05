import { Table, Typography, Tag } from 'antd';
import dayjs from 'dayjs';
import { getEventMapping } from '@/constants';
import type { TableColumnsType } from 'antd';

const { Text } = Typography;

export const LogsTable = ({ logs, loading, groups, pagination, fetchLogs, appliedFilters }: any) => {
  const columns: TableColumnsType<any> = [
    {
      title: '操作时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      align: 'center',
      width: 200,
      render: (text: string) => dayjs(text).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '目标对象',
      key: 'group_id',
      align: 'center',
      width: 150,
      render: (_: any, record: any) => {
        const payload = record.details || record.payload || record;
        const isPrivate = payload.chat_type === 'private' || payload.chat_type === 'p2p';

        const possibleIds = isPrivate
          ? [payload.sender_open_id, payload.open_id, payload.target_open_id, payload.target, payload.group_id, payload.source_group_id, payload.chat_id].filter(Boolean)
          : [payload.group_id, payload.source_group_id, payload.chat_id, payload.open_id, payload.sender_open_id, payload.target_open_id, payload.target].filter(Boolean);

        if (possibleIds.length === 0) {
          if (isPrivate && payload.sender) return <Tag color="blue">{payload.sender} (私聊)</Tag>;
          return <Text type="secondary">-</Text>;
        }

        let displayName = '';

        for (const id of possibleIds) {
          // Check groups
          const group = groups.find((g: any) => g.chat_id === id);
          if (group) {
            displayName = group.name || id;
            break;
          }
          // Check members
          for (const g of groups) {
            const member = (g.members || []).find((m: any) => m.open_id === id);
            if (member) {
              displayName = `${member.name} (私聊)`;
              break;
            }
          }
          if (displayName) break;
        }

        if (!displayName && isPrivate && payload.sender) displayName = `${payload.sender} (私聊)`;
        if (!displayName) displayName = possibleIds[0];

        return <Tag color="blue">{displayName}</Tag>;
      }
    },
    {
      title: '事件类型',
      key: 'event_type',
      align: 'center',
      width: 150,
      render: (_: any, record: any) => {
        const rawType = record.action || record.event_type;
        const payload = record.details || record.payload || record;
        if (rawType === 'bot_message_sent' && payload.ok === false) {
          return <Tag color="red">发送失败</Tag>;
        }
        const mapping = getEventMapping(rawType);
        return <Tag color={mapping.color}>{mapping.text}</Tag>;
      },
    },
    {
      title: '摘要信息',
      key: 'summary',
      render: (_: any, record: any) => {
        const payload = record.details || record.payload || record;
        const eventType = record.action || record.event_type;
        let summary: string;
        if (eventType === 'bot_message_sent' && payload.ok === false) {
          summary = `发送失败: ${payload.error || JSON.stringify(payload.raw || {})}`;
          if (payload.text_preview) summary += ` | 内容: ${payload.text_preview}`;
        } else if (eventType === 'ai_intent_failed') {
          const categoryMap: Record<string, string> = {
            rate_limited: 'AI 服务限流（429）',
            timeout: 'AI 服务响应超时',
            unavailable: 'AI 服务暂时不可用',
          };
          summary = categoryMap[payload.category] || 'AI 意图解析失败';
          if (payload.fallback === 'deterministic_rule') summary += '，已尝试规则降级';
          if (payload.error) summary += `：${payload.error}`;
        } else if (eventType === 'task_command_rule_fallback') {
          const categoryMap: Record<string, string> = {
            rate_limited: 'AI 服务限流（429）',
            timeout: 'AI 服务响应超时',
            unavailable: 'AI 服务暂时不可用',
          };
          summary = `${categoryMap[payload.category] || 'AI 意图解析失败'}，已按任务规则继续处理`;
        } else if (eventType === 'message_processing_failed') {
          const categoryMap: Record<string, string> = {
            ai_rate_limited: 'AI 服务限流（429）',
            ai_unavailable: 'AI 服务暂时不可用',
            tapd_unavailable: 'TAPD 服务暂时不可用',
            network_or_timeout: '网络或请求超时',
            internal_error: '内部处理异常',
          };
          summary = categoryMap[payload.category] || '消息处理失败';
          if (payload.error) summary += `：${payload.error}`;
        } else if ([
          'ai_daily_summary_failed',
          'ai_standup_summary_failed',
          'ai_standup_supplement_summary_failed',
          'ai_standup_parse_failed',
          'ai_weekly_report_failed',
        ].includes(eventType)) {
          const categoryMap: Record<string, string> = {
            rate_limited: 'AI 服务限流（429）',
            timeout: 'AI 服务响应超时',
            invalid_response: 'AI 返回内容无效',
            unavailable: 'AI 服务暂时不可用',
          };
          const fallbackMap: Record<string, string> = {
            deterministic_rule: '已按确定性规则生成',
            structured_rule: '已尝试固定格式规则',
            deterministic_narrative: '已按确定性事实模板生成',
          };
          summary = categoryMap[payload.category] || 'AI 处理失败';
          if (payload.fallback) summary += `，${fallbackMap[payload.fallback] || `已降级为 ${payload.fallback}`}`;
          if (payload.stage) summary += `（阶段：${payload.stage}）`;
          if (payload.error || payload.reason) summary += `：${payload.error || payload.reason}`;
        } else if (eventType === 'standup_saved') {
          const resolutionMap: Record<string, string> = {
            quoted_bot_message: '引用机器人消息',
            same_day_prompt: '自动关联当天提醒',
            single_group_membership: '按唯一群成员身份归属',
          };
          summary = `${payload.user_name || payload.open_id || '成员'} 已提交 ${payload.date || '当日'} 站会`;
          if (payload.context_resolution) summary += `（${resolutionMap[payload.context_resolution] || payload.context_resolution}）`;
        } else if (eventType === 'daily_summary_started') {
          summary = `开始生成 ${payload.date || '当日'} 群聊日报`;
        } else if (eventType === 'daily_summary_history_synced') {
          summary = `已同步 ${payload.date || '当日'} 群聊记录：${payload.synced ?? 0} 条（新增 ${payload.inserted ?? 0} 条）`;
        } else if (eventType === 'daily_summary_generated') {
          summary = `已生成 ${payload.date || '当日'} 群聊日报`;
          if (typeof payload.duration_ms === 'number') summary += `，耗时 ${(payload.duration_ms / 1000).toFixed(1)} 秒`;
        } else if (eventType === 'job_duplicate_skipped') {
          const jobMap: Record<string, string> = { "daily-summary": "群聊日报归纳", "weekly-report": "周报生成与发送", "dashboard": "看板生成与上传", "ai-hot": "AI 热点推送", "standup-push": "推送普通站会模板", "task-standup-template": "推送任务型站会模板" };
          summary = `已跳过重复的【${jobMap[payload.job_name] || payload.job_name || '定时任务'}】触发`;
          if (payload.run_id) summary += `（原运行：${payload.run_id}）`;
        } else if (payload.text && typeof payload.text === 'string') {
          summary = payload.text;
        } else if (payload.text_preview) {
          summary = payload.text_preview;
          if (payload.sender_name) summary = `[${payload.sender_name}] ${summary}`;
        } else if (payload.content && typeof payload.content === 'string') {
          summary = `发送内容: ${payload.content}`;
        } else if (payload.intent) {
          summary = `意图: ${payload.intent} / 置信度: ${payload.confidence ?? '-'}`;
        } else if (payload.job_name) {
          const jobMap: Record<string, string> = { "daily-summary": "群聊日报归纳", "standup-summary": "生成站会汇总", "dashboard": "看板生成与上传", "overdue-scan": "超期任务扫描", "standup-remind": "站会未交提醒", "standup-push": "推送普通站会模板", "task-standup-template": "推送任务型站会模板" };
          const jn = jobMap[payload.job_name] || payload.job_name;
          summary = `执行了【${jn}】任务`;
          if (payload.trigger) summary += ` (触发方式: ${payload.trigger === 'manual' ? '手动' : '定时'})`;
          if (payload.error) summary += ` / 失败: ${payload.error}`;
        } else if (payload.stage) {
          summary = `执行阶段: ${payload.stage}`;
          if (payload.reason) summary += ` / 原因: ${payload.reason}`;
          if (payload.error) summary += ` / 错误: ${payload.error}`;
          if (payload.message_count) summary += ` / 涉及消息数: ${payload.message_count}`;
        } else if (payload.date && payload.stats) {
          summary = `生成 ${payload.date} 日报 | 任务数:${payload.stats.tasks} / 进度:${payload.stats.progress_updates} / 阻塞:${payload.stats.blockers} / 风险:${payload.stats.risks}`;
        } else {
          const parts = [];

          if (payload.title) parts.push(`对象: ${payload.title}`);
          if (payload.owner) parts.push(`负责人: ${payload.owner}`);
          if (payload.status) {
             const statusMap: Record<string, string> = { "in_progress": "进行中", "owner_marked_done": "负责人已标记完成", "accepted": "已验收", "blocked": "已阻塞", "cancelled": "已取消", "overdue": "已超期" };
             parts.push(`状态: ${statusMap[payload.status] || payload.status}`);
          }
          if (payload.error) parts.push(`异常信息: ${payload.error}`);
          if (payload.changes) parts.push(`变更内容: ${JSON.stringify(payload.changes)}`);
          if (payload.reason) parts.push(`原因: ${payload.reason}`);
          if (payload.due_date) parts.push(`截止日期: ${payload.due_date}`);
          if (payload.scenario) parts.push(`场景: ${payload.scenario}`);
          if (payload.task_id) parts.push(`任务ID: ${payload.task_id}`);
          if (payload.open_id) parts.push(`用户OpenID: ${payload.open_id}`);

          if (parts.length > 0) {
            summary = parts.join(" | ");
          } else {
            const rawStr = JSON.stringify(payload);
            summary = rawStr.length > 100 ? rawStr.substring(0, 100) + "..." : rawStr;
          }
        }

        return <Text ellipsis style={{ width: '100%', maxWidth: '500px', display: 'inline-block' }}>{summary}</Text>;
      },
    },
  ];

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fff', borderRadius: '8px' }}>
      <Table
        columns={columns}
        dataSource={logs}
        rowKey={(record, index) => `${record.timestamp}-${index}`}
        loading={loading}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          showSizeChanger: true,
          onChange: (page, pageSize) => fetchLogs(page, pageSize, appliedFilters),
        }}
        expandable={{
          expandedRowRender: (record) => (
            <pre style={{ margin: 0, padding: '16px', background: '#f5f5f5', borderRadius: '4px', fontSize: '13px', overflowX: 'auto' }}>
              {JSON.stringify(record.details || record.payload || record, null, 2)}
            </pre>
          ),
        }}
      />
    </div>
  );
};
