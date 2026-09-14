/**
 * Plugin invariants: the loopback refusal, the surface guard, and the
 * notification taxonomy.
 *
 * These tests are the contract with DSH's event surface. When a harness upgrade
 * breaks them, this is the file that says so — see `docs/development.md` §
 * Upgrading against a new DSH.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertLoopback } from './index.ts';
import { DSH_SURFACE, REQUIRED_EVENT_NAMES, assertSupportedSurface } from './dsh-surface.ts';
import { classifySessionEvent } from './reporter.ts';

test('a loopback daemon URL is accepted in every spelling', () => {
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:8790'));
  assert.doesNotThrow(() => assertLoopback('http://localhost:8790'));
  assert.doesNotThrow(() => assertLoopback('http://[::1]:8790'));
  assert.doesNotThrow(() => assertLoopback('http://127.5.5.5:8790'));
});

test('a non-loopback daemon URL is refused, not warned about', () => {
  assert.throws(() => assertLoopback('http://192.168.1.10:8790'), /loopback/);
  assert.throws(() => assertLoopback('https://relay.example/report'), /loopback/);
  assert.throws(() => assertLoopback('not-a-url'), /not a URL/);
});

test('the surface guard accepts a context that offers the plugin contract', () => {
  const ctx = {
    effect: () => {},
    on: () => () => {},
  };
  assert.doesNotThrow(() => assertSupportedSurface(ctx));
});

test('the surface guard refuses a context missing the plugin contract', () => {
  // A harness that stopped offering ctx.on is exactly the upgrade this guard is
  // for: without it, a plugin would mount and silently never report anything.
  const ctx = { effect: () => {} } as unknown as Parameters<typeof assertSupportedSurface>[0];
  assert.throws(() => assertSupportedSurface(ctx), /Cordis plugin contract/);
});

test('the events users cannot miss are required; the chatty ones are not', () => {
  assert.deepEqual([...REQUIRED_EVENT_NAMES].sort(), ['approval/request', 'user-questions/request']);
  const optional = DSH_SURFACE.filter(entry => !entry.required).map(entry => entry.key);
  assert.ok(optional.includes('agent/status'), 'agent/status is too chatty to be required');
});

test('turn/end becomes a badge-level turn completion', () => {
  const report = classifySessionEvent(['session-1', { type: 'turn/end', reason: 'completed' }]);
  assert.deepEqual(report, {
    event: 'turn_complete',
    severity: 'notice',
    atMs: report?.atMs,
    sessionRef: 'session-1',
  });
});

test('unrecognised session payloads are ignored rather than thrown on', () => {
  assert.equal(classifySessionEvent(['session-1', { type: 'assistant/message' }]), undefined);
  assert.equal(classifySessionEvent(['session-1', undefined]), undefined);
  assert.equal(classifySessionEvent([]), undefined);
});

test('a session handle is opaque: an object without an id becomes null', () => {
  const report = classifySessionEvent([{ title: 'refactor the parser' }, { type: 'turn/end' }]);
  assert.equal(report?.sessionRef, null);
});
