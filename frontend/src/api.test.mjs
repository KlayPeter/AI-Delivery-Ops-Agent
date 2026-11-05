import { test, expect } from 'bun:test';
import axios from 'axios';

test('start receipts retry transport failures with the same task key and never retry a server rejection', async () => {
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
  } finally { axios.defaults.adapter = previousAdapter; globalThis.window = previousWindow; }
});
