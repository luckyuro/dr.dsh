/**
 * The DSH surface this project depends on — all of it, in one file.
 *
 * ## The rule
 *
 * No other module in this repository may import from `@deepseek-ai/*`. DSH is a
 * developer preview whose README says, in bold, that there *will* be
 * compatibility-breaking changes; when one lands, exactly one file should need
 * reading and exactly one test should fail. That file is this one.
 *
 * ## How the assumptions are recorded
 *
 * Every entry in {@link DSH_SURFACE} names the behaviour relied on and the DSH
 * release it was verified against. The runtime guard checks the Cordis methods;
 * event names and payloads require the real-harness upgrade smoke test. Cordis
 * accepts arbitrary event names, so a static name set cannot detect an upgrade.
 *
 * ## What is relied on (DSH 0.1.7-rc.2)
 *
 * | Assumption | Evidence in DSH |
 * | :--- | :--- |
 * | Plugins are `apply(ctx, config)` with optional `name`/`inject` | `docs/cordis-primer.md` |
 * | A bundle contributes one layer via `dsh.bundle.patch` | `docs/user/develop/basic/publish.md` § The bundle manifest |
 * | `ctx.effect(fn, label)` scopes a disposable to plugin lifetime | `packages/host/webserver/src/index.ts`, `packages/client/connection/src/index.ts` |
 * | `session/event(session, event)` carries every committed session event | `packages/core/session/src/index.ts` |
 * | Approval/question observers must return `next()`; session is `request.agent.session` | `packages/interaction/{user-approval,user-questions}/src/types.ts` |
 * | Goal completion is `payload.change.operation === 'complete'` | `packages/goal/goal/src/domain.ts` |
 * | `subagent/end` carries the child session id as `info.id` | `packages/subagent/subagent/src/index.ts` |
 *
 * @module
 */

/** DSH release this surface was verified against. */
export const VERIFIED_DSH_VERSION = '0.1.7-rc.2';
/** Exact upstream source revision reviewed for this integration. */
export const VERIFIED_DSH_REVISION = '477b4f420553e8a52c2fbccc464d7561b239c443';

/**
 * The minimal shape of the Cordis context this plugin uses.
 *
 * Declared structurally instead of importing `@deepseek-ai/cordis`'s type: the
 * bundle stays free of DSH type dependencies, so a type change upstream is a
 * one-file fix here rather than a compile error in every package. The cost is
 * that this interface can drift from the real one — which is why the runtime
 * guard below exists and why this file is the one to review on upgrade.
 */
export interface DshContextLike {
  /**
   * Scopes a disposable to the plugin's lifetime.
   *
   * @param factory - runs immediately; returns the disposer.
   * @param label - optional name used by DSH's diagnostics.
   * @returns nothing; Cordis owns the disposer.
   */
  effect(factory: () => () => void, label?: string): void;
  /**
   * Subscribes to a harness event.
   *
   * @param event - event name, from {@link DSH_SURFACE}.
   * @param listener - receives the producer's arguments positionally.
   * @returns a disposer that unsubscribes.
   */
  on(
    event: string,
    listener: (...args: readonly unknown[]) => unknown,
    options?: { readonly prepend?: boolean },
  ): () => void;
}

/** One upstream assumption checked by the upgrade smoke test. */
export interface SurfaceEntry {
  /** Harness event or service key that must exist. */
  readonly key: string;
  /** Why the project needs it. */
  readonly why: string;
  /** Whether losing this event blocks compatibility acceptance. */
  readonly required: boolean;
}

/**
 * Every harness event this plugin listens to.
 *
 * Required events block upgrade acceptance. Their existence is not discoverable
 * at runtime; the real event producers must be exercised when upgrading DSH.
 */
export const DSH_SURFACE: readonly SurfaceEntry[] = [
  {
    key: 'session/event',
    why: 'turn completion notifications without retaining message content',
    required: false,
  },
  {
    key: 'approval/request',
    why: 'the one notification users must not miss while away from the machine',
    required: true,
  },
  {
    key: 'user-questions/request',
    why: 'a question waiting for an answer is an interruption, like approval',
    required: true,
  },
  {
    key: 'subagent/end',
    why: 'subagent completion is a notification-worthy milestone',
    required: false,
  },
  {
    key: 'goal/changed',
    why: 'goal completion is the clearest "your task is done" signal',
    required: false,
  },
];

/**
 * Checks the methods used to mount this plugin. This cannot check whether DSH
 * emits our event names or payload shapes; see docs/integration/dsh-surface.md.
 *
 * @param ctx - the context to probe; must offer the methods this plugin calls.
 * @throws Error when the Cordis plugin methods are unavailable.
 */
export function assertSupportedSurface(ctx: DshContextLike): void {
  const problems: string[] = [];
  if (typeof ctx.effect !== 'function' || typeof ctx.on !== 'function') {
    problems.push('ctx.effect/ctx.on (the Cordis plugin contract itself)');
  }
  if (problems.length > 0) {
    throw new Error(
      `dr.dsh: this DSH build does not offer what dr.dsh requires: ${problems.join('; ')}. `
      + `This bundle was verified against DSH ${VERIFIED_DSH_VERSION}; `
      + 'check the plugin version against your harness version.',
    );
  }
}

/** Event names required for upgrade acceptance; see {@link DSH_SURFACE}. */
export const REQUIRED_EVENT_NAMES: readonly string[] = DSH_SURFACE
  .filter(entry => entry.required)
  .map(entry => entry.key);

/** Content-free events the rest of the plugin understands. */
export interface HarnessNotification {
  readonly event: 'approval_requested' | 'turn_complete' | 'goal_complete' | 'subagent_complete';
  readonly sessionRef: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sessionRef(value: unknown): string | null {
  const id = typeof value === 'string' ? value : record(value)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function agentSessionRef(value: unknown): string | null {
  return sessionRef(record(value)?.session);
}

/** Session observers receive a Session instance followed by its committed event. */
export function sessionNotification(args: readonly unknown[]): HarnessNotification | undefined {
  if (record(args[1])?.type !== 'turn/end') return undefined;
  return { event: 'turn_complete', sessionRef: sessionRef(args[0]) };
}

/**
 * Subscribe without claiming an approval/question or retaining harness payloads.
 * Prepending ensures existing answerers cannot short-circuit our observation.
 */
export function observeHarness(
  ctx: DshContextLike,
  notify: (notification: HarnessNotification) => void,
): () => void {
  const disposers: (() => void)[] = [];
  const dispose = (): void => { for (const stop of disposers.splice(0).reverse()) stop(); };
  const observed = (notification: HarnessNotification): void => {
    // A failing notification sink must not change DSH's task or approval outcome.
    try { notify(notification); } catch { /* Best-effort observer only. */ }
  };
  try {
    for (const event of ['approval/request', 'user-questions/request']) {
      disposers.push(ctx.on(event, (...args) => {
        observed({ event: 'approval_requested', sessionRef: agentSessionRef(record(args[0])?.agent) });
        const next = args.at(-1);
        return typeof next === 'function' ? next() : undefined;
      }, { prepend: true }));
    }
    disposers.push(ctx.on('session/event', (...args) => {
      const notification = sessionNotification(args);
      if (notification !== undefined) observed(notification);
    }));
    disposers.push(ctx.on('goal/changed', (value) => {
      const payload = record(value);
      if (record(payload?.change)?.operation !== 'complete') return;
      observed({ event: 'goal_complete', sessionRef: agentSessionRef(payload?.agent) });
    }));
    disposers.push(ctx.on('subagent/end', (value) => {
      const id = sessionRef(record(value));
      if (id === null) return;
      observed({ event: 'subagent_complete', sessionRef: id });
    }));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
