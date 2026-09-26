/** Loaded only by dsh-upgrade-smoke into an isolated, real DSH web profile. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export const name = 'dr.dsh-upgrade-probe';
export const inject = ['agents', 'sessions', 'goals', 'approval', 'userQuestions'];

export function apply(ctx, config) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void probe(ctx, config).then(
        result => writeFileSync(config.result, JSON.stringify(result)),
        error => writeFileSync(config.result, JSON.stringify({ error: error.message })),
      );
    }, 300);
    return () => clearTimeout(timer);
  });
}

async function probe(ctx, config) {
  const step = value => writeFileSync(`${config.result}.stage`, value);
  step('creating session');
  const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: config.cwd } });
  const { agent } = handle;
  let approvalCalls = 0, questionCalls = 0;
  const answer = { answers: [{ id: 'question', selected: ['yes'] }] };
  const stopApproval = ctx.on('approval/request', () => { approvalCalls += 1; return Promise.resolve('allowed-once'); });
  const stopQuestion = ctx.on('user-questions/request', () => { questionCalls += 1; return Promise.resolve(answer); });
  try {
    agent.session.append('turn/start', { turn: 1 });
    step('approval');
    const approval = await ctx.approval.request({ agent, toolName: 'upgrade-test', reason: 'private approval sentinel' });
    assert.equal(approval, 'allowed-once', 'the observer must not claim DSH approval');
    step('question');
    const question = await ctx.userQuestions.ask({
      agent, questions: [{ id: 'question', question: 'private question sentinel', options: [{ label: 'yes' }] }],
    });
    assert.deepEqual(question, answer, 'the observer must preserve DSH question answers');
    step('session and goal');
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const goal = ctx.goals.create(agent, { objective: 'private goal sentinel' });
    ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
    assert.equal(ctx.goals.get(agent).phase, 'complete');
    // The subagent payload is exercised through the real event bus without
    // making a model request or composing an unrelated subagent provider.
    ctx.emit('subagent/end', {
      id: 'upgrade-child-session', runId: 'upgrade-child-run', provider: 'upgrade-fixture', local: true,
      stopReason: { kind: 'completed' }, lastAssistantMessage: [{ type: 'text', text: 'private output sentinel' }],
    });
    return { sessionId: agent.session.id, approvalCalls, questionCalls };
  } finally {
    stopApproval(); stopQuestion();
    await handle.dispose();
  }
}
