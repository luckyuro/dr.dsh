/**
 * The control plane: asking the daemon what is happening, and asking it to act.
 *
 * Everything here travels on the control stream inside the tunnel, so the relay sees ciphertext
 * and the daemon is the only thing that answers. That is why a lifecycle command is a *typed
 * request* rather than a shell string: the wire has no field for an argument, so there is
 * nowhere for a flag to come from (project definition § 9.6).
 *
 * ## Why the client validates the operations it sends
 *
 * The daemon validates them too, and that is the boundary that matters. Checking here as well
 * is not defence in depth for its own sake: a client that can only *express* the three
 * operations cannot be talked into sending a fourth by a compromised page or a stale cached
 * worker, and a bug that produced one fails loudly rather than silently becoming a new
 * capability.
 *
 * ## Failure transparency
 *
 * The daemon reports its own state including its view of the relay, and the tunnel reports
 * whether *this connection* is alive. Those are different facts and the client keeps them
 * apart, because "your computer cannot reach the relay" and "we cannot reach your computer"
 * need different words in front of a person — one is their network, the other is the tunnel
 * they are looking at.
 *
 * @module control
 */

import { t } from './i18n.ts';

import type { CrashReportBody } from './health.ts';
import { CONTROL_STREAM, Tunnel, TunnelError } from './tunnel.ts';

/** What the daemon is doing with the DSH process it owns. */
export type LifecycleState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed'
  | 'attached';

/** How the daemon currently reaches the relay. */
export type RelayHealth = 'connected' | 'reconnecting' | 'rejected' | 'unreachable';

/** The daemon's answer to a status request. */
export interface Status {
  readonly state: LifecycleState;
  readonly localUrl: string | null;
  readonly pid: number | null;
  readonly uptimeSecs: number | null;
  /** Whether this daemon owns the DSH process. False in attach mode. */
  readonly owned: boolean;
  /** Why the last start or the supervision loop failed, when it did. */
  readonly lastError: string | null;
  readonly relay: RelayHealth;
  readonly protocol: readonly [number, number];
}

/** The outcome of a lifecycle command. */
export interface LifecycleOutcome {
  /** Whether the operation achieved its goal. */
  readonly ok: boolean;
  /** State after the attempt, so the caller never guesses what to show. */
  readonly state: LifecycleState;
  /** Why it failed, when it did. */
  readonly error: string | null;
  /**
   * Whether the daemon accepted the request.
   *
   * Distinct from `ok`: a refusal (attach mode, a bad operation) is `accepted: false` and is
   * final, while `accepted: true` with `ok: false` means the daemon tried and DSH did not come
   * up. A UI that showed the same thing for both would tell a user to retry something that can
   * never work.
   */
  readonly accepted: boolean;
}

/** The lifecycle operations a client may ask for. This list *is* the whitelist. */
export const LIFECYCLE_OPERATIONS = ['start', 'stop', 'restart'] as const;
export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];

/** Why a control exchange failed, in terms a caller can branch on. */
export class ControlError extends TunnelError {
  public readonly reason: ControlReason;

  public constructor(reason: ControlReason, message: string) {
    super(message);
    this.name = 'ControlError';
    this.reason = reason;
  }
}

/** What went wrong with a control exchange. */
export type ControlReason =
  /** The request never got an answer before the deadline. */
  | 'timeout'
  /** The daemon answered with a problem instead of the expected reply. */
  | 'refused'
  /** The reply was not the shape this protocol defines. */
  | 'malformed'
  /** The tunnel died while the request was in flight. */
  | 'disconnected';

/**
 * How long a lifecycle command may take before the caller is told it failed.
 *
 * Generous, because a command *is* a process operation: stopping DSH waits for its plugin tree
 * to dispose, and starting it waits for the readiness line. A tight timeout would report failure
 * for operations that are working, which is the one thing failure transparency must not do.
 */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * How long a status request may take.
 *
 * Short, because a status request is answered inline from state the daemon already holds — it
 * cannot legitimately take seconds. It is also the request that *detects* a dead daemon: with the
 * command budget it took thirty seconds for a user staring at the panel to be told the daemon was
 * gone, which is indistinguishable from a hang. Measured, not guessed: the first failure smoke
 * against a killed daemon reported the truth after exactly 30s.
 */
const STATUS_TIMEOUT_MS = 5_000;

/**
 * How long a crash report may take.
 *
 * Short like the status budget and for the same reason: the daemon appends one line to a local file
 * and answers. A report that hangs must not keep a failing page alive, so a client that gets no
 * answer gives up and stays quiet — a crash reporter that breaks the page is worse than none.
 */
const REPORT_TIMEOUT_MS = 5_000;

/**
 * Reads and acts on the daemon's control plane over an established tunnel.
 *
 * One instance per tunnel: the correlation ids are its own, and two instances sharing a stream
 * would each see the other's replies.
 */
export class ControlClient {
  private readonly tunnel: Tunnel;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly unsubscribe: () => void;

  public constructor(tunnel: Tunnel) {
    this.tunnel = tunnel;
    this.unsubscribe = tunnel.on(CONTROL_STREAM, payload => this.absorb(payload));
  }

  /** Stops listening. The tunnel itself is left alone: the caller owns it. */
  public close(): void {
    this.unsubscribe();
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new ControlError('disconnected', 'the request was abandoned'));
    }
    this.pending.clear();
  }

  /**
   * Asks the daemon what it is doing.
   *
   * @returns the daemon's state, including its own view of the relay.
   * @throws ControlError when the daemon does not answer usefully.
   */
  public async status(): Promise<Status> {
    const body = await this.exchange(
      'status_request',
      undefined,
      'status_response',
      STATUS_TIMEOUT_MS,
    );
    return parseStatus(body);
  }

  /**
   * Asks the daemon to start, stop, or restart DSH.
   *
   * @param op - the operation, from the fixed whitelist.
   * @returns what the daemon reports afterwards, including refusals.
   * @throws ControlError when the daemon does not answer at all.
   */
  public async command(op: LifecycleOperation): Promise<LifecycleOutcome> {
    if (!LIFECYCLE_OPERATIONS.includes(op)) {
      // Not reachable from typed code; reachable from a page that built the string at runtime,
      // and refusing here keeps the wire surface identical to the typed one.
      throw new ControlError('refused', `${op} is not a lifecycle operation this client may send`);
    }
    const body = await this.exchange(
      'lifecycle_command',
      { op },
      'lifecycle_result',
      COMMAND_TIMEOUT_MS,
    );
    return parseOutcome(body);
  }

  /**
   * Sends a crash report for this run.
   *
   * One hop, no service: the daemon writes it beside its own state and `drdshd crashes` shows it
   * (`docs/security.md` § 5.10). The caller decides whether there is anything to report —
   * `hasSomethingToReport` — because a report for a healthy run is telemetry.
   *
   * @param report - the body `crashReport` built.
   * @returns whether the daemon kept it, and how many it holds.
   * @throws ControlError when the daemon does not answer at all.
   */
  public async reportCrash(report: CrashReportBody): Promise<CrashReportOutcome> {
    const body = await this.exchange(
      'crash_report',
      { ...report },
      'crash_report_result',
      REPORT_TIMEOUT_MS,
    );
    return {
      accepted: body['accepted'] === true,
      stored: typeof body['stored'] === 'number' ? body['stored'] : 0,
      error: typeof body['error'] === 'string' ? body['error'] : null,
    };
  }

  /** Sends one request and waits for its reply. */
  private async exchange(
    kind: string,
    body: Record<string, unknown> | undefined,
    expect: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ControlError(
            'timeout',
            `the daemon did not answer the ${kind} within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    const request: Record<string, unknown> = { kind, id };
    if (body !== undefined) request['body'] = body;
    try {
      await this.tunnel.send(CONTROL_STREAM, new TextEncoder().encode(JSON.stringify(request)));
    } catch (error) {
      const waiting = this.pending.get(id);
      if (waiting !== undefined) {
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        waiting.reject(
          new ControlError(
            'disconnected',
            `the tunnel closed before the ${kind} could be sent: ${(error as Error).message}`,
          ),
        );
      }
    }

    const reply = await answer;
    const replyKind = reply['kind'];
    if (replyKind === 'problem') {
      const message = (reply['body'] as { message?: unknown } | undefined)?.message;
      throw new ControlError(
        'refused',
        typeof message === 'string' ? message : 'the daemon refused the request',
      );
    }
    if (replyKind !== expect) {
      throw new ControlError(
        'malformed',
        `the daemon answered ${String(replyKind)} where ${expect} was expected`,
      );
    }
    const body_ = reply['body'];
    if (body_ === null || typeof body_ !== 'object') {
      throw new ControlError('malformed', `${expect} arrived without a body`);
    }
    return body_ as Record<string, unknown>;
  }

  /** Routes one inbound control payload to whoever is waiting for it. */
  private absorb(payload: Uint8Array<ArrayBuffer>): void {
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      // A payload on the control stream that is not JSON is not this client's business: the
      // handshake owns the stream before the tunnel reports itself established, and a stray
      // frame is not an answer to anything.
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== 'number') return;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.resolve(message as Record<string, unknown>);
  }
}

/** Turns a status body into the shape callers use, or fails loudly. */
function parseStatus(body: Record<string, unknown>): Status {
  const state = body['state'];
  if (!isLifecycleState(state)) {
    throw new ControlError('malformed', `the daemon reported an unknown state: ${String(state)}`);
  }
  const relay = body['relay'];
  if (!isRelayHealth(relay)) {
    throw new ControlError('malformed', `the daemon reported an unknown relay health: ${String(relay)}`);
  }
  const protocol = body['protocol'];
  const pair: [number, number] =
    Array.isArray(protocol) && protocol.length === 2 && typeof protocol[0] === 'number' && typeof protocol[1] === 'number'
      ? [protocol[0], protocol[1]]
      : [0, 0];
  return {
    state,
    localUrl: typeof body['local_url'] === 'string' ? body['local_url'] : null,
    pid: typeof body['pid'] === 'number' ? body['pid'] : null,
    uptimeSecs: typeof body['uptime_secs'] === 'number' ? body['uptime_secs'] : null,
    owned: body['owned'] === true,
    lastError: typeof body['last_error'] === 'string' ? body['last_error'] : null,
    relay,
    protocol: pair,
  };
}

/** What the daemon did with a crash report. */
export interface CrashReportOutcome {
  /** Whether it kept the report. */
  readonly accepted: boolean;
  /** How many reports it holds now. */
  readonly stored: number;
  /** Why it refused, when `accepted` is false. */
  readonly error: string | null;
}

/** Turns a lifecycle result body into the shape callers use, or fails loudly. */
function parseOutcome(body: Record<string, unknown>): LifecycleOutcome {
  const state = body['state'];
  if (!isLifecycleState(state)) {
    throw new ControlError('malformed', `the daemon reported an unknown state: ${String(state)}`);
  }
  return {
    ok: body['ok'] === true,
    state,
    error: typeof body['error'] === 'string' ? body['error'] : null,
    // Absent means the daemon performed the operation rather than refusing it, which is what
    // an older daemon that predates the field would mean.
    accepted: body['accepted'] !== false,
  };
}

function isLifecycleState(value: unknown): value is LifecycleState {
  return (
    value === 'stopped' ||
    value === 'starting' ||
    value === 'running' ||
    value === 'stopping' ||
    value === 'failed' ||
    value === 'attached'
  );
}

function isRelayHealth(value: unknown): value is RelayHealth {
  return (
    value === 'connected' ||
    value === 'reconnecting' ||
    value === 'rejected' ||
    value === 'unreachable'
  );
}

/**
 * The sentence to show a person for a state.
 *
 * Kept here rather than in a component so the same words reach the page, the offline banner and
 * a future notification, and so a test can pin them. "Recovering" is deliberately specific
 * about what is happening: a daemon that is restarting DSH is not the same as one that is
 * broken, and the difference is the whole point of showing this at all.
 *
 * @param status - the daemon's last status.
 */
export function describe(status: Status): string {
  switch (status.state) {
    case 'running':
      return status.relay === 'connected'
        ? t('dsh.running')
        : t('dsh.runningRelay', { state: describeRelay(status.relay) });
    case 'starting':
      return t('dsh.starting');
    case 'stopping':
      return t('dsh.stopping');
    case 'stopped':
      return t('dsh.stopped');
    case 'attached':
      return t('dsh.attached');
    case 'failed':
      return status.lastError === null
        ? t('dsh.failed')
        : t('dsh.failedReason', { reason: status.lastError });
    default:
      return t('dsh.unknown');
  }
}

/** The sentence for a relay state, for when that is the thing that is wrong. */
export function describeRelay(health: RelayHealth): string {
  switch (health) {
    case 'connected':
      return t('relay.connected');
    case 'reconnecting':
      return t('relay.reconnecting');
    case 'rejected':
      return t('relay.rejected');
    case 'unreachable':
      return t('relay.unreachable');
    default:
      return t('relay.unknown');
  }
}
