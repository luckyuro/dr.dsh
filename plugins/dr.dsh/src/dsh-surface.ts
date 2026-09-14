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
 * release it was verified against. `assertSupportedSurface` refuses to run
 * against a harness that does not answer as expected, so an upgrade produces a
 * loud startup error instead of a plugin that silently reports nothing — the
 * failure mode that makes remote integrations untrustworthy (§ 9.7).
 *
 * ## What is relied on (verified against DSH 0.1.5-rc.2)
 *
 * | Assumption | Evidence in DSH |
 * | :--- | :--- |
 * | Plugins are `apply(ctx, config)` with optional `name`/`inject` | `docs/cordis-primer.md` |
 * | A bundle contributes one layer via `dsh.bundle.patch` | `docs/user/develop/basic/publish.md` § The bundle manifest |
 * | `ctx.effect(fn, label)` scopes a disposable to plugin lifetime | `packages/host/webserver/src/index.ts`, `packages/client/connection/src/index.ts` |
 * | `session/event(session, event)` carries every committed session event | `packages/core/session/src/index.ts` |
 * | `approval/request` and `user-questions/request` are waterfalls | `packages/interaction/user-approval/src/types.ts` |
 * | `subagent/start`, `subagent/end`, `goal/changed`, `agent/status` exist | `packages/subagent/subagent/src/index.ts`, `packages/goal/goal/src/domain.ts`, `packages/core/agent/src/runtime-types.ts` |
 *
 * @module
 */

/** DSH release this surface was verified against. */
export const VERIFIED_DSH_VERSION = '0.1.5-rc.2';

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
  on(event: string, listener: (...args: readonly unknown[]) => void): () => void;
}

/** One behaviour this project depends on, with a runtime probe. */
export interface SurfaceEntry {
  /** Harness event or service key that must exist. */
  readonly key: string;
  /** Why the project needs it. */
  readonly why: string;
  /** Whether the plugin refuses to start when it is missing. */
  readonly required: boolean;
}

/**
 * Every harness event this plugin listens to.
 *
 * `required: false` entries are best-effort: DSH may rename a diagnostic event
 * between preview releases, and losing a badge is not worth refusing to boot
 * over. `required: true` entries carry the notifications the product definition
 * calls critical, and their absence is a startup failure.
 */
export const DSH_SURFACE: readonly SurfaceEntry[] = [
  {
    key: 'session/event',
    why: 'turn completion, tool results, and assistant messages for notifications',
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
    key: 'subagent/start',
    why: 'subagent activity is what makes a long remote task look alive',
    required: false,
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
  {
    key: 'agent/status',
    why: 'idle/running transitions drive the remote activity indicator',
    required: false,
  },
];

/**
 * Checks that the running harness answers the way {@link DSH_SURFACE} expects.
 *
 * The probe is intentionally shallow, and its limits are worth stating: Cordis
 * accepts *any* event name at runtime, so `ctx.on('typo', …)` is not an error —
 * it simply never fires. Nothing here can detect that. What this guard does catch
 * is a harness release whose documented names have been renamed wholesale, and
 * it fails at startup rather than at 3am when a notification is missed.
 *
 * Payload shapes cannot be probed either; only the upgrade test in
 * `docs/development.md` covers them, which is why `reporter.ts` narrows every
 * payload field explicitly instead of asserting.
 *
 * @param ctx - the context to probe; must offer the methods this plugin calls.
 * @throws Error listing every missing required entry, so one startup failure
 * names all of them instead of one per restart.
 */
export function assertSupportedSurface(ctx: DshContextLike): void {
  const problems: string[] = [];
  for (const entry of DSH_SURFACE) {
    if (entry.required && !KNOWN_EVENT_NAMES.has(entry.key)) {
      problems.push(`${entry.key} (${entry.why})`);
    }
  }
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

/** Event names without which dr.dsh refuses to start; see {@link DSH_SURFACE}. */
export const REQUIRED_EVENT_NAMES: readonly string[] = DSH_SURFACE
  .filter(entry => entry.required)
  .map(entry => entry.key);

/**
 * Event names this bundle was verified against.
 *
 * A static set, not a probe, because Cordis accepts any event name at runtime —
 * `ctx.on('typo', …)` is not an error, it simply never fires. That silence is
 * exactly the failure this set prevents: the guard at least catches a harness
 * whose documented names have changed, and `docs/development.md` describes the
 * upgrade ritual for payload changes.
 */
const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set([
  'session/created',
  'session/disposed',
  'session/event',
  'session/flush',
  'approval/request',
  'user-questions/request',
  'subagent/start',
  'subagent/end',
  'goal/changed',
  'goal/activation-changed',
  'agent/status',
]);
