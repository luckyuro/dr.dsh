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

/**
 * Answers the interface's WebSockets over the tunnel.
 *
 * The interface page cannot reach the tunnel and the service worker cannot intercept a WebSocket
 * upgrade, so the page that owns the tunnel does the carrying. This is the receiving end of
 * `/client/ws-bootstrap.js`: same-origin, no globals shared with DSH's page, and the tunnel itself
 * never leaves this page.
 *
 * @param tunnel - the live tunnel.
 * @param codec - the proxy plane's encoders and decoder, passed in rather than imported: this
 *   script is plain JavaScript served as-is, so a top-level `import` would make it a module the
 *   TypeScript build has to type-check, and the codec is the one part of it worth type-checking.
 */
function serveInterfaceSockets(tunnel, codec) {
  const { decodeMessage, encodeWsData, encodeWsOpen } = codec;
  const channel = new BroadcastChannel('dr-dsh-websocket');
  // One stream per socket. The daemon's proxy plane correlates frames by the id inside the
  // message, so the two are kept equal here to leave no room for them to disagree.
  const sockets = new Map();
  let nextStream = 100;

  channel.onmessage = event => {
    const message = event.data;
    if (message === null || typeof message !== 'object') return;

    if (message.kind === 'open') {
      const streamId = nextStream;
      nextStream += 1;
      const stop = tunnel.on(streamId, payload => {
        const decoded = decodeMessage(payload);
        if (decoded === undefined) return;
        if (decoded.kind === 'wsOpened') {
          channel.postMessage({ kind: 'opened', id: message.id, status: decoded.status });
        } else if (decoded.kind === 'wsData') {
          const frame = decoded.frame;
          if (frame.kind === 'close') {
            channel.postMessage({ kind: 'closed', id: message.id, code: 1000, reason: '' });
            stop();
            sockets.delete(message.id);
          } else {
            channel.postMessage({ kind: 'data', id: message.id, text: frame.text });
          }
        } else if (decoded.kind === 'failure') {
          channel.postMessage({ kind: 'closed', id: message.id, code: 1006, reason: decoded.reason });
          stop();
          sockets.delete(message.id);
        }
      });
      sockets.set(message.id, { streamId, stop });
      void tunnel.send(streamId, encodeWsOpen(message.id, message.target)).catch(error => {
        channel.postMessage({ kind: 'closed', id: message.id, code: 1006, reason: String(error) });
      });
      return;
    }

    const socket = sockets.get(message.id);
    if (socket === undefined) return;
    if (message.kind === 'send') {
      void tunnel.send(socket.streamId, encodeWsData(message.id, { kind: 'text', text: message.text }));
      return;
    }
    if (message.kind === 'close') {
      void tunnel.send(socket.streamId, encodeWsData(message.id, { kind: 'close' }));
      socket.stop();
      sockets.delete(message.id);
    }
  };
}

const state = document.getElementById('state');
const connect = document.getElementById('connect');
const forget = document.getElementById('forget');
const key = document.getElementById('key');
const deviceLine = document.getElementById('device');
const roomsSection = document.getElementById('rooms');
const roomList = document.getElementById('room-list');
const panel = document.getElementById('panel');
const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const actions = document.getElementById('actions');
const openButton = document.getElementById('open');

function show(phase, message) {
  state.dataset.phase = phase;
  state.textContent = message;
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
 * A short label for `drdshd devices`.
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
    const [session, panelModule, controlModule, proxyCodec, pairing, identity, storage, credential, offlineModule, healthModule] =
      await Promise.all([
        import('/client/session.js'),
        import('/client/panel.js'),
        import('/client/control.js'),
        import('/client/proxy.js'),
        import('/client/pair.js'),
        import('/client/identity.js'),
        import('/client/storage.js'),
        import('/client/credential.js'),
        import('/client/offline.js'),
        // Loaded here with the rest so a report can be built without a second round of fetching on
        // a page that is already failing.
        import('/client/health.js'),
      ]);
    client = {
      session,
      panelModule,
      controlModule,
      proxyCodec,
      pairing,
      identity,
      storage,
      credential,
      offline: offlineModule,
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
    key.placeholder = 'the code `drdshd pair` printed';
    return;
  }
  deviceLine.hidden = false;
  deviceLine.textContent =
    rooms.length === 1
      ? `Paired as ${device.deviceId} with ${rooms[0].label}.`
      : `Paired as ${device.deviceId} with ${rooms.length} computers.`;
  roomsSection.hidden = false;
  forget.hidden = false;
  key.placeholder = 'paired already — leave empty to use the selected computer';
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
      selectedRoom = room;
      renderRooms();
      show('idle', `Selected ${room.label}. Press Connect.`);
    });

    const when = document.createElement('span');
    when.style.fontSize = '.85rem';
    when.style.opacity = '.75';
    const seen = room.lastConnectedAtMs ?? room.pairedAtMs;
    when.textContent =
      room.lastConnectedAtMs === null
        ? 'never connected'
        : `last used ${new Date(seen).toISOString().slice(0, 16).replace('T', ' ')}`;

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = 'Forget';
    drop.addEventListener('click', () => void forgetRoom(room));

    row.append(choose, when, drop);
    roomList.append(row);
  }
}

/** Forgets one room. The identity stays: the other rooms still need it. */
async function forgetRoom(room) {
  try {
    await store?.forget(room.room);
    rooms = rooms.filter(candidate => candidate.room !== room.room);
    if (selectedRoom?.room === room.room) selectedRoom = rooms[0] ?? null;
    renderDevice();
    show('idle', `Forgot ${room.label}. Its daemon still lists this device until you revoke it there.`);
  } catch (error) {
    show('failed', `Could not forget that computer: ${error.message}`);
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

/**
 * Sends this run's failures to the daemon, once, once the connection attempt has an outcome.
 *
 * One hop and no service: the report goes to the machine this page is paired with, which writes it
 * somewhere `drdshd crashes` can show it (`docs/security.md` § 5.10). Nothing is uploaded, and a run
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
      console.info(`dr.dsh: ${outcome.stored} crash report(s) are stored on your computer; run \`drdshd crashes\` there to read them.`);
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
 * A failure here is reported but not fatal: the page works, it just cannot be used offline.
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
    console.warn(`dr.dsh: no service worker, so this page cannot be used offline: ${error.message}`);
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
async function refreshOfflineNotice() {
  if (navigator.onLine) {
    offline = false;
    if (state.dataset.phase === 'offline') show('idle', '');
    return;
  }
  offline = true;
  const loaded = await loadClient();
  show('offline', loaded.offline.offlineNotice({ paired: device !== null }));
}

window.addEventListener('offline', () => void refreshOfflineNotice());
window.addEventListener('online', () => void refreshOfflineNotice());

/** Loads the stored device on page load, so the page never asks for a code it does not need. */
async function loadStoredDevice() {
  try {
    // Before anything else that can fail: the worker is what makes the *next* load possible with no
    // network, including the load that reports the outage.
    void ensureWorker();
    const loaded = await loadClient();
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
    show('idle', `This browser cannot remember a pairing: ${error.message}`);
  }
}

forget.addEventListener('click', async () => {
  forget.disabled = true;
  try {
    await store?.forgetAll();
    device = null;
    rooms = [];
    selectedRoom = null;
    renderDevice();
    show('idle', 'This browser forgot every computer. Pair again to reconnect.');
  } finally {
    forget.disabled = false;
  }
});

connect.addEventListener('click', async () => {
  connect.disabled = true;
  show('connecting', 'Connecting…');
  panel.hidden = true;
  try {
    const loaded = await loadClient();
    const { session, panelModule, controlModule, proxyCodec, pairing, storage, credential } = loaded;
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
        show('pairing', `Pairing with ${parsed.code}…`);
        const paired = await pairing.pairWithCode(
          {
            connect: (room) => openSocket(room),
            report: (phase) => {
              if (phase.phase === 'waiting') show('pairing', 'Waiting for the daemon to answer…');
            },
          },
          // The label is what the room list shows. The device name the daemon stores is the same
          // string, so `drdshd devices` and this list agree about which machine is which.
          //
          // The identity is the one this browser already has, when it has one (ADR-0007): pairing with a
          // second computer must enrol *this* device there too, not replace the key the first computer
          // knows. Passing nothing would generate a fresh identity and silently strand the first room.
          { code: parsed.code, deviceName: browserLabel(), identity: device },
        );
        record = paired.record;
        // One identity, one more room (ADR-0007): pairing again with a second computer must not
        // replace the first one's key, and this call is what used to do exactly that.
        const stored = await store.remember(paired.record, roomLabel(paired.record.room), Date.now());
        device = { privateKey: paired.record.privateKey, publicKey: paired.record.publicKey, deviceId: paired.record.deviceId };
        rooms = await store.listRooms();
        selectedRoom = rooms.find(candidate => candidate.room === stored.room) ?? rooms[0] ?? null;
        key.value = '';
        renderDevice();
        show('paired', `Paired as ${record.deviceId} with ${stored.label}. Press Connect to open the tunnel.`);
        connect.disabled = false;
        return;
      }
      roomKey = parsed.roomKey;
      // A typed room key is not a stored room, so nothing is selected for it: the session binds no
      // device identity and the tunnel is a room-key session.
      room = undefined;
      record = null;
    }
    roomKey = roomKey ?? selectedRoom?.roomKey;

    // Cleared per attempt; the binding itself is at module scope because the crash reporter needs it
    // after a connection has an outcome. It used to be declared here, and the reporter's reference to
    // it threw a ReferenceError that nothing surfaced — found by the browser smoke, which noticed no
    // report had arrived.
    control = null;
    const panelControl = new panelModule.ControlPanel({
      control: () => control,
      render: (shown) => {
        panel.hidden = false;
        panel.dataset.tone = shown.tone;
        headline.textContent = shown.headline;
        detail.textContent = shown.detail ?? '';
        detail.hidden = shown.detail === null;
        openButton.hidden = !(shown.tone === 'ok' || shown.tone === 'busy');
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
    });
    await session.connect({ roomKey, room, device: record }, {
      report: (phase) => {
        if (phase.phase === 'connecting') show('connecting', 'Connecting…');
        if (phase.phase === 'ready') {
          show('ready', 'Connected.');
          // The page reached a usable state: a soak run counts a start as healthy when this flips.
          health.ready = true;
          // Remembered so the list shows where the user has actually been, and so the next visit
          // defaults to the machine they last used. Best effort: a browser that refuses to write
          // must not fail a connection that already worked.
          if (selectedRoom !== null) {
            void store?.touch(selectedRoom.room, Date.now()).then(async () => {
              rooms = (await store?.listRooms()) ?? rooms;
            });
          }
          // Reported here rather than the moment a tunnel exists: "did this run ever work" is only
          // known once the connection has an outcome, and a report sent one step earlier would claim
          // `reached_ready: false` for every run that then succeeded.
          void reportOwnFailures();
        }
        if (phase.phase === 'failed') {
          show('failed', phase.reason);
          panelControl.disconnected(phase.reason);
          void reportOwnFailures();
        }
      },
      onTunnel: (tunnel) => {
        control = new controlModule.ControlClient(tunnel);
        serveInterfaceSockets(tunnel, proxyCodec);
        panelControl.connected();
        // A tunnel that was working and then died is "the link dropped", which is advice about
        // this browser's network — not the same as a daemon that stopped answering on a link
        // that is still up.
        tunnel.onClosed((reason) => panelControl.socketDropped(reason));
        // And again here, which is the call that normally sends it: the session reports `ready`
        // *before* it hands over the tunnel, so at that moment there is no control client to send
        // with. Both call sites are needed and neither is redundant — this one has a channel, the
        // phase hook has the outcome, and the "once per run" guard keeps them from both firing.
        void reportOwnFailures();
      },
    });
  } catch (error) {
    // Offline is checked first: the raw failure here is "Failed to fetch", which names neither the
    // network nor what to do about it.
    if (offline || !navigator.onLine) {
      const loaded = await loadClient().catch(() => null);
      show(
        'offline',
        loaded === null
          ? 'This device is offline, so dr.dsh cannot reach the relay. Reconnect and try again.'
          : loaded.offline.offlineNotice({ paired: device !== null }),
      );
      panel.hidden = true;
      return;
    }
    // A module that fails to load is the one failure whose message says nothing useful: the
    // browser reports a MIME type or a syntax error, and the cause is that this client is
    // TypeScript which the browser has to run directly.
    const message = /import|module|MIME|Unexpected token/i.test(String(error.message))
      ? 'This browser could not load the client. It needs to run TypeScript modules directly; ' +
        `a browser without that support cannot use this build. (${error.message})`
      : error.message;
    show('failed', message);
    panel.hidden = true;
  } finally {
    connect.disabled = false;
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
    socket.addEventListener('error', () => reject(new Error('cannot reach the relay')), { once: true });
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
      resolve();
    }, { once: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the relay never answered the handshake')), 10_000);
    const onMessage = (event) => {
      if (typeof event.data !== 'string') return;
      socket.removeEventListener('message', onMessage);
      clearTimeout(timer);
      const reply = JSON.parse(event.data);
      if (reply.type !== 'ready') {
        reject(new Error(reply.reason ?? 'the relay refused this client'));
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

// The interface opens when the user asks for it, not automatically: a page that navigated
// away the moment it connected would take the tunnel down with it, and the panel would never
// be seen.
//
// The target is the client's interface path. Not `/`: a service worker does not intercept a
// navigation to its own page, and this page *is* `/`, so asking for it again would be answered
// by the browser and the interface would never load. Not `/__dr/dsh/` either: that is what the
// worker rewrites requests *to*, so asking for it asks the relay for a page it has not got.
openButton.addEventListener('click', () => {
  // A new tab, not this one. The tunnel lives in this page: the page owns the carrier socket
  // and answers the worker's requests, and the worker cannot hold a tunnel on its own. A
  // navigation replaces this page and ends its script, so the interface would load in a page
  // whose requests nobody is answering — which is exactly what happened: the interface's HTML
  // arrived through the tunnel and every asset after it hung.
  window.open('/__dr/interface', '_blank', 'noopener');
});

void loadStoredDevice();
