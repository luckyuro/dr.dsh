/**
 * The status panel: what is happening, and the three buttons that change it.
 *
 * ## Why the decisions live apart from the DOM
 *
 * Everything a person sees here is a *decision* — which buttons are enabled, what sentence to
 * show, whether "retry" is honest advice. Those decisions are what this module exposes as
 * {@link panelView}, a pure function of the facts. The DOM half ({@link ControlPanel}) only
 * writes what the view says. A panel whose logic lives in event handlers can only be tested by
 * driving a browser, which means in practice it is not tested, and the failures that matter
 * here — a button that is enabled when it cannot work, or a state described as something it is
 * not — are exactly the kind that survive.
 *
 * ## The three failures a user must be able to tell apart
 *
 * Project definition § 9.7 requires distinct messages for a relay that is unreachable, a daemon
 * that is gone, and a device whose access was revoked. They are different problems with
 * different fixes, and they arrive through different channels:
 *
 * | What happened | How the client learns it | What it says |
 * | :--- | :--- | :--- |
 * | The daemon cannot reach the relay | its own `status.relay` | "your computer cannot reach the relay" |
 * | The daemon or the tunnel is gone | this client's control requests stop being answered | "we cannot reach your computer" |
 * | This device is not (or no longer) paired | the handshake's `resume_reject` | "this device is not paired" |
 *
 * The middle case is why a status read is never assumed to have succeeded: a panel that showed
 * the last known state after the connection died would tell a user everything is fine while
 * nothing is.
 *
 * @module @dsh-shared/pwa/panel
 */

import { t, displayText, errorText, type DisplayText } from './i18n.ts';

import { ControlClient, ControlError, describe, describeRelay } from './control.ts';
import type { ControlReason, LifecycleOperation, LifecycleState, Status } from './control.ts';

/** The facts a panel renders, gathered from everything that knows something. */
export interface PanelState {
  /** Whether the tunnel is open and the daemon has accepted this client. */
  readonly connected: boolean;
  /**
   * Whether the carrier socket itself has closed.
   *
   * The distinction between this and a request that timed out is the difference between two
   * failures with different fixes. A closed socket means *this* connection died — most often the
   * relay, or the network between here and it — while an open socket that stops answering means
   * the daemon is gone. A panel that reported one sentence for both would send half its users to
   * check the wrong end.
   */
  readonly socketClosed: boolean;
  /** Why the tunnel is not open, when it is not. */
  readonly tunnelError: DisplayText | null;
  /** The daemon's last reported status, if one has ever arrived. */
  readonly status: Status | null;
  /** The failure of the most recent control exchange, if any. */
  readonly lastFailure: { readonly reason: ControlReason; readonly message: DisplayText } | null;
  /** Whether a control request is in flight. */
  readonly busy: boolean;
}

/** What the panel should show. */
export interface PanelView {
  /** The headline sentence. */
  readonly headline: string;
  /** A second line with detail, or null when the headline says enough. */
  readonly detail: string | null;
  /** How it should look. */
  readonly tone: 'ok' | 'busy' | 'warn' | 'error';
  /** The buttons, already decided. */
  readonly actions: readonly PanelAction[];
  /** Whether a "connect" affordance should be offered. */
  readonly needsConnection: boolean;
}

/** One button. */
export interface PanelAction {
  readonly op: LifecycleOperation;
  readonly label: string;
  /** Disabled when the operation cannot work, which is not the same as when it is busy. */
  readonly enabled: boolean;
  /** Why it is disabled, shown next to it: a greyed-out button with no reason reads as a bug. */
  readonly reason: string | null;
}

/** How the panel reaches the daemon. Injected so the panel is not tied to one tunnel. */
export interface PanelHost {
  /** The control client for the live tunnel, or null when there is none. */
  control(): ControlClient | null;
  /** Renders a view. */
  render(view: PanelView): void;
  /** Schedules a periodic refresh; returns a function that stops it. */
  schedule(task: () => void, everyMs: number): () => void;
}

/** How often the panel re-reads the daemon's state while it is open. */
const POLL_INTERVAL_MS = 3_000;

/**
 * Builds the view for a set of facts.
 *
 * Uses the current display language. The checks follow the questions a user actually has: "am I even connected", then "is my computer
 * reachable", then "is DSH running".
 *
 * @param state - the facts.
 * @returns what to render.
 */
export function panelView(state: PanelState): PanelView {
  if (!state.connected) {
    return {
      headline: t('panel.disconnected'),
      detail: state.tunnelError === null ? t('panel.connectHint') : displayText(state.tunnelError),
      tone: 'error',
      actions: disabledActions(t('panel.noConnection')),
      needsConnection: true,
    };
  }

  // The carrier closed while this page was open: the connection between here and the relay is
  // what broke, and the daemon may be perfectly healthy on the other side of it.
  if (state.socketClosed) {
    return {
      headline: t('panel.dropped'),
      detail: t('panel.droppedHint'),
      tone: 'error',
      actions: disabledActions(t('panel.noConnection')),
      needsConnection: true,
    };
  }

  if (state.lastFailure !== null) {
    // The socket is open but nothing is answering on it, which means the daemon is gone: the
    // relay would have closed the connection if it were the one that failed.
    return {
      headline: t('panel.silent'),
      detail:
        state.lastFailure.reason === 'timeout'
          ? t('panel.silentHint')
          : displayText(state.lastFailure.message),
      tone: 'error',
      actions: disabledActions(t('panel.noAnswer')),
      needsConnection: false,
    };
  }

  if (state.status === null) {
    return {
      headline: t('state.connecting'),
      detail: t('panel.asking'),
      tone: 'busy',
      actions: disabledActions(t('panel.waiting')),
      needsConnection: false,
    };
  }

  const status = state.status;
  const relayTrouble = status.relay !== 'connected';
  return {
    // The headline is DSH's state; the relay is a detail, because a DSH that is running is what
    // the user came for, and a relay problem does not stop a local session.
    headline: describe(status),
    detail: relayTrouble
      ? t('panel.relay', { state: describeRelay(status.relay) })
      : status.state === 'running' && status.pid !== null
        ? t('panel.process', { pid: status.pid })
        : null,
    tone: status.state === 'failed' ? 'error' : relayTrouble ? 'warn' : actionTone(status.state),
    actions: actionsFor(status, state.busy),
    needsConnection: false,
  };
}

/** The tone for a state that is not a failure. */
function actionTone(state: LifecycleState): PanelView['tone'] {
  if (state === 'running') return 'ok';
  if (state === 'starting' || state === 'stopping') return 'busy';
  return 'warn';
}

/** Buttons for a daemon that has reported its status. */
function actionsFor(status: Status, busy: boolean): PanelAction[] {
  const busyReason = busy ? t('action.busy') : null;
  // An attached DSH is the one case where a button must be disabled for a *reason the user
  // needs to read*: the daemon refuses these operations, and a button that looked available
  // would produce an error where an explanation belongs (criterion 5).
  const attachReason =
    status.state === 'attached'
      ? t('dsh.attached')
      : null;
  const allowed = attachReason === null;
  const enabled = (op: LifecycleOperation): boolean => {
    if (!allowed || busy) return false;
    if (op === 'start') return status.state !== 'running' && status.state !== 'starting';
    if (op === 'stop') return status.state === 'running' || status.state === 'starting';
    return true;
  };
  const reasonFor = (op: LifecycleOperation): string | null => {
    if (attachReason !== null) return attachReason;
    if (busyReason !== null) return busyReason;
    if (op === 'start' && status.state === 'running') return t('action.alreadyRunning');
    if (op === 'stop' && status.state !== 'running' && status.state !== 'starting') {
      return t('action.notRunning');
    }
    return null;
  };
  return (['start', 'stop', 'restart'] as const).map(op => ({
    op,
    label: t(`action.${op}`),
    enabled: enabled(op),
    reason: reasonFor(op),
  }));
}

/** Every action disabled, with one reason. */
function disabledActions(reason: string): PanelAction[] {
  return (['start', 'stop', 'restart'] as const).map(op => ({
    op,
    label: t(`action.${op}`),
    enabled: false,
    reason,
  }));
}

/**
 * Drives a panel against a live tunnel.
 *
 * Owns no DOM and no timers of its own: both come from the host, so a test can run the whole
 * thing without a browser and a page can supply the real ones.
 */
export class ControlPanel {
  private readonly host: PanelHost;
  private state: PanelState;
  private stopPolling: (() => void) | null = null;

  public constructor(host: PanelHost, initial: Partial<PanelState> = {}) {
    this.host = host;
    this.state = {
      connected: initial.connected ?? false,
      socketClosed: initial.socketClosed ?? false,
      tunnelError: initial.tunnelError ?? null,
      status: initial.status ?? null,
      lastFailure: initial.lastFailure ?? null,
      busy: initial.busy ?? false,
    };
  }

  /** Renders the current state. */
  public draw(): void {
    this.host.render(panelView(this.state));
  }

  /** Records that the tunnel is open, and starts polling the daemon. */
  public connected(): void {
    this.state = {
      ...this.state,
      connected: true,
      socketClosed: false,
      tunnelError: null,
      lastFailure: null,
    };
    this.draw();
    this.stopPolling?.();
    this.stopPolling = this.host.schedule(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
    void this.refresh();
  }

  /**
   * Records that the carrier socket closed.
   *
   * Separate from [`ControlPanel.disconnected`], which is about the *session* never starting:
   * this one is about a session that was working and then lost its link.
   */
  public socketDropped(reason: string): void {
    this.stopPolling?.();
    this.stopPolling = null;
    this.state = {
      ...this.state,
      socketClosed: true,
      tunnelError: reason,
      busy: false,
      status: null,
    };
    this.draw();
  }

  /** Records that the tunnel failed. */
  public disconnected(reason: DisplayText): void {
    this.stopPolling?.();
    this.stopPolling = null;
    this.state = {
      ...this.state,
      connected: false,
      tunnelError: reason,
      busy: false,
      // The last status is dropped rather than kept: showing "DSH is running" from a stale
      // reading is precisely the lie the panel exists to avoid.
      status: null,
    };
    this.draw();
  }

  /** Asks the daemon for its state. */
  public async refresh(): Promise<void> {
    const control = this.host.control();
    if (control === null) return;
    try {
      const status = await control.status();
      this.state = { ...this.state, status, lastFailure: null };
      this.draw();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Runs a lifecycle operation and reports what happened.
   *
   * @param op - the operation, from the fixed whitelist.
   */
  public async run(op: LifecycleOperation): Promise<void> {
    const control = this.host.control();
    if (control === null) return;
    this.state = { ...this.state, busy: true };
    this.draw();
    try {
      const outcome = await control.command(op);
      // The daemon answers with the state *after* the operation, so it is used directly rather
      // than followed by another round trip. A refusal carries a reason that belongs in the
      // failure slot: it is not a transient fault, and showing it as one would invite a retry
      // that cannot work.
      this.state = {
        ...this.state,
        busy: false,
        status:
          this.state.status === null ? null : { ...this.state.status, state: outcome.state },
        lastFailure:
          outcome.accepted === false && outcome.error !== null
            ? { reason: 'refused', message: outcome.error }
            : null,
      };
      this.draw();
      if (outcome.accepted === false) return;
      await this.refresh();
    } catch (error) {
      this.state = { ...this.state, busy: false };
      this.fail(error);
    }
  }

  /** Stops polling, for a page that is going away. */
  public stop(): void {
    this.stopPolling?.();
    this.stopPolling = null;
  }

  /** Records a control failure and redraws. */
  private fail(error: unknown): void {
    if (error instanceof ControlError) {
      this.state = { ...this.state, lastFailure: { reason: error.reason, message: () => errorText(error) } };
    } else {
      this.state = {
        ...this.state,
        lastFailure: { reason: 'disconnected', message: () => errorText(error) },
      };
    }
    this.draw();
  }
}
