import { t, type MessageKey } from './i18n.ts';

/** Mirrors the existing control protocol; the relay never reads these encrypted fields. */
export type NotificationEvent = 'turn_complete' | 'approval_requested' | 'goal_complete' |
  'subagent_complete' | 'lifecycle_changed' | 'connection_lost';
export type Severity = 'info' | 'notice' | 'alert';

/** Metadata only: no session text is carried by this channel. */
export interface Notification {
  readonly event: NotificationEvent;
  readonly severity: Severity;
  readonly atMs: number;
  readonly sessionRef: string | null;
}

const SEVERITIES = {
  turn_complete: 'notice',
  approval_requested: 'alert',
  goal_complete: 'alert',
  subagent_complete: 'info',
  lifecycle_changed: 'notice',
  connection_lost: 'alert',
} as const satisfies Record<NotificationEvent, Severity>;

/** Reject malformed or content-bearing messages before notifying any UI subscriber. */
export function parseNotification(body: unknown): Notification | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['event', 'severity', 'at_ms', 'session_ref'].includes(key))) return null;
  const event = value['event'];
  if (typeof event !== 'string' || !Object.hasOwn(SEVERITIES, event)) return null;
  const typedEvent = event as NotificationEvent;
  if (value['severity'] !== SEVERITIES[typedEvent]) return null;
  const atMs = value['at_ms'];
  // Intl.DateTimeFormat must also be able to display a safe integer timestamp.
  if (typeof atMs !== 'number' || !Number.isSafeInteger(atMs) || atMs < 0 || atMs > 8_640_000_000_000_000) return null;
  const sessionRef = value['session_ref'] ?? null;
  if (sessionRef !== null && (typeof sessionRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionRef))) return null;
  return Object.freeze({ event: typedEvent, severity: SEVERITIES[typedEvent], atMs, sessionRef });
}

/** The fixed title is translated locally; the peer cannot supply display text or a URL. */
export function notificationTitle(notification: Notification): string {
  return t(`notification.event.${notification.event}` satisfies MessageKey);
}

export const NOTIFICATION_LIMIT = 50;

export interface NotificationSource {
  onNotification(handler: (notification: Notification) => void): () => void;
}

export interface NotificationEntry {
  readonly notification: Notification;
  readonly unread: boolean;
}

export interface NotificationView {
  readonly connected: boolean;
  readonly entries: readonly NotificationEntry[];
  readonly unread: number;
  readonly alert: Notification | null;
}

/** One connection's in-memory list. A new connection never inherits another machine's events. */
export class NotificationFeed {
  private entries: NotificationEntry[] = [];
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private connected = false;
  private readonly render: (view: NotificationView) => void;

  public constructor(render: (view: NotificationView) => void) {
    this.render = render;
  }

  public connect(source: NotificationSource): void {
    this.disconnect();
    this.connected = true;
    const generation = this.generation;
    this.unsubscribe = source.onNotification(notification => {
      // An already-queued callback can outlive unsubscribe when switching machines.
      if (generation !== this.generation) return;
      this.entries = [{ notification, unread: notification.severity !== 'info' }, ...this.entries]
        .slice(0, NOTIFICATION_LIMIT);
      this.draw();
    });
    this.draw();
  }

  public disconnect(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connected = false;
    this.entries = [];
    this.draw();
  }

  public markRead(): void {
    this.entries = this.entries.map(entry => ({ ...entry, unread: false }));
    this.draw();
  }

  public draw(): void {
    this.render({
      connected: this.connected,
      entries: this.entries,
      unread: this.entries.filter(entry => entry.unread).length,
      alert: this.entries.find(entry => entry.unread && entry.notification.severity === 'alert')?.notification ?? null,
    });
  }
}
