import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { findPluginPage, pluginAgentHref, activePluginPage, agentPageHref, hasTeamNavigation, defaultCapability } from './pages.ts';

test('default capability uses installed active agents and preserves explicit unavailable links', () => {
  const personal = [{ status: 'inactive', capabilities: ['delivery.ops.orchestrate'] }, { status: 'active', capabilities: ['knowledge.markdown.retrieve'] }];
  assert.equal(defaultCapability(personal), 'knowledge.markdown.retrieve');
  assert.equal(defaultCapability([...personal, { status: 'active', capabilities: ['knowledge.mixed.retrieve'] }]), 'knowledge.mixed.retrieve');
  assert.equal(defaultCapability(personal, 'missing.capability'), 'missing.capability');
  assert.equal(defaultCapability([...personal, { status: 'active', capabilities: ['delivery.ops.orchestrate'] }]), 'delivery.ops.orchestrate');
  assert.equal(defaultCapability([{ status: 'active', capabilities: ['example.echo'] }]), 'example.echo');
  assert.equal(defaultCapability([{ status: 'inactive', capabilities: ['example.echo'] }]), '');
  assert.equal(defaultCapability(), '');
});

test('team navigation requires a visible contributed team page or an owned manual job', () => {
  const workspace = { path: '/knowledge', section: 'workspace' };
  const hidden = { path: '/meeting-summaries', section: 'team', navigation: false };
  const visible = { path: '/standups', section: 'team' };
  assert.equal(hasTeamNavigation(), false);
  assert.equal(hasTeamNavigation([workspace, hidden]), false);
  assert.equal(hasTeamNavigation([visible]), true);
  assert.equal(hasTeamNavigation([], ['daily-summary']), true);
});

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

test('structured plugin capabilities open their declared form and removed entries fall back to the composer', () => {
  const page = { path: '/documents', label: '文档导入', section: 'workspace', view: { kind: 'builtin', id: 'documents', capability: 'knowledge.document.convert' } };
  assert.equal(agentPageHref([page], 'knowledge.document.convert'), '/documents');
  assert.equal(agentPageHref([], 'knowledge.document.convert'), '/?capability=knowledge.document.convert');
  assert.equal(agentPageHref([page], 'example.prompt'), '/?capability=example.prompt');
});
