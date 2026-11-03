/**
 * The control plane, against a stand-in daemon.
 *
 * What is checked here is the part that only exists on this side: that a status reply is turned
 * into something a UI can render, that a refusal is distinguishable from a failure, and that a
 * request which is never answered ends as an error rather than a wait. The daemon's own half is
 * tested in Rust (`crates/dr-dsh-daemon/src/control.rs`), so a disagreement between the two would
 * show up as a malformed reply here — which is exactly the failure mode a hand-written mirror
 * of a wire format is prone to.
 */

import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';

import { ControlClient, ControlError, describe, describeRelay } from './control.ts';
import type { LifecycleState, RelayHealth } from './control.ts';
import { crashReport, emptyHealth, recordFailure } from './health.ts';
import type { Notification } from './notifications.ts';
import {
  CONTROL_STREAM,
  LABELS,
  Tunnel,
  additionalData,
  carrier,
  deriveKey,
  nonceBytes,
  parseCarrier,
} from './tunnel.ts';

const ROOT = new Uint8Array(32).fill(11);

/** What the stand-in daemon should answer, and what it saw. */
interface StandIn {
  readonly socket: {
    send(data: Uint8Array<ArrayBuffer>): void;
    receive(handler: (data: Uint8Array<ArrayBuffer>) => void): void;
    closed(handler: (reason: string) => void): void;
    close(): void;
  };
  /** Every control request the daemon received, decoded. */
  readonly requests: Record<string, unknown>[];
  /** Every crash report body the daemon received, decoded. */
  readonly crashReports: Record<string, unknown>[];
  /** Drops the connection, as a daemon that went away would. */
  drop(): void;
  /** Changes what the daemon will answer next. */
  setStatus(state: LifecycleState, relay: RelayHealth, extra?: Record<string, unknown>): void;
  setResult(body: Record<string, unknown>): void;
  setProblem(message: string): void;
  /** Stops answering anything, leaving requests outstanding. */
  goSilent(): void;
  emit(message: unknown): Promise<void>;
  emitPayload(streamId: number, payload: Uint8Array<ArrayBuffer>): Promise<void>;
}

/**
 * A stand-in daemon that completes the handshake and answers control requests.
 *
 * It mirrors what `crates/dr-dsh-daemon/src/control.rs` writes, field for field: the point of a
 * stand-in here is to be *exactly* as strict as the real one, because a lenient stand-in hides
 * a client that would fail against the daemon.
 */
async function standIn(): Promise<StandIn> {
  const handlers: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  const requests: Record<string, unknown>[] = [];
  const crashReports: Record<string, unknown>[] = [];

  let openKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.clientToDaemon);
  let sealKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.daemonToClient);
  let openCounter = 0;
  let sealCounter = 0;
  let adopted = false;
  let silent = false;
  let chain: Promise<void> = Promise.resolve();

  let statusBody: Record<string, unknown> = {
    state: 'running',
    local_url: 'http://127.0.0.1:3080',
    pid: 4242,
    uptime_secs: 61,
    owned: true,
    last_error: null,
    relay: 'connected',
    protocol: [0, 1],
  };
  let resultBody: Record<string, unknown> = {
    ok: true,
    state: 'running',
    error: null,
    accepted: true,
  };
  let problem: string | null = null;

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
    assert.equal(counter, openCounter, 'the daemon expects the next counter');
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
    requests.push(request);
    if (silent) return;
    const id = request['id'];
    if (problem !== null) {
      await seal(
        CONTROL_STREAM,
        new TextEncoder().encode(
          JSON.stringify({ kind: 'problem', id, body: { message: problem } }),
        ),
      );
      return;
    }
    if (request['kind'] === 'status_request') {
      await seal(
        CONTROL_STREAM,
        new TextEncoder().encode(
          JSON.stringify({ kind: 'status_response', id, body: statusBody }),
        ),
      );
      return;
    }
    if (request['kind'] === 'lifecycle_command') {
      // The op has to be in the request body, which is what the daemon reads.
      const body_ = request['body'] as { op?: unknown } | undefined;
      assert.ok(body_ !== undefined && typeof body_.op === 'string', 'the command carries an op');
      await seal(
        CONTROL_STREAM,
        new TextEncoder().encode(
          JSON.stringify({ kind: 'lifecycle_result', id, body: resultBody }),
        ),
      );
      return;
    }
    if (request['kind'] === 'crash_report') {
      // Mirrors `crates/dr-dsh-daemon/src/control.rs`: the report is validated and stored, and the
      // answer says whether it was kept and how many the daemon holds. A stand-in that accepted
      // anything would hide a client that sends a body the real daemon refuses.
      const body_ = request['body'] as Record<string, unknown> | undefined;
      assert.ok(body_ !== undefined, 'a crash report carries a body');
      assert.ok(Array.isArray(body_['samples']), 'the report carries its samples');
      assert.equal(typeof body_['reached_ready'], 'boolean', 'the report says whether it was usable');
      assert.equal(typeof body_['at_ms'], 'number', 'the report is dated');
      crashReports.push(body_);
      await seal(
        CONTROL_STREAM,
        new TextEncoder().encode(
          JSON.stringify({
            kind: 'crash_report_result',
            id,
            body: { accepted: true, stored: crashReports.length, error: null },
          }),
        ),
      );
      return;
    }
    await seal(
      CONTROL_STREAM,
      new TextEncoder().encode(
        JSON.stringify({ kind: 'problem', id, body: { message: 'unknown kind' } }),
      ),
    );
  }

  const socket = {
    send(data: Uint8Array<ArrayBuffer>) {
      chain = chain.then(() => handle(data));
      chain = chain.catch(() => {});
    },
    receive(handler: (data: Uint8Array<ArrayBuffer>) => void) {
      handlers.push(handler);
    },
    closed(handler: (reason: string) => void) {
      closeHandlers.push(handler);
    },
    close() {},
  };

  return {
    socket,
    requests,
    crashReports,
    emit(message) {
      chain = chain.then(() => seal(CONTROL_STREAM, new TextEncoder().encode(JSON.stringify(message))));
      return chain;
    },
    emitPayload(streamId, payload) {
      chain = chain.then(() => seal(streamId, payload));
      return chain;
    },
    drop() {
      for (const handler of [...closeHandlers]) handler('the relay closed the connection');
    },
    setStatus(state, relay, extra = {}) {
      statusBody = { ...statusBody, state, relay, ...extra };
    },
    setResult(body) {
      resultBody = body;
    },
    setProblem(message) {
      problem = message;
    },
    goSilent() {
      silent = true;
    },
  };
}

const opened: Tunnel[] = [];
const clients: ControlClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const tunnel of opened.splice(0)) tunnel.close();
});

/** A client on a tunnel against a stand-in daemon. */
async function connected(): Promise<{ client: ControlClient; daemon: StandIn; tunnel: Tunnel }> {
  const daemon = await standIn();
  const tunnel = await Tunnel.open(daemon.socket, ROOT);
  opened.push(tunnel);
  const client = new ControlClient(tunnel);
  clients.push(client);
  return { client, daemon, tunnel };
}

/** Keep real cryptography, but advance request budgets without a minute-long test. */
function requestClock(t: TestContext): { advance(ms: number): void } {
  let now = Math.ceil(performance.now());
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return {
    advance(ms) {
      // Tick each callback with the same monotonic time the implementation reads.
      while (ms > 0) {
        const step = Math.min(ms, 1_000);
        now += step;
        t.mock.timers.tick(step);
        ms -= step;
      }
    },
  };
}

async function deliverBody(daemon: StandIn, tunnel: Tunnel): Promise<void> {
  const received = new Promise<void>(resolve => {
    const stop = tunnel.on(7, () => { stop(); resolve(); });
  });
  await daemon.emitPayload(7, new Uint8Array(48 * 1024));
  await received;
}

test('a status reply becomes something a UI can render', async () => {
  const { client } = await connected();
  const status = await client.status();
  assert.equal(status.state, 'running');
  assert.equal(status.pid, 4242);
  assert.equal(status.relay, 'connected');
  assert.equal(status.owned, true);
  assert.equal(status.uptimeSecs, 61);
  assert.deepEqual(status.protocol, [0, 1]);
});

test('unsolicited notifications arrive over the encrypted control stream without consuming replies', async () => {
  const { client, daemon } = await connected();
  const received: Notification[] = [];
  const unsubscribe = client.onNotification(notification => received.push(notification));
  const body = { event: 'turn_complete', severity: 'notice', at_ms: 1234, session_ref: 'session_1' };
  for (const id of [0, null, undefined]) await daemon.emit({ kind: 'notification', id, body });
  assert.equal((await client.status()).state, 'running');
  assert.equal(received.length, 3);
  assert.deepEqual(received[0], { event: 'turn_complete', severity: 'notice', atMs: 1234, sessionRef: 'session_1' });
  await daemon.emit({ kind: 'notification', id: 2, body });
  await daemon.emit({ kind: 'notification', id: 0, body: { ...body, title: 'private data' } });
  assert.equal((await client.status()).state, 'running', 'a notification with a request id cannot settle the request');
  assert.equal(received.length, 3, 'malformed envelopes and content-bearing bodies are ignored');
  unsubscribe();
  await daemon.emit({ kind: 'notification', id: 0, body });
  await client.status();
  assert.equal(received.length, 3);
});

test('a dropped tunnel retires the control client and immediately rejects outstanding requests', async () => {
  const { client, daemon } = await connected();
  daemon.goSilent();
  const pending = client.status();
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ControlError && error.reason === 'disconnected');
  daemon.drop();
  await rejected;
  await assert.rejects(client.status(), (error: unknown) => error instanceof ControlError && error.reason === 'disconnected');
});

test('a lifecycle command carries only an operation', async () => {
  // The wire has no field for an argument, and this is what makes that true on the client side
  // too: there is nothing to put a flag in.
  const { client, daemon } = await connected();
  const outcome = await client.command('restart');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.state, 'running');
  const command = daemon.requests.find(request => request['kind'] === 'lifecycle_command');
  assert.ok(command !== undefined, 'the daemon must have received the command');
  assert.deepEqual(command['body'], { op: 'restart' });
});

test('an operation outside the whitelist is refused before it reaches the wire', async () => {
  // Not reachable from typed code; reachable from a page that built the string at runtime, and
  // refusing here keeps the expressible surface identical to the typed one.
  const { client, daemon } = await connected();
  await assert.rejects(
    client.command('rm -rf /' as never),
    (error: unknown) => error instanceof ControlError && error.reason === 'refused',
  );
  assert.equal(
    daemon.requests.filter(request => request['kind'] === 'lifecycle_command').length,
    0,
    'nothing may reach the daemon',
  );
});

test('a refusal is distinguishable from a failure', async () => {
  // A refusal is final — attach mode, an unknown operation — while a failure means the daemon
  // tried and DSH did not come up. A UI that showed the same thing for both would tell a user
  // to retry something that can never work.
  const { client, daemon } = await connected();
  daemon.setResult({
    ok: false,
    state: 'attached',
    error: 'stopping DSH is not available: DSH was started outside this daemon',
    accepted: false,
  });
  const outcome = await client.command('stop');
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, 'attached');
  assert.match(outcome.error ?? '', /started outside this daemon/);
});

test('a daemon that reports a problem is surfaced as a refusal', async () => {
  const { client, daemon } = await connected();
  daemon.setProblem('lifecycle_command needs an "op" of start, stop, or restart');
  await assert.rejects(
    client.status(),
    (error: unknown) =>
      error instanceof ControlError &&
      error.reason === 'refused' &&
      /needs an "op"/.test((error as Error).message),
  );
});

test('a malformed reply is an error rather than a wrong value', async () => {
  // The client mirrors a wire format by hand, so the failure mode to guard against is a reply
  // that parses but does not mean what the code assumes.
  const { client, daemon } = await connected();
  daemon.setStatus('teleporting' as LifecycleState, 'connected');
  await assert.rejects(
    client.status(),
    (error: unknown) => error instanceof ControlError && error.reason === 'malformed',
  );
});

test('an unanswered request ends as a timeout, not a wait', async () => {
  // The acceptance criterion for failure transparency: a client that waits forever shows a
  // spinner, and a spinner is indistinguishable from a slow daemon.
  const { client, daemon, tunnel } = await connected();
  daemon.goSilent();
  await assert.rejects(
    client.status(),
    (error: unknown) =>
      error instanceof ControlError &&
      error.reason === 'timeout',
  );
  assert.equal(tunnel.failure, null);
  assert.equal(tunnel.isEstablished, true, 'one request timeout does not terminate the carrier');
});

test('authenticated body traffic allows a status reply to wait behind a slow transfer', async t => {
  const { client, daemon, tunnel } = await connected();
  daemon.goSilent();
  const clock = requestClock(t);
  let settled = false;
  const pending = client.status();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < 24_000; elapsed += 4_000) {
    clock.advance(4_000);
    await deliverBody(daemon, tunnel);
    assert.equal(settled, false, 'the active transfer must not make the computer look silent');
  }
  const request = daemon.requests.find(request => request['kind'] === 'status_request');
  assert.ok(request);
  await daemon.emit({ kind: 'status_response', id: request['id'], body: {
    state: 'running', relay: 'connected', pid: 4242, owned: true, protocol: [0, 1],
  } });
  assert.equal((await pending).pid, 4242);
  clock.advance(60_000);
  assert.equal(tunnel.isEstablished, true, 'a resolved probe cannot later tear down the connection');
});

test('a status request fails five seconds after authenticated inbound progress stops', async t => {
  const { client, daemon, tunnel } = await connected();
  daemon.goSilent();
  const clock = requestClock(t);
  let settled = false;
  const pending = client.status();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ControlError && error.reason === 'timeout');
  clock.advance(4_000);
  await deliverBody(daemon, tunnel);
  clock.advance(4_999);
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(1);
  await rejected;
  assert.equal(tunnel.isEstablished, true);
});

test('unrelated authenticated traffic cannot extend a status request beyond sixty seconds', async t => {
  const { client, daemon, tunnel } = await connected();
  daemon.goSilent();
  const clock = requestClock(t);
  let settled = false;
  const pending = client.status();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ControlError && error.reason === 'timeout');
  for (let elapsed = 0; elapsed < 56_000; elapsed += 4_000) {
    clock.advance(4_000);
    await deliverBody(daemon, tunnel);
    assert.equal(settled, false);
  }
  clock.advance(3_999);
  await deliverBody(daemon, tunnel);
  assert.equal(settled, false, 'a recent valid frame is not a reply to this status request');
  clock.advance(1);
  await rejected;
});

test('a dropped carrier immediately rejects a status request whose deadline was extended', async t => {
  const { client, daemon, tunnel } = await connected();
  daemon.goSilent();
  const clock = requestClock(t);
  const pending = client.status();
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ControlError && error.reason === 'disconnected');
  clock.advance(4_000);
  await deliverBody(daemon, tunnel);
  clock.advance(2_000);
  daemon.drop();
  await rejected;
  clock.advance(60_000);
  await assert.rejects(client.status(), (error: unknown) => error instanceof ControlError && error.reason === 'disconnected');
});

test('inbound progress does not change lifecycle or crash-report deadlines', async t => {
  const { client, daemon, tunnel } = await connected();
  daemon.goSilent();
  const clock = requestClock(t);
  const command = assert.rejects(client.command('restart'), (error: unknown) =>
    error instanceof ControlError && error.reason === 'timeout' && /30000ms/u.test(error.message));
  const report = assert.rejects(client.reportCrash(crashReport(emptyHealth(), 'ready', { now: 1, userAgent: 'x' })), (error: unknown) =>
    error instanceof ControlError && error.reason === 'timeout' && /5000ms/u.test(error.message));
  for (let elapsed = 1_000; elapsed <= 30_000; elapsed += 1_000) {
    clock.advance(1_000);
    if (elapsed % 4_000 === 0) await deliverBody(daemon, tunnel);
    if (elapsed === 5_000) await report;
  }
  await command;
});

test('concurrent requests are matched to their own replies', async () => {
  // Correlation ids exist because a page issues a status poll and a command at the same time;
  // a client that matched by arrival order would hand one caller the other's answer.
  const { client } = await connected();
  const [first, second] = await Promise.all([client.status(), client.command('start')]);
  assert.equal(first.pid, 4242);
  assert.equal(second.state, 'running');
});

test('the sentences name what is actually wrong', async () => {
  // Failure transparency is a product requirement, and it is only true if the words differ.
  const { client, daemon } = await connected();
  daemon.setStatus('starting', 'connected');
  assert.match(describe(await client.status()), /starting/);
  daemon.setStatus('stopped', 'connected');
  assert.equal(describe(await client.status()), 'DSH is stopped');
  daemon.setStatus('failed', 'connected', { last_error: 'the port is in use' });
  assert.match(describe(await client.status()), /port is in use/);
  // Attach mode is not a failure and must not read like one.
  daemon.setStatus('attached', 'connected');
  assert.match(describe(await client.status()), /started outside this daemon/);

  // The relay states are four different sentences, because they are four different problems.
  const sentences = new Set(
    (['connected', 'reconnecting', 'rejected', 'unreachable'] as RelayHealth[]).map(describeRelay),
  );
  assert.equal(sentences.size, 4, 'each relay state must have its own words');
});

test('a crash report reaches the daemon with the fields it enforces, and nothing else', async () => {
  const { client, daemon } = await connected();
  const health = emptyHealth();
  recordFailure(health, 'TypeError: x is not a function');
  health.errors = 1;
  const report = crashReport(health, 'connecting', { now: 1_700_000_000_000, userAgent: 'Mozilla/5.0' });

  const outcome = await client.reportCrash(report);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.stored, 1);

  const received = daemon.crashReports[0];
  assert.ok(received !== undefined, 'the daemon received one report');
  // The body is the report and only the report: a field the daemon would refuse is a field the
  // client must not invent, and this is the assertion that keeps the two in step.
  assert.deepEqual(Object.keys(received).sort(), [
    'at_ms',
    'client',
    'errors',
    'phase',
    'reached_ready',
    'rejections',
    'samples',
    'user_agent',
  ]);
  assert.deepEqual(received['samples'], ['TypeError: x is not a function']);
  assert.equal(received['phase'], 'connecting');
  assert.equal(received['reached_ready'], false);
});

test('a refusal from the daemon is reported rather than swallowed', async () => {
  const { client, daemon } = await connected();
  daemon.setProblem('the daemon already holds 20 crash reports');
  // A refused report arrives as a `problem`, not a `crash_report_result`: the client must raise
  // rather than report success for a report nobody kept.
  await assert.rejects(
    client.reportCrash(crashReport(emptyHealth(), 'ready', { now: 1, userAgent: 'x' })),
    (error: unknown) =>
      error instanceof ControlError &&
      error.reason === 'refused' &&
      error.message.includes('20 crash reports'),
  );
});
