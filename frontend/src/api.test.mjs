import { test, expect } from 'bun:test';
import axios from 'axios';

test('workspace transport preserves receipt keys, rejects server errors and confirms a new configuration instance', async () => {
  const previousWindow = globalThis.window, previousAdapter = axios.defaults.adapter;
  let handle;
  globalThis.window = { location: { hostname: 'localhost' } };
  axios.defaults.adapter = config => handle(config);
  try {
    const { api } = await import('./api.ts');
    const requests = [];
    handle = async config => {
      requests.push(JSON.parse(config.data));
      if (requests.length === 1) throw new Error('response lost');
      return { config, headers: {}, status: 202, statusText: 'Accepted', data: { runId: 'same-run', status: 'running' } };
    };
    expect(await api.startAgent('example.echo', { text: 'hello' }, 'stable-key')).toEqual({ runId: 'same-run', status: 'running' });
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0].triggerId).toBe('stable-key');
    let attempts = 0;
    handle = async () => { attempts++; throw Object.assign(new Error('rejected'), { isAxiosError: true, response: { status: 409, data: { error: 'different input' } } }); };
    await expect(api.startAgent('example.echo', {}, 'conflict')).rejects.toMatchObject({ status: 409, message: 'different input' });
    expect(attempts).toBe(1);
    attempts = 0; handle = async () => { attempts++; throw new Error('offline'); };
    await expect(api.startAgent('example.echo', {}, 'uncertain')).rejects.toThrow('先到运行记录检查'); expect(attempts).toBe(2);
    const saved = { instanceId: 'before', restartRequired: true, reloadAvailable: true };
    attempts = 0;
    expect(await api.applyConnections({ ...saved, reloadAvailable: false })).toMatchObject({ restartRequired: true });
    expect(attempts).toBe(0);
    let polls = 0;
    handle = async config => {
      attempts++;
      if (config.method === 'post') {
        expect(config.url).toBe('/workspace/reload'); expect(JSON.parse(config.data)).toEqual({});
        throw Object.assign(new Error('acknowledgement lost'), { isAxiosError: true });
      }
      if (config.url === '/workspace/state') return { config, headers: {}, status: 200, statusText: 'OK', data: { plugins: [] } };
      polls++;
      return { config, headers: {}, status: 200, statusText: 'OK', data: polls === 1 ? saved : { ...saved, instanceId: 'after', restartRequired: false } };
    };
    expect(await api.applyConnections(saved)).toMatchObject({ instanceId: 'after', restartRequired: false });
    expect(polls).toBe(2); expect(attempts).toBe(4);
    attempts = 0;
    handle = async () => { attempts++; throw Object.assign(new Error('busy'), { isAxiosError: true, response: { status: 409, data: { error: '配置已保存；请等待当前任务' } } }); };
    await expect(api.applyConnections(saved)).rejects.toMatchObject({ status: 409, message: '配置已保存；请等待当前任务' });
    expect(attempts).toBe(1);

  } finally { axios.defaults.adapter = previousAdapter; globalThis.window = previousWindow; }
});
