import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setLocale } from './i18n.ts';
import {
  NOTIFICATION_LIMIT, NotificationFeed, notificationTitle, parseNotification,
  type Notification, type NotificationView,
} from './notifications.ts';

const BODY = { event: 'goal_complete', severity: 'alert', at_ms: 1234, session_ref: 'session_123-ABC' };
const NOTICE: Notification = { event: 'turn_complete', severity: 'notice', atMs: 1234, sessionRef: null };
afterEach(() => setLocale('en'));

test('notification parsing keeps only the protocol metadata and rejects unknown or unsafe values', () => {
  assert.deepEqual(parseNotification(BODY), {
    event: 'goal_complete', severity: 'alert', atMs: 1234, sessionRef: 'session_123-ABC',
  });
  assert.equal(parseNotification({ ...BODY, session_ref: null })?.sessionRef, null);
  assert.equal(parseNotification({ event: 'turn_complete', severity: 'notice', at_ms: 0 })?.sessionRef, null);
  for (const body of [
    null, [], 'event', {}, { ...BODY, event: 'agent_status' }, { ...BODY, event: '__proto__' },
    { ...BODY, severity: 'notice' }, { ...BODY, severity: 'loud' },
    { ...BODY, at_ms: -1 }, { ...BODY, at_ms: 1.5 }, { ...BODY, at_ms: NaN },
    { ...BODY, at_ms: Infinity }, { ...BODY, at_ms: Number.MAX_SAFE_INTEGER },
    { ...BODY, at_ms: '123' }, { ...BODY, session_ref: '' },
    { ...BODY, session_ref: '<img src=x onerror=alert(1)>' },
    { ...BODY, session_ref: 'x'.repeat(129) }, { ...BODY, session_ref: false },
    { ...BODY, title: 'private session text' }, { ...BODY, body: 'private output' },
  ]) assert.equal(parseNotification(body), null, JSON.stringify(body));
});

test('fixed notification titles follow the selected display language', () => {
  const notification = parseNotification(BODY);
  assert.ok(notification);
  assert.equal(notificationTitle(notification), 'Goal completed');
  setLocale('zh-CN');
  assert.equal(notificationTitle(notification), '目标已完成');
});

function fixture() {
  let view: NotificationView = { connected: false, entries: [], unread: 0, alert: null };
  const callbacks: ((notification: Notification) => void)[] = [];
  let stops = 0;
  const feed = new NotificationFeed(next => { view = next; });
  const source = {
    onNotification(handler: (notification: Notification) => void) {
      callbacks.push(handler);
      return () => { stops += 1; };
    },
  };
  return { feed, source, callbacks, view: () => view, stops: () => stops };
}

test('info only enters the activity list; notices badge, alerts interrupt, and read clears both', () => {
  const state = fixture();
  state.feed.connect(state.source);
  const push = state.callbacks[0]!;
  push({ ...NOTICE, event: 'subagent_complete', severity: 'info' });
  assert.equal(state.view().entries.length, 1);
  assert.equal(state.view().unread, 0);
  assert.equal(state.view().alert, null);
  push(NOTICE);
  assert.equal(state.view().unread, 1);
  assert.equal(state.view().alert, null);
  const alert = parseNotification(BODY)!;
  push(alert);
  assert.equal(state.view().unread, 2);
  assert.deepEqual(state.view().alert, alert);
  state.feed.markRead();
  assert.equal(state.view().unread, 0);
  assert.equal(state.view().alert, null);
  assert.equal(state.view().entries.length, 3);
  push(alert);
  assert.equal(state.view().unread, 1, 'a subsequent alert still requires attention');
});

test('the list and badge are bounded, including a flood during a long-lived connection', () => {
  const state = fixture();
  state.feed.connect(state.source);
  for (let i = 0; i < NOTIFICATION_LIMIT + 100; i += 1) state.callbacks[0]!({ ...NOTICE, atMs: i });
  assert.equal(state.view().entries.length, NOTIFICATION_LIMIT);
  assert.equal(state.view().unread, NOTIFICATION_LIMIT);
  assert.equal(state.view().entries[0]?.notification.atMs, NOTIFICATION_LIMIT + 99);
});

test('switching machines or reconnecting removes old entries and ignores already-queued callbacks', () => {
  const state = fixture();
  state.feed.connect(state.source);
  const old = state.callbacks[0]!;
  old(NOTICE);
  state.feed.connect(state.source);
  assert.equal(state.stops(), 1);
  assert.equal(state.view().entries.length, 0);
  old(NOTICE);
  assert.equal(state.view().entries.length, 0);
  const current = state.callbacks[1]!;
  current(NOTICE);
  assert.equal(state.view().entries.length, 1);
  state.feed.disconnect();
  assert.equal(state.stops(), 2);
  assert.equal(state.view().connected, false);
  assert.equal(state.view().entries.length, 0);
  current(NOTICE);
  assert.equal(state.view().entries.length, 0);
});
