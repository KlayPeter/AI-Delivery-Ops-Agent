import { DatePicker, Select, Space, Button } from 'antd';
import dayjs from 'dayjs';
import { EVENT_TYPE_MAP } from '@/constants';

const { RangePicker } = DatePicker;

export const LogsFilter = ({ filters, setFilters, groups, handleSearch, handleReset }: any) => {
  return (
    <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
      <RangePicker
        value={filters.startDate ? [dayjs(filters.startDate), dayjs(filters.endDate)] : null}
        onChange={(dates: any) => {
          if (dates) {
            setFilters({...filters, startDate: dates[0].format('YYYY-MM-DD'), endDate: dates[1].format('YYYY-MM-DD')});
          } else {
            setFilters({...filters, startDate: null, endDate: null});
          }
        }}
      />
      <Select
        style={{ width: 150 }}
        value={filters.eventType}
        onChange={(val) => setFilters({...filters, eventType: val})}
      >
        <Select.Option value="all">全部分类</Select.Option>
        <Select.Option value="ai_*">全部 AI</Select.Option>
        {Object.entries(EVENT_TYPE_MAP).map(([key, val]) => (
          <Select.Option key={key} value={key}>{val.text}</Select.Option>
        ))}
      </Select>

      <Select
        style={{ width: 150 }}
        value={filters.groupId}
        onChange={(val) => setFilters({...filters, groupId: val})}
        placeholder="筛选目标对象"
      >
        <Select.Option value="all">所有对象</Select.Option>
        <Select.OptGroup label="群聊">
          {groups.map((g: any) => <Select.Option key={g.chat_id} value={g.chat_id}>{g.name || g.chat_id}</Select.Option>)}
        </Select.OptGroup>
        <Select.OptGroup label="私聊成员">
          {Array.from(new Map(groups.flatMap((g: any) => g.members || []).map((m: any) => [m.open_id, m])).values()).map((m: any) => (
            <Select.Option key={m.open_id} value={m.open_id}>{m.name} (私聊)</Select.Option>
          ))}
        </Select.OptGroup>
      </Select>

      <Space>
        <Button type="primary" onClick={handleSearch}>查询</Button>
        <Button onClick={handleReset}>重置</Button>
      </Space>
    </div>
  );
};
