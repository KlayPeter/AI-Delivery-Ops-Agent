import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { prepareReleaseInput } from './releaseInput.ts';

const now = Date.parse('2026-11-05T12:00:00Z');
const values = { since: '2026-11-01T08:00:00+08:00', policyQuery: ' API 迁移 ' };
test('release input normalizes dates and omits the end time so the server chooses collection time', () => {
  assert.deepEqual(prepareReleaseInput(values, 'collect', now), { since: '2026-11-01T00:00:00.000Z', policyQuery: 'API 迁移', operation: 'collect', limit: 5 });
  assert.equal(prepareReleaseInput({ ...values, until: '2026-11-04T08:00:00+08:00' }, 'prepare', now).until, '2026-11-04T00:00:00.000Z');
});
test('release input rejects invalid, reversed and future windows and empty or oversized policy queries', () => {
  for (const patch of [{ since: '' }, { since: 'invalid' }, { until: 'invalid' }, { until: values.since }, { until: '2026-10-01' }, { until: '2027-01-01' }, { policyQuery: ' ' }, { policyQuery: 'x'.repeat(501) }]) {
    assert.throws(() => prepareReleaseInput({ ...values, ...patch }, 'prepare', now));
  }
});
