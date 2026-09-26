import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeHarness, type DshContextLike, type HarnessNotification } from './dsh-surface.ts';

function harness() {
  const listeners = new Map<string, (...args: readonly unknown[]) => unknown>();
  const prepended = new Set<string>();
  const ctx: DshContextLike = {
    effect: () => {},
    on(event, listener, options) {
      listeners.set(event, listener);
      if (options?.prepend) prepended.add(event);
      return () => { listeners.delete(event); };
    },
  };
  return { ctx, listeners, prepended };
}

test('approval and question observers preserve the original promise and private request', async () => {
  const { ctx, listeners, prepended } = harness();
  const reports: HarnessNotification[] = [];
  const stop = observeHarness(ctx, report => { reports.push(report); });
  const request = { agent: { session: { id: 'session-a' } }, reason: 'private reason', questions: ['private prompt'] };
  for (const event of ['approval/request', 'user-questions/request']) {
    assert.ok(prepended.has(event), 'observe before an existing answerer can claim the request');
    const answer = Promise.resolve({ answer: 'unchanged answer' });
    let calls = 0;
    const returned = listeners.get(event)?.(request, () => { calls += 1; return answer; });
    assert.equal(returned, answer);
    assert.equal(calls, 1);
    assert.deepEqual(await returned, { answer: 'unchanged answer' });
  }
  assert.deepEqual(reports, Array.from({ length: 2 }, () => ({ event: 'approval_requested', sessionRef: 'session-a' })));
  stop();
  stop();
  assert.equal(listeners.size, 0);
});

test('notification failures cannot claim or change approval and question failures', async () => {
  const { ctx, listeners } = harness();
  observeHarness(ctx, () => { throw new Error('notification sink is down'); });
  const failure = new Error('DSH answerer rejected');
  for (const event of ['approval/request', 'user-questions/request']) {
    const result = listeners.get(event)?.({}, () => Promise.reject(failure));
    await assert.rejects(result as Promise<unknown>, error => error === failure);
  }
});

test('goal operations and subagent outcomes retain only the owning session handle', () => {
  const { ctx, listeners } = harness();
  const reports: HarnessNotification[] = [];
  observeHarness(ctx, report => { reports.push(report); });
  const agent = { session: { get id() { return 'session-goal'; }, title: 'private title' } };
  for (const operation of ['create', 'edit', 'pause', 'resume', 'block', 'clear']) {
    listeners.get('goal/changed')?.({ agent, change: { operation, goal: { phase: 'complete' } } });
  }
  listeners.get('goal/changed')?.({ agent, change: { operation: 'complete', goal: { objective: 'private objective' } } });
  listeners.get('subagent/end')?.({ id: 'child-session', runId: 'run-a', lastAssistantMessage: [{ text: 'private output' }] });
  assert.deepEqual(reports, [
    { event: 'goal_complete', sessionRef: 'session-goal' },
    { event: 'subagent_complete', sessionRef: 'child-session' },
  ]);
});

test('unknown diagnostic payloads are ignored and questions without an agent have no invented id', () => {
  const { ctx, listeners } = harness();
  const reports: HarnessNotification[] = [];
  observeHarness(ctx, report => { reports.push(report); });
  for (const value of [undefined, null, [], 'private text', { status: 'completed' }]) {
    listeners.get('goal/changed')?.(value);
    listeners.get('subagent/end')?.(value);
    listeners.get('session/event')?.(value, { type: 'unknown/event' });
  }
  listeners.get('user-questions/request')?.({ id: 'question-id' }, () => 'answer');
  assert.deepEqual(reports, [{ event: 'approval_requested', sessionRef: null }]);
});

test('partially installed subscriptions are removed if Cordis refuses a later registration', () => {
  const { ctx, listeners } = harness();
  const on = ctx.on.bind(ctx);
  ctx.on = (event, listener, options) => {
    if (event === 'goal/changed') throw new Error('disposed Cordis context');
    return on(event, listener, options);
  };
  assert.throws(() => observeHarness(ctx, () => {}), /disposed Cordis context/);
  assert.equal(listeners.size, 0);
});
