/**
 * The payload plane: control messages the relay never sees.
 *
 * These documents travel inside encrypted carrier payloads, so the relay links
 * neither this module nor the crypto that protects it. The shapes mirror
 * `crates/dr-dsh-proto/src/control.rs` field for field — that file is normative —
 * and that includes the **wire names**: `snake_case`, as the daemon writes them and as the
 * browser parses them. `apps/pwa/src/control.ts` renames them to camelCase for its own
 * callers, at that boundary and nowhere else.
 *
 * Note what is *absent*: no message carries session text, file paths, code, or
 * credentials. Content stays inside the DSH Web UI's own traffic, which rides
 * the tunnel as opaque bytes. Notifications reference a session by an opaque
 * local handle, never by its title.
 *
 * @module
 */

/** Envelope kind discriminator, carried as `kind` on the wire. */
export type ControlKind =
  | 'status_request'
  | 'status_response'
  | 'lifecycle_command'
  | 'lifecycle_result'
  | 'session_bootstrap_request'
  | 'session_bootstrap'
  | 'device_request'
  | 'device_list'
  | 'notification'
  | 'crash_report'
  | 'crash_report_result'
  | 'problem';

/**
 * Lifecycle operations a remote client may request.
 *
 * This union **is** the whitelist from the project definition § 9.6. There is no
 * field anywhere in this protocol for an argument a caller could use to pass a
 * flag to DSH: the daemon starts DSH from its own locked configuration, and it
 * has no code path that executes a peer-named command.
 */
export type LifecycleOp = 'start' | 'stop' | 'restart';

/** What the daemon is doing with the DSH process it owns. */
export type LifecycleState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed'
  /** DSH was started by hand: the daemon proxies it and refuses commands. */
  | 'attached';

/** The daemon's view of its own uplink, surfaced so failures are visible. */
export type RelayHealth = 'connected' | 'reconnecting' | 'rejected' | 'unreachable';

/** How loudly an event should surface; keeps notification noise out of alerts. */
export type Severity = 'info' | 'notice' | 'alert';

/** Notification-worthy events. */
export type NotificationEvent =
  | 'turn_complete'
  | 'approval_requested'
  | 'goal_complete'
  | 'subagent_complete'
  | 'lifecycle_changed'
  | 'connection_lost';

/** The daemon's answer to a status request; the single source of "is it up?". */
export interface Status {
  readonly state: LifecycleState;
  /** Loopback URL DSH is listening on, when it is listening. */
  readonly local_url: string | null;
  /** PID of the DSH process, when this daemon owns one. */
  readonly pid: number | null;
  /** Seconds the current run has been up, when running. */
  readonly uptime_secs: number | null;
  /** Whether this daemon owns the process; false in attach mode. */
  readonly owned: boolean;
  /** Human-readable reason for the last failure, if any. */
  readonly last_error: string | null;
  readonly relay: RelayHealth;
  /** Protocol version the daemon speaks, as `[major, minor]`. */
  readonly protocol: readonly [number, number];
}

/** A notification the daemon decided is worth interrupting someone for. */
export interface Notification {
  readonly event: NotificationEvent;
  readonly severity: Severity;
  /** When the daemon observed the event, in Unix milliseconds. */
  readonly at_ms: number;
  /** Opaque handle to the local session, when the event belongs to one. */
  readonly session_ref: string | null;
}

/** A lifecycle command from a paired device. */
export interface LifecycleCommand {
  readonly op: LifecycleOp;
  /** Milliseconds after which the daemon abandons the attempt. */
  readonly timeout_ms: number | null;
}

/** Outcome of a lifecycle command. */
export interface LifecycleResult {
  /**
   * Whether the daemon accepted the operation at all.
   *
   * Distinct from `ok`: `accepted: false` is a refusal that retrying cannot change, while
   * `accepted: true, ok: false` is an operation that ran and failed.
   */
  readonly accepted: boolean;
  readonly ok: boolean;
  /** State after the attempt, so the client never has to guess. */
  readonly state: LifecycleState;
  readonly error: string | null;
}

/**
 * How a client reaches the DSH Web UI through an established session.
 *
 * The daemon mints DSH's own browser token; the client never holds a DSH
 * credential. `authority` is the value the daemon used when redeeming it, and
 * the tunnel must keep presenting exactly that authority end to end — DSH's
 * cookie is bound to it (see `docs/architecture.md` § Why the authority is
 * preserved).
 */
export interface SessionBootstrap {
  /** Path, relative to the tunnel endpoint, that redeems the token. */
  readonly path: string;
  /** Authority to preserve for the lifetime of the session. */
  readonly authority: string;
  /** Unix milliseconds after which the bootstrap is useless. */
  readonly expires_at_ms: number;
}

/** One paired device, as shown in the management UI. */
export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  /** When pairing completed, in Unix milliseconds. */
  readonly paired_at_ms: number;
  readonly last_seen_ms: number | null;
  /** Whether this device may issue lifecycle commands. */
  readonly may_control: boolean;
}

/**
 * A failure the client's own run recorded, sent to the daemon it is paired with.
 *
 * Reporting is one hop and has no server: the daemon writes this beside its own state (0600) and
 * `drdshd crashes` shows it. There is no field for a room key, a device key, a pairing code or a
 * message body, and there is no endpoint to point it somewhere else — see `docs/security.md` § 5.10
 * for what a report contains and what it deliberately cannot.
 */
export interface CrashReport {
  /** Which client and version produced this, e.g. `pwa 0.0.0`. */
  readonly client: string;
  /** Where the client was when the failure happened. */
  readonly phase: string;
  /** Whether this run ever reached the point where the interface works. */
  readonly reached_ready: boolean;
  /** Uncaught errors this run recorded. */
  readonly errors: number;
  /** Unhandled promise rejections this run recorded. */
  readonly rejections: number;
  /** Short descriptions of the failures, newest last. */
  readonly samples: readonly string[];
  /** The browser's user-agent string, truncated by the sender. */
  readonly user_agent: string;
  /** When the client built the report, in Unix milliseconds. */
  readonly at_ms: number;
}

/** The daemon's answer to a {@link CrashReport}. */
export interface CrashReportResult {
  /** Whether the daemon kept the report. */
  readonly accepted: boolean;
  /** How many reports it holds now. */
  readonly stored: number;
  /** Why it refused, when `accepted` is false. */
  readonly error: string | null;
}
