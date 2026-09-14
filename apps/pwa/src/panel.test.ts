/**
 * The panel's decisions, without a browser.
 *
 * The panel is where a wrong decision is most expensive: a button that is enabled when it cannot
 * work produces an error where an explanation belongs, and a state described as something it is
 * not is how a user concludes the tool is broken. Both are cheap to test here and expensive to
 * notice in a browser, which is why the decisions are a pure function.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ControlClient } from './control.ts';
import type { LifecycleState, RelayHealth, Status } from './control.ts';
import { ControlPanel, panelView } from './panel.ts';
import type { PanelState, PanelView } from './panel.ts';
import { Tunnel } from './tunnel.ts';
import { CONTROL_STREAM, LABELS, additionalData, carrier, deriveKey, nonceBytes, parseCarrier } from './tunnel.ts';

const ROOT = new Uint8Array(32).fill(3);

/** A status with sensible defaults, so each test states only what it is about. */
function status(overrides: Partial<Status> = {}): Status {
  return {
    state: 'running',
    localUrl: 'http://127.0.0.1:3080',
    pid: 1234,
    uptimeSecs: 60,
    owned: true,
    lastError: null,
    relay: 'connected',
    protocol: [0, 1],
    ...overrides,
  };
}

function state(overrides: Partial<PanelState> = {}): PanelState {
  return {
    connected: true,
    socketClosed: false,
    tunnelError: null,
    status: status(),
    lastFailure: null,
    busy: false,
    ...overrides,
  };
}

/** The action for an operation, or a failure. */
function action(view: PanelView, op: 'start' | 'stop' | 'restart') {
  const found = view.actions.find(candidate => candidate.op === op);
  assert.ok(found !== undefined, `${op} must be present`);
  return found;
}

test('a disconnected panel offers a connection and disables everything', () => {
  const view = panelView(state({ connected: false, tunnelError: 'the relay refused this client' }));
  assert.equal(view.needsConnection, true);
  assert.equal(view.tone, 'error');
  assert.match(view.headline, /Not connected/);
  assert.match(view.detail ?? '', /refused this client/);
  assert.ok(
    view.actions.every(candidate => !candidate.enabled),
    'nothing may be enabled without a connection',
  );
});

test('a running DSH offers stop and restart but not start', () => {
  const view = panelView(state());
  assert.equal(action(view, 'start').enabled, false);
  assert.equal(action(view, 'stop').enabled, true);
  assert.equal(action(view, 'restart').enabled, true);
  // A disabled button says why: a greyed-out control with no reason reads as a bug.
  assert.match(action(view, 'start').reason ?? '', /already running/);
});

test('a stopped DSH offers start only', () => {
  const view = panelView(state({ status: status({ state: 'stopped', pid: null }) }));
  assert.equal(action(view, 'start').enabled, true);
  assert.equal(action(view, 'stop').enabled, false);
  assert.match(action(view, 'stop').reason ?? '', /not running/);
  // Restarting something that is not running is a start, and the daemon accepts it.
  assert.equal(action(view, 'restart').enabled, true);
});

test('a failed DSH is described as a failure with its reason', () => {
  const view = panelView(
    state({ status: status({ state: 'failed', lastError: 'the port is in use' }) }),
  );
  assert.equal(view.tone, 'error');
  assert.match(view.headline, /port is in use/);
  // Start is offered, because the fix may have been applied.
  assert.equal(action(view, 'start').enabled, true);
});

test('attach mode disables the controls and explains why', () => {
  // Criterion 5. The explanation is the point: a user who sees three dead buttons and no reason
  // has no way to tell an intentional restriction from a broken daemon.
  const view = panelView(state({ status: status({ state: 'attached', owned: false }) }));
  for (const op of ['start', 'stop', 'restart'] as const) {
    assert.equal(action(view, op).enabled, false, `${op} must be disabled in attach mode`);
    assert.match(action(view, op).reason ?? '', /started outside this daemon/, op);
  }
  assert.match(view.headline, /started outside this daemon/);
});

test('a busy daemon disables the controls while an operation runs', () => {
  const view = panelView(state({ busy: true }));
  for (const op of ['start', 'stop', 'restart'] as const) {
    assert.equal(action(view, op).enabled, false, `${op} must be disabled while busy`);
    assert.match(action(view, op).reason ?? '', /already running/, op);
  }
});

test('the failures get distinct sentences', () => {
  // Project definition § 9.7. These are different problems with different fixes, and a client
  // that said "connection error" for all of them would send every user to the same wrong place.
  //
  // The four cases below are the ones a person can actually distinguish, and the client can
  // distinguish them too because it sees different evidence for each: the daemon's own report of
  // the relay, its own socket closing, a socket that stays open but silent, and a handshake that
  // refused this device. The first version of this panel collapsed the middle two into one
  // sentence, which is exactly the collapse § 9.7 exists to forbid.
  const daemonSaysRelayIsDown = panelView(
    state({ status: status({ relay: 'unreachable' as RelayHealth }) }),
  );
  assert.match(daemonSaysRelayIsDown.detail ?? '', /unreachable/);
  assert.equal(daemonSaysRelayIsDown.tone, 'warn', 'a relay problem does not stop a local session');

  const ourSocketClosed = panelView(state({ socketClosed: true }));
  assert.match(ourSocketClosed.headline, /connection to the relay dropped/);
  assert.match(ourSocketClosed.detail ?? '', /your own network/);

  const daemonSilent = panelView(
    state({ lastFailure: { reason: 'timeout', message: 'the daemon did not answer' } }),
  );
  assert.match(daemonSilent.headline, /computer is not answering/);
  assert.match(daemonSilent.detail ?? '', /may have stopped/);

  const notPaired = panelView(
    state({ connected: false, tunnelError: 'this device is not paired with that daemon any more' }),
  );
  assert.match(notPaired.detail ?? '', /not paired/);

  const sentences = new Set([
    daemonSaysRelayIsDown.headline,
    ourSocketClosed.headline,
    daemonSilent.headline,
    notPaired.headline,
  ]);
  assert.equal(sentences.size, 4, 'each failure must have its own headline');
});

test('a closed socket is not confused with a silent one', () => {
  // The evidence differs — a closed socket versus an open one that stops answering — and so must
  // the advice: one is the user's own network, the other is their computer.
  const closed = panelView(state({ socketClosed: true }));
  const silent = panelView(
    state({ lastFailure: { reason: 'timeout', message: 'no answer' } }),
  );
  assert.notEqual(closed.headline, silent.headline);
  assert.notEqual(closed.detail, silent.detail);
  assert.match(closed.detail ?? '', /network/);
  assert.match(silent.detail ?? '', /stopped|asleep/);
});

test('a stale status is dropped when the tunnel dies', () => {
  // Showing "DSH is running" from a reading taken before the connection died is exactly the lie
  // the panel exists to avoid: the user would conclude everything is fine and stop looking.
  const drawn: PanelView[] = [];
  const panel = new ControlPanel(
    { control: () => null, render: view => drawn.push(view), schedule: () => () => {} },
    { connected: true, status: status() },
  );
  panel.draw();
  assert.match(drawn.at(-1)?.headline ?? '', /running/i);

  panel.disconnected('the relay closed the connection');
  assert.match(drawn.at(-1)?.headline ?? '', /Not connected/);
});

test('a refusal is shown as final rather than as a fault to retry', async () => {
  // A refusal (attach mode, an unknown operation) is final; a failure is worth retrying. A
  // panel that showed the same thing for both would tell a user to retry something that can
  // never work.
  const drawn: PanelView[] = [];
  const panel = new ControlPanel(
    {
      control: () =>
        ({
          status: async () => status(),
          command: async () => ({
            ok: false,
            state: 'attached' as LifecycleState,
            error: 'stopping DSH is not available: DSH was started outside this daemon',
            accepted: false,
          }),
        }) as unknown as ControlClient,
      render: view => drawn.push(view),
      schedule: () => () => {},
    },
    { connected: true, status: status() },
  );
  await panel.run('stop');
  const last = drawn.at(-1);
  assert.ok(last !== undefined);
  assert.match(last.detail ?? '', /started outside this daemon/);
  assert.equal(last.tone, 'error');
  // And the controls are disabled afterwards, because the refusal told us they cannot work.
  assert.equal(action(last, 'stop').enabled, false);
});

test('a successful operation uses the state the daemon reported', async () => {
  // The daemon answers with the state *after* the operation, so the panel must not keep showing
  // the state from before it — that is how a UI ends up with a start button while DSH is
  // already running.
  const drawn: PanelView[] = [];
  let refreshed = 0;
  // A daemon that remembers: the panel confirms with a real read, so a fake that always answers
  // `running` would be testing a daemon that ignored the stop.
  let current: LifecycleState = 'running';
  const panel = new ControlPanel(
    {
      control: () =>
        ({
          status: async () => {
            refreshed += 1;
            return status({ state: current });
          },
          command: async () => {
            current = 'stopped';
            return { ok: true, state: current, error: null, accepted: true };
          },
        }) as unknown as ControlClient,
      render: view => drawn.push(view),
      schedule: () => () => {},
    },
    { connected: true, status: status({ state: 'running' }) },
  );
  await panel.run('stop');
  assert.equal(refreshed, 1, 'the panel confirms with one status read');
  const last = drawn.at(-1);
  assert.ok(last !== undefined);
  assert.match(last.headline, /stopped/i);
  assert.equal(action(last, 'start').enabled, true);
});

/** Turns a control payload into something the panel can be driven with. */
async function liveTunnel(answers: (request: Record<string, unknown>) => Record<string, unknown>) {
  const handlers: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
  let openKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.clientToDaemon);
  let sealKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.daemonToClient);
  let openCounter = 0;
  let sealCounter = 0;
  let adopted = false;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (frame: Uint8Array<ArrayBuffer>): void => {
    for (const handler of [...handlers]) handler(frame);
  };
  async function seal(streamId: number, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    const counter = sealCounter;
    sealCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(streamId, counter) },
        sealKey,
        payload,
      ),
    );
    const body = new Uint8Array(8 + sealed.length);
    new DataView(body.buffer).setBigUint64(0, BigInt(counter), false);
    body.set(sealed, 8);
    deliver(carrier(streamId, body));
  }
  async function handle(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const { streamId, body } = parseCarrier(frame);
    const counter = Number(
      new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(0, false),
    );
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(streamId, counter) },
        openKey,
        body.subarray(8),
      ),
    );
    openCounter += 1;
    if (!adopted) {
      adopted = true;
      sealKey = await deriveKey(ROOT, plaintext, LABELS.daemonToClient);
      openKey = await deriveKey(ROOT, plaintext, LABELS.clientToDaemon);
      sealCounter = 0;
      await seal(CONTROL_STREAM, new Uint8Array([0x6b]));
      return;
    }
    const request = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    const reply = answers(request);
    await seal(CONTROL_STREAM, new TextEncoder().encode(JSON.stringify(reply)));
  }
  const socket = {
    send(data: Uint8Array<ArrayBuffer>) {
      chain = chain.then(() => handle(data));
      chain = chain.catch(() => {});
    },
    receive(handler: (data: Uint8Array<ArrayBuffer>) => void) {
      handlers.push(handler);
    },
    closed() {},
    close() {},
  };
  return Tunnel.open(socket, ROOT);
}

test('the panel drives a real control client end to end', async () => {
  // The pure tests above decide correctly; this checks the panel is actually wired to a control
  // client — the class of bug where every unit passes and the assembled thing does nothing.
  let daemonState: LifecycleState = 'running';
  let daemonPid: number | null = 99;
  const tunnel = await liveTunnel(request => {
    if (request['kind'] === 'status_request') {
      return {
        kind: 'status_response',
        id: request['id'],
        body: {
          state: daemonState,
          local_url: null,
          pid: daemonPid,
          uptime_secs: null,
          owned: true,
          last_error: null,
          relay: 'connected',
          protocol: [0, 1],
        },
      };
    }
    // The command changes what the daemon will report next, as a real one does.
    const body = request['body'] as { op?: string } | undefined;
    if (body?.op === 'stop') {
      daemonState = 'stopped';
      daemonPid = null;
    }
    return {
      kind: 'lifecycle_result',
      id: request['id'],
      body: { ok: true, state: daemonState, error: null, accepted: true },
    };
  });
  const control = new ControlClient(tunnel);
  const drawn: PanelView[] = [];
  const panel = new ControlPanel(
    { control: () => control, render: view => drawn.push(view), schedule: () => () => {} },
    { connected: true },
  );

  await panel.refresh();
  assert.match(drawn.at(-1)?.headline ?? '', /running/i);
  assert.equal(drawn.at(-1)?.detail, 'Process 99.');

  await panel.run('stop');
  assert.match(drawn.at(-1)?.headline ?? '', /stopped/i);
  assert.equal(action(drawn.at(-1) as PanelView, 'start').enabled, true);

  panel.stop();
  control.close();
  tunnel.close();
});
