import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserChecks } from './preflight.ts';

test('capability checks keep missing browser features distinct and do not imply network health', () => {
  const checks = browserChecks({ secure: false, crypto: false, websocket: true, worker: false, storage: true, streams: false });
  assert.deepEqual(checks.filter(check => !check.available).map(check => check.id), ['secure', 'crypto', 'worker', 'streams']);
  assert.equal(checks.length, 6);
});
