/**
 * What "the client crashed" means, and the report that leaves the page when it happens.
 *
 * M3's completion standard is a crash rate — "under 0.5% on mobile" — and this project has no
 * telemetry: notifications and anything that reports home are off by default (ADR-0006), and a
 * client that phones home about its users would contradict the reason the project exists. So the
 * number can only come from runs **we** perform, and this module is the definition those runs share:
 *
 * * a **crash** is an uncaught error or an unhandled rejection in the client, or a page that never
 *   reached a usable state;
 * * counting happens in the page, in memory;
 * * the count is exposed for a test harness to read, under a name that says what it is.
 *
 * ## The one thing that does travel
 *
 * M5 asks for crash *reporting*, and the honest way to have it without a service is one hop: the
 * client sends a summary to **the daemon it is already paired with** — the machine of the person who
 * can act on it — which writes it to a `0600` file that `drdshd crashes` shows and deletes. Nothing
 * is uploaded, there is no endpoint to configure, and a report is only built when this page's own run
 * recorded a failure. [`crashReport`] is that summary, and the fields it can carry are deliberately
 * fewer than the fields it cannot: no room key, no device key, no pairing code, no message text, no
 * URLs from the session. `docs/security.md` § 5.10 states what is in one.
 *
 * The honest reading of a soak run is in `scripts/browser-soak-smoke.mjs`: zero crashes in N runs does
 * not prove a rate below 0.5%, it fails to *falsify* it, and the script says what N would be needed.
 *
 * @module @dr.dsh/pwa/health
 */

/** The name a harness reads the counters from. Deliberately ugly and namespaced: it is a diagnostic. */
export const HEALTH_GLOBAL = '__DR_DSH_HEALTH__';

/** What the page records about its own failures. */
export interface ClientHealth {
  /** Uncaught errors. */
  errors: number;
  /** Unhandled promise rejections. */
  rejections: number;
  /**
   * The most recent failure messages, capped so a loop cannot grow without bound.
   *
   * A mutable array on purpose: the counters are updated in place by the page's own listeners, and an
   * interface that says `readonly` while the implementation pushes is a build error waiting for the
   * first `tsc` — which is how this was found, after a rebuild left the client directory without its
   * shell and the browser smokes reported a 404 for `/client/shell.js`.
   */
  samples: string[];
  /** Whether the page reached a usable state at least once. */
  ready: boolean;
}

/** The cap on retained messages. The *counts* stay exact; only the text is capped. */
export const MAX_SAMPLES = 20;

/** A fresh, all-zero reading. */
export function emptyHealth(): ClientHealth {
  return { errors: 0, rejections: 0, samples: [], ready: false };
}

/**
 * Records one failure.
 *
 * The text is truncated and capped: an error message can carry a URL with a token in it, and a
 * diagnostic that leaks one is worse than no diagnostic. `docs/security.md` § 5.9 is where that rule
 * was written down after a token was found in a parse error.
 *
 * @param health - the reading to update.
 * @param message - what the error said.
 */
export function recordFailure(health: ClientHealth, message: string): void {
  const trimmed = message.replaceAll(/[\r\n\t]/gu, ' ').slice(0, 160);
  health.samples.push(trimmed);
  if (health.samples.length > MAX_SAMPLES) health.samples.shift();
}

/** The version this client reports. Kept here so a report and the build cannot disagree. */
export const CLIENT_VERSION = 'pwa 0.0.0';

/** Which phase the page was in, as the report names it. */
export type ClientPhase = 'loading' | 'pairing' | 'connecting' | 'ready' | 'offline' | 'stopped';

/** A crash report, exactly as `dr_dsh_proto::control::CrashReport` defines it. */
export interface CrashReportBody {
  /** Which client and version produced this. */
  readonly client: string;
  /** Where the page was when the failure happened. */
  readonly phase: ClientPhase;
  /** Whether this run ever reached the point where the interface works. */
  readonly reached_ready: boolean;
  /** Uncaught errors this run recorded. */
  readonly errors: number;
  /** Unhandled rejections this run recorded. */
  readonly rejections: number;
  /** Short descriptions of the failures, newest last. */
  readonly samples: readonly string[];
  /** The browser's user-agent string, truncated. */
  readonly user_agent: string;
  /** When the report was built, in Unix milliseconds. */
  readonly at_ms: number;
}

/** Longest user-agent string the report carries. The daemon enforces the same cap by refusing more. */
export const MAX_USER_AGENT = 200;

/**
 * Whether a run recorded anything worth reporting.
 *
 * A run that reached a usable state and saw no failure is not a crash, and sending a report for it
 * would turn a diagnostic into telemetry.
 *
 * @param health - the reading to test.
 */
export function hasSomethingToReport(health: ClientHealth): boolean {
  return health.errors > 0 || health.rejections > 0 || !health.ready;
}

/**
 * Builds the report for this run.
 *
 * Sanitizing happens here as well as in the daemon, and that is not redundancy for its own sake: the
 * daemon's copy of the rule protects the *file*, and this one protects the *tunnel and the log* — a
 * message with a newline in it is one line in a log until it is two. Every field is truncated to the
 * same caps the daemon enforces, so a legitimate report is never refused for being marginally long.
 *
 * @param health - what the page recorded.
 * @param phase - where the page was when the report was built.
 * @param options - the clock and the user agent, injected so this is testable without a browser.
 */
export function crashReport(
  health: ClientHealth,
  phase: ClientPhase,
  options: { readonly now?: number; readonly userAgent?: string } = {},
): CrashReportBody {
  const clean = (text: string, limit: number): string =>
    text.replaceAll(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit);
  return {
    client: CLIENT_VERSION,
    phase,
    reached_ready: health.ready,
    errors: health.errors,
    rejections: health.rejections,
    samples: health.samples.map(sample => clean(sample, 200)),
    user_agent: clean(options.userAgent ?? '', MAX_USER_AGENT),
    at_ms: options.now ?? Date.now(),
  };
}

/** Whether a run with this many healthy starts and this many crashes is consistent with a target rate. */
export interface RateReading {
  /** Starts observed. */
  readonly runs: number;
  /** Crashes observed. */
  readonly crashes: number;
  /** The observed rate, or `0` when nothing crashed. */
  readonly observed: number;
  /**
   * The upper bound of the 95% confidence interval for the true rate, by the rule of three.
   *
   * With zero crashes in `n` runs the one-sided 95% bound is `3/n`; that is the number that says
   * whether a run could have detected the target at all. Reporting "0% crashes" from 20 runs would be
   * a claim the sample cannot support, and this field is what stops that sentence from being written.
   */
  readonly upperBound95: number;
  /** Whether the sample is large enough to say anything about `target`. */
  readonly conclusive: boolean;
}

/**
 * Reads a soak run against a target rate.
 *
 * @param runs - how many starts were observed.
 * @param crashes - how many of them crashed.
 * @param target - the rate the standard names, `0.005` for "under 0.5%".
 */
export function rateReading(runs: number, crashes: number, target: number): RateReading {
  const observed = runs === 0 ? 0 : crashes / runs;
  const upperBound95 = runs === 0 ? 1 : 3 / runs;
  return {
    runs,
    crashes,
    observed,
    upperBound95,
    // Conclusive only when the bound is below the target: a run that could not have seen the
    // difference must not be quoted as evidence either way.
    conclusive: runs > 0 && upperBound95 <= target,
  };
}

/** Turns a reading into one sentence, with the sample size in it. */
export function describeRate(reading: RateReading, target: number): string {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  if (reading.runs === 0) return 'no runs observed';
  if (reading.crashes === 0) {
    return reading.conclusive
      ? `${reading.runs} runs, 0 crashes: under ${percent(target)} with 95% confidence`
      : `${reading.runs} runs, 0 crashes: the 95% bound is still ${percent(reading.upperBound95)}, ` +
          `so this sample cannot support a claim about ${percent(target)}`;
  }
  return `${reading.runs} runs, ${reading.crashes} crashes: ${percent(reading.observed)} observed`;
}
