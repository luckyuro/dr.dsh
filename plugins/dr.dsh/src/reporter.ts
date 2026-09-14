/**
 * Turns harness events into daemon reports.
 *
 * ## The mapping is the product decision
 *
 * Not every event deserves to interrupt someone. The taxonomy from the project
 * definition (§ 9.5, § 12) is enforced here rather than in the UI:
 *
 * | Harness event | Report | Severity | Why |
 * | :--- | :--- | :--- | :--- |
 * | `approval/request` | `approval_requested` | `alert` | Work is blocked until a human answers |
 * | `user-questions/request` | `approval_requested` | `alert` | Same blocking shape, different producer |
 * | `session/event` → `turn/end` | `turn_complete` | `notice` | The common case; badge, no sound |
 * | `goal/changed` → complete | `goal_complete` | `alert` | The user's stated objective finished |
 * | `subagent/end` | `subagent_complete` | `info` | Activity, not an outcome |
 * | `agent/status` | *(none)* | — | Too chatty to report; drives local UI state only |
 *
 * ## Content minimization
 *
 * A report carries an event name, a severity, a timestamp, and an **opaque**
 * session handle. It never carries message text, tool arguments, file paths, or
 * model output: those travel only inside the encrypted tunnel as DSH's own
 * traffic, where the relay cannot see them either. A notification payload is the
 * one thing that could leak through a push provider, so it is designed to be
 * worthless to an eavesdropper (§ 9.5).
 *
 * @module
 */

import type { DshContextLike } from './dsh-surface.ts';

/** Severity mirrors the wire protocol's `severity` values. */
export type Severity = 'info' | 'notice' | 'alert';

/** The report kinds the daemon understands. */
export type ReportEvent =
  | 'turn_complete'
  | 'approval_requested'
  | 'goal_complete'
  | 'subagent_complete'
  | 'lifecycle_changed'
  | 'connection_lost';

/** One report, exactly as it goes on the wire to the daemon. */
export interface Report {
  /** What happened. */
  readonly event: ReportEvent;
  /** How loudly it should surface. */
  readonly severity: Severity;
  /** When the harness event was observed, in Unix milliseconds. */
  readonly atMs: number;
  /**
   * Opaque handle to the local session; never a title, path, or prompt.
   *
   * Optional rather than nullable so a caller that genuinely has no session
   * cannot invent one, and so the field is absent on the wire instead of null.
   */
  readonly sessionRef?: string | null;
}

/** Reporter configuration, as validated by the plugin entry point. */
export interface ReporterConfig {
  /** Loopback URL of the daemon's report endpoint. */
  readonly daemonUrl: string;
  /** Which reports to emit; anything not listed is dropped before sending. */
  readonly report: readonly string[];
}

/**
 * Watches harness events and POSTs reports to the daemon.
 *
 * Delivery is best-effort and must never block the harness: a daemon that is
 * not running is the normal case when the user is sitting at the machine, and a
 * notification must never be the reason a turn is slow. Failures are counted and
 * surfaced through `stats()` instead of thrown.
 */
export class Reporter {
  private delivered = 0;
  private dropped = 0;
  private lastError: string | null = null;
  /**
   * Explicit field plus assignment rather than a constructor parameter
   * property: parameter properties emit runtime code, which bare type-stripping
   * loaders (node's test runner, and any future no-build path) reject. The same
   * rule is why `packages/protocol` uses a frozen object instead of an enum.
   */
  private readonly config: ReporterConfig;

  public constructor(config: ReporterConfig) {
    this.config = config;
  }

  /**
   * Subscribes to the configured events.
   *
   * @param ctx - harness context to subscribe on.
   * @returns a disposer that unsubscribes from every subscription.
   */
  public start(ctx: DshContextLike): () => void {
    const disposers: (() => void)[] = [];
    const listen = (event: string, listener: (...args: readonly unknown[]) => void): void => {
      disposers.push(ctx.on(event, listener));
    };

    listen('approval/request', (...args) => {
      this.report({ event: 'approval_requested', severity: 'alert', ...this.stamp() }, args);
    });
    listen('user-questions/request', (...args) => {
      this.report({ event: 'approval_requested', severity: 'alert', ...this.stamp() }, args);
    });
    listen('session/event', (...args) => {
      const report = classifySessionEvent(args);
      if (report !== undefined) this.report(report, args);
    });
    listen('goal/changed', (...args) => {
      if (looksComplete(args)) {
        this.report({ event: 'goal_complete', severity: 'alert', ...this.stamp() }, args);
      }
    });
    listen('subagent/end', (...args) => {
      this.report({ event: 'subagent_complete', severity: 'info', ...this.stamp() }, args);
    });

    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  /** Counters for diagnostics; the daemon exposes them through `drdshd doctor`. */
  public stats(): { delivered: number; dropped: number; lastError: string | null } {
    return { delivered: this.delivered, dropped: this.dropped, lastError: this.lastError };
  }

  private stamp(): { atMs: number } {
    return { atMs: Date.now() };
  }

  /**
   * Queues one report.
   *
   * `sessionRef` is derived from the harness's session argument only when it is
   * a plain string or an object with a string `id`; anything else becomes
   * `null` rather than a stringified object, because a stringified session would
   * leak far more than an identifier.
   */
  private report(report: Report, args: readonly unknown[]): void {
    if (!this.config.report.includes(report.event)) {
      this.dropped += 1;
      return;
    }
    const payload: Report = { ...report, sessionRef: sessionRefOf(args) };
    void this.post(payload);
  }

  private async post(report: Report): Promise<void> {
    try {
      const response = await fetch(new URL('/report', this.config.daemonUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (!response.ok) {
        this.lastError = `daemon answered ${response.status}`;
        this.dropped += 1;
        return;
      }
      this.delivered += 1;
    } catch (error) {
      // A stopped daemon is expected, not exceptional: the user is probably at
      // the machine. Record it and move on.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.dropped += 1;
    }
  }
}

/** How a harness session argument becomes an opaque handle. */
function sessionRefOf(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null) {
    const id = (first as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Maps a `session/event` payload to a report, or `undefined` when the event is
 * not notification-worthy.
 *
 * Every field is narrowed rather than asserted: DSH owns this payload shape and
 * may change it between preview releases, and the correct behaviour for an
 * unrecognised payload is to report nothing rather than to throw inside an
 * event handler.
 */
export function classifySessionEvent(args: readonly unknown[]): Report | undefined {
  const event = args[1];
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  if (type !== 'turn/end') return undefined;
  return { event: 'turn_complete', severity: 'notice', atMs: Date.now(), sessionRef: sessionRefOf(args) };
}

/** Whether a `goal/changed` payload reports completion, narrowing defensively. */
function looksComplete(args: readonly unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const status = (arg as { status?: unknown }).status;
    if (status === 'complete' || status === 'completed') return true;
  }
  return false;
}
