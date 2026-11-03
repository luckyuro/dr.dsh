import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { apply } from './index.ts';
import { Reporter } from './reporter.ts';
import type { DshContextLike } from './dsh-surface.ts';

function harness(): { ctx: DshContextLike; emit: (event: string, ...args: unknown[]) => void; dispose: () => void } {
  const listeners = new Map<string, (...args: readonly unknown[]) => unknown>();
  let dispose = () => {};
  return {
    ctx: {
      effect: factory => { dispose = factory(); },
      on: (name, listener) => { listeners.set(name, listener); return () => { listeners.delete(name); }; },
    },
    emit: (event, ...args) => { listeners.get(event)?.(...args); },
    dispose: () => dispose(),
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('local report did not finish');
}

test('reports authenticate, whitelist metadata, and discard invalid session handles', async t => {
  const reports: unknown[] = [];
  let authenticated = true;
  const token = 'x'.repeat(43);
  const server = createServer((req, res) => {
    authenticated &&= req.headers.authorization === `Bearer ${token}`;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { reports.push(JSON.parse(body)); res.writeHead(202).end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const reporter = new Reporter({ daemonUrl: `http://127.0.0.1:${address.port}`, daemonToken: token, report: ['turn_complete'] });
  const h = harness();
  const dispose = reporter.start(h.ctx);
  t.after(dispose);
  h.emit('session/event', 'session-1', { type: 'turn/end', text: 'secret prompt' });
  h.emit('session/event', '/private/source.ts', { type: 'turn/end' });
  await until(() => reporter.stats().delivered === 2);
  assert.ok(authenticated, 'every request must carry the daemon credential');
  assert.equal(reports.length, 2);
  const first = reports[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(first).sort(), ['atMs', 'event', 'sessionRef', 'severity']);
  assert.equal(first['sessionRef'], 'session-1');
  assert.equal((reports[1] as Record<string, unknown>)['sessionRef'], null);
  assert.doesNotMatch(JSON.stringify(reports), /secret|private|source/);
});

test('in-flight delivery is bounded and disposal aborts pending requests', async t => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    const signal = init.signal!;
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const reporter = new Reporter({ daemonUrl: 'http://127.0.0.1:8790', daemonToken: 'x'.repeat(43), report: ['turn_complete'] });
  const h = harness();
  const dispose = reporter.start(h.ctx);
  for (let i = 0; i < 100; i++) h.emit('session/event', 'session-1', { type: 'turn/end' });
  assert.equal(signals.length, 8);
  assert.equal(reporter.stats().dropped, 92);
  dispose();
  assert.ok(signals.every(signal => signal.aborted));
  await until(() => reporter.stats().dropped === 100);
  h.emit('session/event', 'session-1', { type: 'turn/end' });
  assert.equal(signals.length, 8);
});

test('reporting stays inactive outside supervision while local management mounts independently', t => {
  const beforeUrl = process.env['DRDSH_REPORT_URL'];
  const beforeToken = process.env['DRDSH_REPORT_TOKEN'];
  t.after(() => {
    if (beforeUrl === undefined) delete process.env['DRDSH_REPORT_URL']; else process.env['DRDSH_REPORT_URL'] = beforeUrl;
    if (beforeToken === undefined) delete process.env['DRDSH_REPORT_TOKEN']; else process.env['DRDSH_REPORT_TOKEN'] = beforeToken;
  });
  delete process.env['DRDSH_REPORT_URL'];
  delete process.env['DRDSH_REPORT_TOKEN'];
  const effects: string[] = [];
  const ctx = { ...harness().ctx, effect: (_callback: unknown, label?: string) => { effects.push(label ?? ''); } };
  apply(ctx);
  assert.deepEqual(effects, ['dr.dsh: local management']);
  process.env['DRDSH_REPORT_URL'] = 'http://127.0.0.1:8790';
  assert.throws(() => apply(ctx), /incomplete report credentials/);
  process.env['DRDSH_REPORT_TOKEN'] = 'x'.repeat(43);
  assert.throws(() => apply(ctx, { report: ['typo'] }), /unknown report event/);
  apply(ctx);
  assert.equal(effects.filter(label => label === 'dr.dsh: reporter').length, 1);
  process.env['DRDSH_REPORT_URL'] = 'https://example.com';
  assert.throws(() => apply(ctx), /loopback/);
});

test('managed hosts suppress profile relay startup even when notification reporting is disabled', t => {
  const keys = ['DRDSH_MANAGED_INSTANCE', 'DRDSH_REPORT_URL', 'DRDSH_REPORT_TOKEN'] as const;
  const previous = keys.map(key => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  for (const key of keys) delete process.env[key];
  const effects: string[] = [];
  const ctx = { ...harness().ctx, effect: (_callback: unknown, label?: string) => { effects.push(label ?? ''); } };
  assert.throws(() => apply(ctx, { relayUrl: 'private-invalid-profile-origin' }), /relayUrl/);
  process.env.DRDSH_MANAGED_INSTANCE = 'managed';
  assert.doesNotThrow(() => apply(ctx, { relayUrl: 'private-invalid-profile-origin' }));
  assert.deepEqual(effects, ['dr.dsh: local management']);
  delete process.env.DRDSH_MANAGED_INSTANCE;
  process.env.DRDSH_REPORT_URL = 'http://127.0.0.1:8790';
  process.env.DRDSH_REPORT_TOKEN = 'r'.repeat(43);
  assert.doesNotThrow(() => apply(ctx, { relayUrl: 'private-invalid-profile-origin' }));
  assert.equal(effects.filter(label => label === 'dr.dsh: reporter').length, 1);
});
