import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { findPluginPage, pluginAgentHref, activePluginPage } from './pages.ts';

test('only installed plugin pages resolve, including a trailing slash', () => {
  const page = { path: '/standups', label: '站会统计', section: 'team', view: { kind: 'builtin', id: 'standups' } };
  assert.equal(findPluginPage([page], '/standups'), page);
  assert.equal(findPluginPage([page], '/standups/'), page);
  assert.equal(findPluginPage([], '/standups'), undefined);
  assert.equal(findPluginPage(undefined, '/standups'), undefined);
  assert.equal(findPluginPage([page], '/standups-other'), undefined);
});

test('dashboard and Gantt links require their installed owner, including legacy aliases', () => {
  const dashboard = { path: '/dashboard', label: '项目看板', section: 'team', view: { kind: 'builtin', id: 'dashboard' } };
  const gantt = { ...dashboard, path: '/human-gantt', view: { kind: 'builtin', id: 'human-gantt' } };
  for (const [path, search, expected] of [['/dashboard', '', dashboard], ['/human-gantt/', '', gantt], ['/', '?groupId=oc_demo', dashboard], ['/', '?dashboardId=old', dashboard], ['/delivery-dashboard-2026-07-07.html', '', dashboard], ['/中文快照.html', '', dashboard]]) {
    assert.equal(findPluginPage([dashboard, gantt], path, search), expected);
    assert.equal(activePluginPage([dashboard, gantt], path, search), expected);
    assert.equal(findPluginPage([], path, search), undefined);
  }
  for (const path of ['/other/nested.html', '/bad%2fname.html', '/broken%ZZ.html']) assert.equal(findPluginPage([dashboard], path), undefined);
  assert.equal(findPluginPage([dashboard], '/', '?capability=example.run'), undefined);
});

test('agent entries keep their active navigation after opening the task composer', () => {
  const page = { path: '/mcp-reader', label: 'MCP 文件读取', section: 'workspace', view: { kind: 'agent', capability: 'example.mcp.read' } };
  assert.equal(activePluginPage([page], '/', '?capability=example.mcp.read'), page);
  assert.equal(activePluginPage([page], '/runs', '?capability=example.mcp.read'), undefined);
  assert.equal(activePluginPage([], '/', '?capability=example.mcp.read'), undefined);
});

test('hidden archive entries still resolve through the installed page registry', () => {
  const page = { path: '/meeting-summaries', label: '会议纪要', navigation: false, section: 'team', view: { kind: 'builtin', id: 'meeting-summaries' } };
  assert.equal(findPluginPage([page], '/meeting-summaries'), page);
  assert.equal(findPluginPage([], '/meeting-summaries'), undefined);
});

test('agent page links stay inside the workspace and encode the capability', () => {
  assert.equal(pluginAgentHref('example.mcp.read'), '/?capability=example.mcp.read');
  const url = new URL(pluginAgentHref('example.run&next=https://foreign.example'), 'http://localhost');
  assert.equal(url.origin, 'http://localhost'); assert.equal(url.searchParams.get('next'), null);
  assert.equal(url.searchParams.get('capability'), 'example.run&next=https://foreign.example');
});
