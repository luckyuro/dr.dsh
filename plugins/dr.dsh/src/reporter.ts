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

import { observeHarness, sessionNotification, type DshContextLike } from './dsh-surface.ts';

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
   * Unknown sessions remain null; no handle is inferred from task content.
   */
  readonly sessionRef?: string | null;
}

/** Reporter configuration, as validated by the plugin entry point. */
export interface ReporterConfig {
  /** Loopback URL of the daemon's report endpoint. */
  readonly daemonUrl: string;
  /** Ephemeral credential inherited from the supervising daemon; never logged. */
  readonly daemonToken: string;
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
  private readonly inFlight = new Set<AbortController>();
  private stopped = false;
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
    const unsubscribe = observeHarness(ctx, notification => {
      const severity = notification.event === 'turn_complete' ? 'notice'
        : notification.event === 'subagent_complete' ? 'info' : 'alert';
      this.report({ ...notification, severity, atMs: Date.now() });
    });
    return () => {
      this.stopped = true;
      unsubscribe();
      for (const request of this.inFlight) request.abort();
    };
  }

  /** In-process counters for diagnostics; no daemon diagnostics endpoint yet. */
  public stats(): { delivered: number; dropped: number; lastError: string | null } {
    return { delivered: this.delivered, dropped: this.dropped, lastError: this.lastError };
  }

  private report(report: Report): void {
    if (this.stopped || !this.config.report.includes(report.event) || this.inFlight.size >= 8) {
      this.dropped += 1;
      return;
    }
    void this.post(report);
  }

  private async post(report: Report): Promise<void> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), 5_000);
    // Unknown upstream handles must not turn a notification into content egress.
    const sessionRef = typeof report.sessionRef === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(report.sessionRef)
      ? report.sessionRef : null;
    try {
      const response = await fetch(new URL('/report', this.config.daemonUrl), {
        method: 'POST',
        // Reports must stay on the configured loopback origin, including HTTPS.
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.daemonToken}` },
        body: JSON.stringify({ event: report.event, severity: report.severity, atMs: report.atMs, sessionRef }),
        signal: controller.signal,
      });
      // The response text is deliberately ignored; release undici's connection
      // without retaining arbitrary diagnostics or extending the request lifetime.
      await response.body?.cancel();
      if (!response.ok) {
        this.lastError = response.status === 503
          ? 'daemon has no authenticated client connection; pair and connect the remote page to receive new reports'
          : response.status === 429
            ? 'daemon report queue is full; this report was dropped, check the remote connection'
            : response.status === 401
              ? 'daemon rejected report credentials; restart DSH through its supervising daemon'
              : `daemon rejected report metadata (HTTP ${response.status}); check the plugin and daemon versions`;
        this.dropped += 1;
        return;
      }
      this.delivered += 1;
      this.lastError = null;
    } catch {
      // A stopped daemon is expected, not exceptional: the user is probably at
      // the machine. Record it and move on.
      this.lastError = 'local daemon report delivery failed or timed out; check that the supervising daemon is running';
      this.dropped += 1;
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }
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
  const notification = sessionNotification(args);
  return notification === undefined ? undefined
    : { ...notification, severity: 'notice', atMs: Date.now() };
}
