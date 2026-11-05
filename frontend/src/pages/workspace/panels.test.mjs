import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { parseStatusPanels } from './panels.ts';

test('accepts versioned text-only plugin panels including source status and internal run links', () => {
  const panels = [{ schemaVersion: '1.0', tone: 'warning', title: '引用需要复核', checkedAt: '2026-11-05T01:00:00Z', items: [{ label: 'Rules.md', value: '内容已变化', detail: '原版本 abc · 当前版本 def' }], relatedRun: { id: 'check-run', label: '查看检查记录' } }];
  assert.deepEqual(parseStatusPanels(panels), panels);
  assert.deepEqual(parseStatusPanels([{ schemaVersion: '1.0', tone: 'neutral', title: '未检查' }]), [{ schemaVersion: '1.0', tone: 'neutral', title: '未检查' }]);
});

test('invalid, oversized, or unsupported plugin presentation data falls back without crashing the result viewer', () => {
  const panel = { schemaVersion: '1.0', tone: 'success', title: '版本未变化' };
  for (const value of [undefined, {}, [], [null], [{ ...panel, schemaVersion: '2.0' }], [{ ...panel, tone: { toString: null } }],
    [{ ...panel, checkedAt: 'invalid' }], [{ ...panel, items: {} }], [{ ...panel, items: [{ label: 'Rules.md', value: 42 }] }],
    [{ ...panel, relatedRun: { id: '', label: '查看' } }], [{ ...panel, title: 'x'.repeat(161) }], Array.from({ length: 21 }, () => panel),
  ]) assert.equal(parseStatusPanels(value), null);
});
