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
import { afterEach, test } from 'node:test';

import { ControlClient, ControlError, describe, describeRelay } from './control.ts';
import type { LifecycleState, RelayHealth } from './control.ts';
import { crashReport, emptyHealth, recordFailure } from './health.ts';
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
    if (silent) return;

    const request = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    requests.push(request);
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
async function connected(): Promise<{ client: ControlClient; daemon: StandIn }> {
  const daemon = await standIn();
  const tunnel = await Tunnel.open(daemon.socket, ROOT);
  opened.push(tunnel);
  const client = new ControlClient(tunnel);
  clients.push(client);
  return { client, daemon };
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
  const { client, daemon } = await connected();
  daemon.goSilent();
  await assert.rejects(
    client.status(),
    (error: unknown) =>
      error instanceof ControlError &&
      (error.reason === 'timeout' || error.reason === 'disconnected'),
  );
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
