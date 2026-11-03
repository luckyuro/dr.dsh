/** Temporary real-DSH probe: a local trigger produces events without a model request. */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

export const name = 'dr.dsh-live-notification-probe';
export const inject = ['agents', 'goals'];

export function apply(ctx, config) {
  ctx.effect(() => {
    let running = false;
    const timer = setInterval(() => {
      if (running || !existsSync(config.trigger)) return;
      running = true;
      rmSync(config.trigger);
      void probe(ctx, config).then(
        () => writeFileSync(config.result, JSON.stringify({ ok: true })),
        () => writeFileSync(config.result, JSON.stringify({ ok: false })),
      ).finally(() => { running = false; });
    }, 200);
    return () => clearInterval(timer);
  });
}

async function probe(ctx, config) {
  const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: config.cwd } });
  const { agent } = handle;
  try {
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const goal = ctx.goals.create(agent, { objective: 'dr.dsh deployment notification check' });
    ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
    // Subagent completion is emitted on the real bus; no model or subagent provider is invoked.
    ctx.emit('subagent/end', {
      id: randomUUID(), runId: randomUUID(), provider: 'deployment-probe', local: true,
      stopReason: { kind: 'completed' }, lastAssistantMessage: [],
    });
  } finally {
    await handle.dispose();
  }
}
