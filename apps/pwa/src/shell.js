/**
 * The shell's own behaviour: connect, then render the panel.
 *
 * A **served module rather than an inline script**, and that is a security decision rather
 * than a matter of taste. The relay serves the shell with `default-src 'none'`, which is the
 * right policy for a page that handles a key — but it also blocks inline scripts, so the
 * first version of this page did nothing at all in a real browser while every test passed.
 * Keeping the policy strict and moving the code out is the fix that does not weaken anything.
 *
 * Plain JavaScript, and not part of the TypeScript build: the client directory is what the
 * relay serves, module by module, and this file is small enough that a build step would add
 * more surface than it removes.
 */

import { t, getLocale, setLocale, readLocale, saveLocale, displayText, errorText, LocalizedError } from './i18n.js';
import { offlineNotice } from './offline.js';
import { interfacePort, serveInterfacePort } from './interface-bridge.js';
import { NotificationFeed, notificationTitle } from './notifications.js';
import { installFloatingControl } from './floating-control.js';

const state = document.getElementById('state');
const connect = document.getElementById('connect');
const forget = document.getElementById('forget');
const key = document.getElementById('key');
const pairingHint = document.getElementById('pairing-hint');
const connectionHint = document.getElementById('connection-hint');
const deviceLine = document.getElementById('device');
const roomsSection = document.getElementById('rooms');
const roomList = document.getElementById('room-list');
const panel = document.getElementById('panel');
const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const actions = document.getElementById('actions');
const openButton = document.getElementById('open');
const connectionManager = document.getElementById('connection-manager');
const harnessView = document.getElementById('harness-view');
const harnessFrame = document.getElementById('harness-frame');
const returnToConnection = document.getElementById('return-to-connection');
const connectionDialog = document.getElementById('connection-dialog');
const dialogContent = document.getElementById('connection-dialog-content');
const closeControls = document.getElementById('close-controls');
const floatingControl = installFloatingControl(returnToConnection);
const reloadHarness = document.getElementById('reload-harness');
const disconnect = document.getElementById('disconnect');
const languageButton = document.getElementById('language');
const notificationsSection = document.getElementById('notifications');
const notificationBadge = document.getElementById('notification-badge');
const notificationAlert = document.getElementById('notification-alert');
const notificationList = document.getElementById('notification-list');
const notificationEmpty = document.getElementById('notification-empty');
const notificationRead = document.getElementById('notification-read');
const notificationFeed = new NotificationFeed(renderNotifications);

function renderNotifications(view) {
  notificationsSection.hidden = !view.connected;
  notificationBadge.hidden = view.unread === 0;
  notificationBadge.textContent = view.unread === 0 ? '' : t('notification.unread', { count: view.unread });
  notificationRead.disabled = view.unread === 0;
  notificationEmpty.hidden = view.entries.length !== 0;
  const alert = view.alert === null ? '' : notificationTitle(view.alert);
  if (notificationAlert.textContent !== alert) notificationAlert.textContent = alert;
  notificationAlert.hidden = view.alert === null;
  notificationList.replaceChildren(...view.entries.map(({ notification }) => {
    const item = document.createElement('li');
    item.dataset.severity = notification.severity;
    const title = document.createElement('span');
    title.textContent = notificationTitle(notification);
    const metadata = document.createElement('small');
    const time = document.createElement('time');
    time.dateTime = new Date(notification.atMs).toISOString();
    time.textContent = new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'medium' }).format(notification.atMs);
    metadata.append(document.createTextNode(`${t(`notification.severity.${notification.severity}`)} · `), time);
    item.append(title, metadata);
    return item;
  }));
}

notificationRead.addEventListener('click', () => notificationFeed.markRead());

setLocale(readLocale(() => localStorage, navigator.languages?.length ? navigator.languages : [navigator.language]));
let stateMessage = '';
let activePanel = null;

/** Only catalog text can introduce code markup; interpolated device labels always stay plain text. */
function renderStaticText(element, message) {
  element.replaceChildren(...message.split(/(`[^`]+`)/u).map(part => {
    if (!part.startsWith('`')) return document.createTextNode(part);
    const code = document.createElement('code');
    code.textContent = part.slice(1, -1);
    return code;
  }));
}

function renderLanguage() {
  document.documentElement.lang = getLocale();
  harnessFrame.title = t('page.frameTitle');
  returnToConnection.setAttribute('aria-label', t('page.returnToConnection'));
  returnToConnection.title = t('page.controlInstructions');
  closeControls.setAttribute('aria-label', t('page.closeControls'));
  for (const element of document.querySelectorAll('[data-i18n]')) {
    renderStaticText(element, t(element.dataset.i18n));
  }
  const chinese = getLocale() === 'zh-CN';
  languageButton.textContent = chinese ? 'English' : '中文';
  languageButton.lang = chinese ? 'en' : 'zh-CN';
  languageButton.setAttribute('aria-label', t('language.switch'));
  for (const component of ['daemon', 'relay']) {
    document.querySelector(`[data-i18n="page.${component}Guide"]`).href =
      `https://github.com/luckyuro/dr.dsh/blob/master/${component}/README${chinese ? '.zh' : ''}.md`;
  }
  renderDevice();
  state.textContent = displayText(stateMessage);
  if (!panel.hidden) activePanel?.draw();
  notificationFeed.draw();
}

languageButton.addEventListener('click', () => {
  saveLocale(() => localStorage, getLocale() === 'en' ? 'zh-CN' : 'en');
  renderLanguage();
});

function show(phase, message) {
  state.dataset.phase = phase;
  stateMessage = message;
  state.textContent = displayText(message);
  // Remembered for crash reports: "where was the page when it broke" is the first question a report
  // has to answer, and by the time it is built the visible text has moved on.
  currentPhase = phase;
}

/** The phase the page is in, as `health.ClientPhase` names the ones a report can carry. */
let currentPhase = 'loading';

/**
 * What to call a room in this browser's list.
 *
 * The browser's own name is not enough on its own: every room paired from this browser would be called
 * "Chrome on Linux", which is exactly the list a person cannot read (found by the two-room smoke, whose
 * two rows were indistinguishable). The room id's first characters make each row unique, and they are
 * what the user would otherwise have to compare by hand.
 */
function roomLabel(room) {
  return `${browserLabel()} · ${room.slice(0, 4)}`;
}

/**
 * A short label for `drdsh daemon devices`.
 *
 * The daemon stores it so an operator can tell two enrolled devices apart; a browser that sends
 * its whole user-agent string makes that list unreadable, and one that sends nothing makes it
 * useless.
 */
function browserLabel() {
  const agent = navigator.userAgent;
  const name = /Firefox\/|Edg\/|Chrome\/|Safari\//.exec(agent)?.[0]?.replace('/', '') ?? 'browser';
  const platform = /Android|iPhone|iPad|Mac OS X|Windows|Linux/.exec(agent)?.[0] ?? 'unknown';
  return `${name} on ${platform}`;
}

/** Everything the page needs from the client, loaded once. */
let client = null;
async function loadClient() {
  if (client === null) {
    const [session, panelModule, controlModule, pairing, identity, storage, credential, healthModule] =
      await Promise.all([
        import('/client/session.js'),
        import('/client/panel.js'),
        import('/client/control.js'),
        import('/client/pair.js'),
        import('/client/identity.js'),
        import('/client/storage.js'),
        import('/client/credential.js'),
        // Loaded here with the rest so a report can be built without a second round of fetching on
        // a page that is already failing.
        import('/client/health.js'),
      ]).catch(error => {
        throw new LocalizedError(() => t('error.load', { reason: errorText(error) }));
      });
    client = {
      session,
      panelModule,
      controlModule,
      pairing,
      identity,
      storage,
      credential,
      health: healthModule,
    };
  }
  return client;
}

/** Where this browser's pairings are kept between visits. */
let store = null;
/** This browser's device identity, or null when it has never paired (ADR-0007: one per browser). */
let device = null;
/** The machines this browser is paired with, most recently used first. */
let rooms = [];
/** The room the page is currently pointed at, or null. */
let selectedRoom = null;

/**
 * Renders what this browser is paired with: the identity, and one row per machine.
 *
 * ADR-0007 made these two facts separate, and the list is where that becomes visible: before it,
 * pairing with a second computer silently replaced the first one's key, and the page had no way to
 * show that anything had been lost.
 */
function renderDevice() {
  if (device === null || rooms.length === 0) {
    deviceLine.hidden = true;
    deviceLine.textContent = '';
    roomsSection.hidden = true;
    roomList.replaceChildren();
    forget.hidden = true;
    pairingHint.hidden = false;
    key.placeholder = 'XXXX-XXXX-XX';
    renderStaticText(connectionHint, t('page.connectionHint'));
    return;
  }
  deviceLine.hidden = false;
  deviceLine.textContent =
    rooms.length === 1
      ? t('device.one', { id: device.deviceId, label: rooms[0].label })
      : t('device.many', { id: device.deviceId, count: rooms.length });
  roomsSection.hidden = false;
  forget.hidden = false;
  pairingHint.hidden = true;
  key.placeholder = t('page.reconnectPlaceholder');
  renderStaticText(connectionHint, t('page.reconnectHint'));
  renderRooms();
}

/** Renders one row per room: a label, when it was last used, and whether it is the selected one. */
function renderRooms() {
  roomList.replaceChildren();
  for (const room of rooms) {
    const row = document.createElement('li');
    row.style.display = 'flex';
    row.style.gap = '.5rem';
    row.style.alignItems = 'baseline';
    row.style.padding = '.25rem 0';

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = room.room === selectedRoom?.room ? `• ${room.label}` : room.label;
    choose.disabled = room.room === selectedRoom?.room;
    choose.addEventListener('click', () => {
      clearConnection();
      selectedRoom = room;
      renderRooms();
      show('idle', () => t('room.selected', { label: room.label }));
    });

    const when = document.createElement('span');
    when.style.fontSize = '.85rem';
    when.style.opacity = '.75';
    const seen = room.lastConnectedAtMs ?? room.pairedAtMs;
    when.textContent =
      room.lastConnectedAtMs === null
        ? t('room.never')
        : t('room.lastUsed', { date: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(seen) });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = t('room.forget');
    drop.addEventListener('click', () => void forgetRoom(room));

    row.append(choose, when, drop);
    roomList.append(row);
  }
}

/** Forgets one room. The identity stays: the other rooms still need it. */
async function forgetRoom(room) {
  try {
    const deviceId = device?.deviceId ?? '<id>';
    await store?.forget(room.room);
    if (selectedRoom?.room === room.room) clearConnection();
    rooms = rooms.filter(candidate => candidate.room !== room.room);
    if (selectedRoom?.room === room.room) selectedRoom = rooms[0] ?? null;
    renderDevice();
    show('idle', () => t('room.forgot', { label: room.label, id: deviceId }));
  } catch (error) {
    show('failed', () => t('error.forget', { reason: errorText(error) }));
  }
}

/**
 * Counts this page's own failures, in memory, where a harness can read them.
 *
 * No telemetry: the counters exist so a soak run can measure a crash rate at all, and they are never
 * sent anywhere. The module that defines what a crash is (`health.js`) is loaded lazily, because a
 * failure *while loading it* should still be counted — so the two listeners below are installed
 * directly and update a plain object that the module later adopts.
 */
const health = { errors: 0, rejections: 0, samples: [], ready: false };
window[/* keep the name in one place */ '__DR_DSH_HEALTH__'] = health;
window.addEventListener('error', event => {
  health.errors += 1;
  if (health.samples.length < 20) health.samples.push(String(event.message ?? 'error').slice(0, 160));
});
window.addEventListener('unhandledrejection', event => {
  health.rejections += 1;
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (health.samples.length < 20) health.samples.push(reason.slice(0, 160));
});

/** Whether this page has already sent its report. */
let failuresReported = false;

/**
 * The control client for the current tunnel, or `null` before one exists.
 *
 * Module scope rather than inside the connect handler: the crash reporter reads it after the
 * connection attempt has an outcome, and that is a different call stack from the one that created it.
 */
let control = null;
let activeTunnel = null;
let interfaceBridge = null;
let activeViewId = null;
let interfaceUrl = null;
let interfaceAvailable = false;
let preferManager = false;
let hasEnteredHarness = false;

function dismissConnectionManager() {
  preferManager = false;
  if (connectionDialog.open) connectionDialog.close();
  returnToConnection.setAttribute('aria-expanded', 'false');
}

function showConnectionManager(byUser = false) {
  if (byUser) preferManager = true;
  connectionManager.hidden = false;
  if (hasEnteredHarness) {
    // The same form and listeners move into the dialog; the iframe stays mounted and connected.
    if (connectionManager.parentElement !== dialogContent) dialogContent.append(connectionManager);
    returnToConnection.hidden = false;
    returnToConnection.setAttribute('aria-expanded', 'true');
    if (!connectionDialog.open) {
      connectionDialog.showModal();
      closeControls.focus({ preventScroll: true });
      connectionDialog.scrollTop = 0;
    }
  } else {
    harnessView.hidden = true;
    document.body.classList.remove('embedded');
  }
}

function showHarness() {
  if (!interfaceAvailable || interfaceUrl === null || activeTunnel === null) return;
  hasEnteredHarness = true;
  if (connectionManager.parentElement !== dialogContent) dialogContent.append(connectionManager);
  connectionManager.hidden = false;
  dismissConnectionManager();
  if (harnessFrame.getAttribute('src') !== interfaceUrl) harnessFrame.src = interfaceUrl;
  harnessView.hidden = false;
  returnToConnection.hidden = false;
  document.body.classList.add('embedded');
  floatingControl.refresh();
}

window.addEventListener('message', event => {
  if (activeTunnel === null || activeViewId === null) return;
  const port = interfacePort(event, location.origin, harnessFrame.contentWindow, activeViewId);
  if (port === undefined) return;
  interfaceBridge?.close();
  interfaceBridge = serveInterfacePort(activeTunnel, port);
  interfaceBridge.workerReady();
});
let stopTunnelClosed = null;
let connectionRevision = 0;
let notificationsSuspended = false;

/** Retire the previous machine before replacing the selected room or opening another tunnel. */
function clearConnection() {
  connectionRevision += 1;
  preferManager = false;
  activePanel?.stop();
  activePanel = null;
  closeTransport();
  panel.hidden = true;
}

/** A confirmed disconnect or an explicit replacement retires the old tunnel's resources together. */
function closeTransport() {
  stopTunnelClosed?.();
  stopTunnelClosed = null;
  // Destroy the old document before closing its transport: assigning src alone
  // navigates asynchronously and lets its pending requests report spurious failures.
  harnessFrame.remove();
  harnessFrame.src = 'about:blank';
  harnessView.append(harnessFrame);
  control?.close();
  control = null;
  notificationFeed.disconnect();
  notificationsSuspended = false;
  interfaceBridge?.close();
  interfaceBridge = null;
  activeViewId = null;
  interfaceUrl = null;
  interfaceAvailable = false;
  openButton.hidden = true;
  reloadHarness.disabled = true;
  disconnect.disabled = true;
  showConnectionManager();
  activeTunnel?.close();
  activeTunnel = null;
}

/**
 * Sends this run's failures to the daemon, once, once the connection attempt has an outcome.
 *
 * One hop and no service: the report goes to the machine this page is paired with, which writes it
 * somewhere `drdsh daemon crashes` can show it (`docs/security.md` § 5.10). Nothing is uploaded, and a run
 * that reached a usable state without a failure sends nothing at all — reporting a healthy run would
 * be telemetry, which is the thing this design exists to avoid.
 *
 * Deliberately quiet and deliberately last: a page whose own failure is being reported must not be
 * kept alive, or broken, by the diagnostic. A refusal or a timeout is logged to the console and
 * otherwise dropped — the person who can act on it will look at the daemon's side.
 */
async function reportOwnFailures() {
  // Once per page load, not once per carrier: a page that reconnects five times has one run's worth
  // of failures, and the daemon's store is capped at twenty reports for exactly this reason.
  if (failuresReported) return;
  // No tunnel, no report: a page that fails before it ever connects has nowhere to send this, which
  // is a limitation of having no service rather than a bug (`docs/security.md` § 5.10).
  if (control === null) return;
  const loaded = await loadClient();
  if (!loaded.health.hasSomethingToReport(health)) return;
  failuresReported = true;
  try {
    const outcome = await control.reportCrash(
      loaded.health.crashReport(health, currentPhase, { userAgent: navigator.userAgent }),
    );
    if (!outcome.accepted) {
      console.warn(`dr.dsh: the crash report was not stored: ${outcome.error ?? 'no reason given'}`);
    } else {
      console.info(`dr.dsh: ${outcome.stored} crash report(s) are stored on your computer; run \`drdsh daemon crashes\` there to read them.`);
    }
  } catch (error) {
    console.warn(`dr.dsh: the crash report could not be sent: ${error.message}`);
  }
}

/**
 * Registers the service worker as soon as the page loads.
 *
 * Not only when the user connects, which is where it used to happen: the worker is what caches the
 * client's own files, so registering it late means a device that never pressed Connect has nothing
 * cached and shows a browser error page the first time it is opened offline. Registering on load also
 * means the worker has usually taken control before the first connection, which is what the tunnel's
 * handoff needs.
 *
 * A failure here leaves the shell readable, but the DSH interface still needs a worker to connect.
 */
async function ensureWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await navigator.serviceWorker.register('/client/service-worker.js', {
      scope: '/',
      type: 'module',
    });
    return await navigator.serviceWorker.ready;
  } catch (error) {
    console.warn(`dr.dsh: the service worker could not start; the DSH interface and offline shell need it. Open this relay over HTTPS (localhost HTTP works for local testing), then reload. (${error.message})`);
    return null;
  }
}

/** Whether this browser is offline right now, and what to say about it. */
let offline = false;

/**
 * Shows or clears the offline notice.
 *
 * The check is `navigator.onLine` *and* the notice's own wording, because the two failures are
 * different: with no network the relay is unreachable before anything is tried, while a reachable
 * network and a stopped relay produce the connect path's own sentence. This one only speaks for the
 * first case.
 */
function refreshOfflineNotice() {
  if (navigator.onLine) {
    offline = false;
    if (state.dataset.phase === 'offline') show('idle', '');
    return;
  }
  offline = true;
  show('offline', () => offlineNotice({ paired: device !== null && rooms.length > 0 }));
}

window.addEventListener('offline', () => void refreshOfflineNotice());
window.addEventListener('online', () => void refreshOfflineNotice());

/** Loads the stored device on page load, so the page never asks for a code it does not need. */
async function loadStoredDevice() {
  // Loading modules and reading storage fail for different reasons and need different advice.
  void ensureWorker();
  let loaded;
  try {
    loaded = await loadClient();
  } catch (error) {
    if (!navigator.onLine) {
      refreshOfflineNotice();
      return;
    }
    show('failed', () => error instanceof LocalizedError ? error.message : t('error.connection', { reason: errorText(error) }));
    return;
  }
  try {
    store = new loaded.storage.IndexedDbRoomStore();
    device = await store.loadIdentity();
    rooms = await store.listRooms();
    // The most recently used room is what the user meant by "connect"; the field stays empty because
    // there is nothing left to type once a pairing exists.
    selectedRoom = rooms[0] ?? null;
    renderDevice();
    // Said before the user tries anything: an offline device that only reports the problem after a
    // failed attempt has wasted the attempt.
    await refreshOfflineNotice();
  } catch (error) {
    // Storage is not required to use the page: pairing for this visit still works, and saying so
    // is better than refusing to load.
    show('idle', () => t('error.remember', { reason: errorText(error) }));
  }
}

forget.addEventListener('click', async () => {
  forget.disabled = true;
  try {
    const deviceId = device?.deviceId ?? '<id>';
    await store?.forgetAll();
    clearConnection();
    device = null;
    rooms = [];
    selectedRoom = null;
    renderDevice();
    show('idle', () => t('room.forgotAll', { id: deviceId }));
  } catch (error) {
    show('failed', () => t('error.forgetAll', { reason: errorText(error) }));
  } finally {
    forget.disabled = false;
  }
});

document.getElementById('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connect.disabled) return;
  clearConnection();
  const revision = connectionRevision;
  connect.disabled = true;
  key.disabled = true;
  let pairedThisAttempt = false;
  show('connecting', () => t('state.connecting'));
  panel.hidden = true;
  try {
    const loaded = await loadClient();
    if (revision !== connectionRevision) return;
    const { session, panelModule, controlModule, pairing, storage, credential } = loaded;
    if (store === null) store = new storage.IndexedDbRoomStore();

    // What the user typed decides what happens: a pairing code pairs first, a room key connects with
    // no identity, and an empty field uses the selected room's stored key.
    const typed = key.value.trim();
    let roomKey;
    let record = device;
    let room = selectedRoom?.room;
    if (typed !== '') {
      const parsed = credential.classifyCredential(typed);
      if (parsed.kind === 'code') {
        show('pairing', () => t('state.pairing'));
        const paired = await pairing.pairWithCode(
          {
            connect: (room) => openSocket(room),
            report: (phase) => {
              if (revision === connectionRevision && phase.phase === 'waiting') show('pairing', () => t('state.waiting'));
            },
          },
          // The label is what the room list shows. The device name the daemon stores is the same
          // string, so `drdsh daemon devices` and this list agree about which machine is which.
          //
          // The identity is the one this browser already has, when it has one (ADR-0007): pairing with a
          // second computer must enrol *this* device there too, not replace the key the first computer
          // knows. Passing nothing would generate a fresh identity and silently strand the first room.
          { code: parsed.code, deviceName: browserLabel(), identity: device },
        );
        if (revision !== connectionRevision) return;
        record = paired.record;
        // One identity, one more room (ADR-0007): pairing again with a second computer must not
        // replace the first one's key, and this call is what used to do exactly that.
        const stored = await store.remember(paired.record, roomLabel(paired.record.room), Date.now());
        device = { privateKey: paired.record.privateKey, publicKey: paired.record.publicKey, deviceId: paired.record.deviceId };
        rooms = await store.listRooms();
        if (revision !== connectionRevision) return;
        selectedRoom = rooms.find(candidate => candidate.room === stored.room) ?? stored;
        room = stored.room;
        roomKey = stored.roomKey;
        pairedThisAttempt = true;
        key.value = '';
        renderDevice();
        show('paired', () => t('state.paired', { id: record.deviceId, label: stored.label }));
      } else {
        roomKey = parsed.roomKey;
        // A typed room key carries no device identity, even if another computer is selected.
        room = undefined;
        record = null;
      }
    }
    roomKey = roomKey ?? selectedRoom?.roomKey;

    // Cleared per attempt; the binding itself is at module scope because the crash reporter needs it
    // after a connection has an outcome. It used to be declared here, and the reporter's reference to
    // it threw a ReferenceError that nothing surfaced — found by the browser smoke, which noticed no
    // report had arrived.
    const panelControl = new panelModule.ControlPanel({
      control: () => activePanel === panelControl ? control : null,
      render: (shown) => {
        if (activePanel !== panelControl) return;
        panel.hidden = false;
        panel.dataset.tone = shown.tone;
        headline.textContent = shown.headline;
        detail.textContent = shown.detail ?? '';
        detail.hidden = shown.detail === null;
        const wasAvailable = interfaceAvailable;
        interfaceAvailable = shown.interfaceAvailable;
        openButton.hidden = !interfaceAvailable;
        reloadHarness.disabled = !interfaceAvailable;
        disconnect.disabled = activeTunnel === null;
        if (!interfaceAvailable && (!hasEnteredHarness || wasAvailable)) showConnectionManager();
        else if (interfaceAvailable && !preferManager) showHarness();
        actions.replaceChildren();
        for (const action of shown.actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = action.label;
          button.disabled = !action.enabled;
          button.addEventListener('click', () => void panelControl.run(action.op));
          actions.append(button);
          if (action.reason !== null) {
            // The reason sits next to the button rather than in a tooltip: a greyed-out
            // control with no visible explanation reads as a bug, and a tooltip is not
            // reachable on a phone.
            const why = document.createElement('p');
            why.textContent = action.reason;
            actions.append(why);
          }
        }
      },
      schedule: (task, everyMs) => {
        const timer = setInterval(task, everyMs);
        return () => clearInterval(timer);
      },
      connectionLost: (reason) => {
        if (activePanel !== panelControl || activeTunnel === null) return;
        if (reason === 'timeout') {
          notificationFeed.disconnect();
          notificationsSuspended = true;
        } else {
          closeTransport();
        }
        show('failed', () => t(reason === 'timeout' ? 'panel.silent' : 'panel.dropped'));
      },
      connectionRestored: () => {
        if (activePanel !== panelControl || control === null || !notificationsSuspended) return;
        notificationFeed.connect(control);
        notificationsSuspended = false;
        show('ready', () => t('state.ready'));
      },
    });
    activePanel?.stop();
    activePanel = panelControl;
    await session.connect({ roomKey, room, device: record, waitForDaemon: pairedThisAttempt }, {
      report: (phase) => {
        if (revision !== connectionRevision) return;
        if (phase.phase === 'connecting') show('connecting', () => t('state.connecting'));
        if (phase.phase === 'ready') {
          show('ready', () => t('state.ready'));
          // The page reached a usable state: a soak run counts a start as healthy when this flips.
          health.ready = true;
          // Remembered so the list shows where the user has actually been, and so the next visit
          // defaults to the machine they last used. Best effort: a browser that refuses to write
          // must not fail a connection that already worked.
          if (selectedRoom !== null) {
            void store?.touch(selectedRoom.room, Date.now()).then(async () => {
              rooms = (await store?.listRooms()) ?? rooms;
              renderRooms();
            }).catch(() => {});
          }
          // Reported here rather than the moment a tunnel exists: "did this run ever work" is only
          // known once the connection has an outcome, and a report sent one step earlier would claim
          // `reached_ready: false` for every run that then succeeded.
          void reportOwnFailures();
        }
        if (phase.phase === 'failed') {
          const reason = () => errorText(phase.cause ?? phase.reason);
          show('failed', reason);
          panelControl.disconnected(reason);
          void reportOwnFailures();
        }
      },
      onWorkerReady: (viewId) => {
        if (revision === connectionRevision && activeViewId === viewId) interfaceBridge?.workerReady();
      },
      onTunnel: (tunnel, viewId) => {
        if (revision !== connectionRevision) {
          tunnel.close();
          return;
        }
        activeTunnel = tunnel;
        activeViewId = viewId;
        interfaceUrl = `/__dr/interface?drdshView=${encodeURIComponent(viewId)}`;
        control = new controlModule.ControlClient(tunnel);
        notificationFeed.connect(control);
        panelControl.connected();
        // A tunnel that was working and then died is "the link dropped", which is advice about
        // this browser's network — not the same as a daemon that stopped answering on a link
        // that is still up.
        stopTunnelClosed = tunnel.onClosed((reason) => {
          if (activeTunnel !== tunnel) return;
          closeTransport();
          show('failed', () => t('panel.dropped'));
          panelControl.socketDropped(reason);
        });
        // And again here, which is the call that normally sends it: the session reports `ready`
        // *before* it hands over the tunnel, so at that moment there is no control client to send
        // with. Both call sites are needed and neither is redundant — this one has a channel, the
        // phase hook has the outcome, and the "once per run" guard keeps them from both firing.
        void reportOwnFailures();
      },
    });
  } catch (error) {
    if (revision !== connectionRevision) return;
    // Offline is checked first: the raw failure here is "Failed to fetch", which names neither the
    // network nor what to do about it.
    if (offline || !navigator.onLine) {
      show('offline', () => offlineNotice({ paired: device !== null && rooms.length > 0 }));
      panel.hidden = true;
      return;
    }
    show('failed', () => pairedThisAttempt
      ? t('error.pairedConnection', { reason: errorText(error) })
      : error instanceof LocalizedError ? error.message : t('error.connection', { reason: errorText(error) }));
    panel.hidden = true;
  } finally {
    connect.disabled = false;
    key.disabled = false;
  }
});

/**
 * Opens the carrier socket for a room, as both pairing and connecting need.
 *
 * Kept here rather than in the modules it serves: this is the one place that touches `WebSocket`
 * and `location`, and both of the modules that need a socket take it as a parameter precisely so
 * that they can be tested in Node.
 */
async function openSocket(room) {
  const url = new URL('/ws/client', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const listeners = [];
  const closeListeners = [];
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') return;
    for (const listener of [...listeners]) listener(new Uint8Array(event.data));
  });
  socket.addEventListener('close', () => {
    for (const listener of [...closeListeners]) listener('the relay closed the connection');
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new LocalizedError(() => t('error.relayUnreachable'))), { once: true });
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
      resolve();
    }, { once: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocalizedError(() => t('error.relayHandshake'))), 10_000);
    const onMessage = (event) => {
      if (typeof event.data !== 'string') return;
      socket.removeEventListener('message', onMessage);
      clearTimeout(timer);
      const reply = JSON.parse(event.data);
      if (reply.type !== 'ready') {
        reject(new LocalizedError(() => t('error.relayRefused', { reason: reply.reason ?? t('error.noReason') })));
        return;
      }
      resolve();
    };
    socket.addEventListener('message', onMessage);
  });
  return {
    send: (data) => socket.send(data),
    receive: (handler) => listeners.push(handler),
    closed: (handler) => closeListeners.push(handler),
    close: () => socket.close(),
  };
}

openButton.addEventListener('click', showHarness);
returnToConnection.addEventListener('click', () => showConnectionManager(true));
closeControls.addEventListener('click', dismissConnectionManager);
connectionDialog.addEventListener('cancel', event => {
  event.preventDefault();
  dismissConnectionManager();
});
connectionDialog.addEventListener('close', () => returnToConnection.setAttribute('aria-expanded', 'false'));
const outsideDialog = event => {
  const rect = connectionDialog.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
};
let backdropPress = false;
connectionDialog.addEventListener('pointerdown', event => { backdropPress = event.target === connectionDialog && outsideDialog(event); });
connectionDialog.addEventListener('click', event => {
  if (backdropPress && event.target === connectionDialog && outsideDialog(event)) dismissConnectionManager();
  backdropPress = false;
});
reloadHarness.addEventListener('click', () => {
  if (!interfaceAvailable || interfaceUrl === null) return;
  interfaceBridge?.close();
  interfaceBridge = null;
  harnessFrame.src = interfaceUrl;
  dismissConnectionManager();
});
disconnect.addEventListener('click', () => {
  clearConnection();
  show('idle', () => t('state.disconnected'));
  connect.focus();
});
window.addEventListener('pagehide', clearConnection, { once: true });

renderLanguage();
void loadStoredDevice();
