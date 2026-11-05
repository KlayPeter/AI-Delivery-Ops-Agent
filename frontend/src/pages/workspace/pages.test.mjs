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

test('agent entries keep their active navigation after opening the task composer', () => {
  const page = { path: '/mcp-reader', label: 'MCP 文件读取', section: 'workspace', view: { kind: 'agent', capability: 'example.mcp.read' } };
  assert.equal(activePluginPage([page], '/', '?capability=example.mcp.read'), page);
  assert.equal(activePluginPage([page], '/runs', '?capability=example.mcp.read'), undefined);
  assert.equal(activePluginPage([], '/', '?capability=example.mcp.read'), undefined);
});

test('agent page links stay inside the workspace and encode the capability', () => {
  assert.equal(pluginAgentHref('example.mcp.read'), '/?capability=example.mcp.read');
  const url = new URL(pluginAgentHref('example.run&next=https://foreign.example'), 'http://localhost');
  assert.equal(url.origin, 'http://localhost'); assert.equal(url.searchParams.get('next'), null);
  assert.equal(url.searchParams.get('capability'), 'example.run&next=https://foreign.example');
});
