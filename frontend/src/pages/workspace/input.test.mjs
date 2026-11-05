import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { prepareInput, isLegacyDashboardSearch, sourceHref } from './input.ts';

test('knowledge tasks use their governed input contracts and reject empty prompts', () => {
  assert.deepEqual(prepareInput('knowledge.answer', ' 发布规则 '), { question: '发布规则', limit: 5 });
  for (const capability of ['knowledge.markdown.retrieve', 'knowledge.web.retrieve']) assert.deepEqual(prepareInput(capability, ' API '), { operation: 'search', query: 'API', limit: 5 });
  assert.deepEqual(prepareInput('delivery.ops.orchestrate', '查看任务'), { prompt: '查看任务', source: 'private' });
  assert.deepEqual(prepareInput('knowledge.impact.check', 'first，second third'), { runIds: ['first', 'second', 'third'], operation: 'check' });
  assert.throws(() => prepareInput('knowledge.answer', ' '));
});

test('source links allow web pages and Obsidian note opening without accepting arbitrary protocols', () => {
  assert.equal(sourceHref('https://example.com/note'), 'https://example.com/note');
  assert.equal(sourceHref('obsidian://open?vault=Notes&file=Rule.md'), 'obsidian://open?vault=Notes&file=Rule.md');
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'obsidian://advanced-uri?command=x', 'https://key:secret@example.com', '/tmp/note']) assert.equal(sourceHref(value), undefined);
});

test('existing dashboard links stay on the dashboard while workspace task links open the composer', () => {
  assert.equal(isLegacyDashboardSearch('?groupId=oc_demo&dashboardId=20261105'), true);
  assert.equal(isLegacyDashboardSearch('?dashboardId=20261105'), true);
  assert.equal(isLegacyDashboardSearch('?capability=knowledge.markdown.retrieve&query=groupId'), false);
  assert.equal(isLegacyDashboardSearch(''), false);
});
