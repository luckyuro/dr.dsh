/**
 * A managed DSH stand-in that mounts the real plugin, used only by the notification smoke.
 * Commands cross private files so the test does not add another unauthenticated HTTP endpoint
 * or copy the daemon's report credential out of its managed process.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../../plugins/dr.dsh/src/index.ts';

if (process.argv.includes('--dump-config')) { console.log('[]'); process.exit(0); }

const scratch = process.env.DRDSH_NOTIFICATION_SMOKE_DIR;
if (!scratch) throw new Error('notification fixture requires its private scratch directory');
const commandPath = join(scratch, 'command.json');
const resultPath = join(scratch, 'result.json');
const readyPath = join(scratch, 'fixture.json');
const listeners = new Map();
const disposers = [];
const context = {
  effect(factory) { disposers.push(factory()); },
  on(event, listener) {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return () => set.delete(listener);
  },
};
apply(context);

function writePrivate(path, value) {
  writeFileSync(`${path}.next`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.next`, path);
}
function readCommand() {
  return existsSync(commandPath) ? JSON.parse(readFileSync(commandPath, 'utf8')) : null;
}
let lastCommand = readCommand()?.id ?? 0;

const daemonUrl = process.env.DRDSH_REPORT_URL;
const token = process.env.DRDSH_REPORT_TOKEN;
writePrivate(readyPath, {
  pid: process.pid,
  configured: Boolean(daemonUrl && token),
  loopback: daemonUrl ? new URL(daemonUrl).hostname === '127.0.0.1' : false,
  credentialPresent: typeof token === 'string' && token.length >= 32,
  subscriptions: [...listeners.values()].reduce((count, set) => count + set.size, 0),
});

async function probe(variant) {
  if (!daemonUrl || !token) return { unavailable: true };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const report = { event: 'turn_complete', severity: 'notice', atMs: Date.now(), sessionRef: 'smoke-session' };
  if (variant === 'missing-auth') delete headers.authorization;
  if (variant === 'wrong-auth') headers.authorization = 'Bearer not-the-managed-process-credential';
  if (variant === 'browser-origin') headers.origin = 'http://127.0.0.1';
  if (variant === 'content-type') headers['content-type'] = 'text/plain';
  if (variant === 'extra-field') report.text = 'notification-private-sentinel';
  if (variant === 'oversized') report.sessionRef = 'x'.repeat(4096);
  if (variant === 'severity') report.severity = 'alert';
  if (variant === 'session') report.sessionRef = '/private/notification-path-sentinel';
  const response = await fetch(new URL('/report', daemonUrl), {
    method: 'POST', headers, body: JSON.stringify(report), redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  return { status: response.status };
}

async function emit(event) {
  const session = { id: 'smoke-session', title: 'notification-private-sentinel' };
  const agent = { session };
  let continued = false;
  const args = event === 'session/event' ? [session, { type: 'turn/end', text: 'notification-private-sentinel' }]
    : event === 'goal/changed' ? [{ agent, change: { operation: 'complete' }, text: 'notification-private-sentinel' }]
      : event === 'subagent/end' ? [{ id: session.id, result: 'notification-private-sentinel' }]
        : [{ agent, text: 'notification-private-sentinel', path: '/private/notification-path-sentinel' }, () => { continued = true; }];
  for (const listener of listeners.get(event) ?? []) await listener(...args);
  return { continued, invoked: listeners.get(event)?.size ?? 0 };
}

let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  const command = readCommand();
  if (!command || command.id <= lastCommand) return;
  busy = true;
  lastCommand = command.id;
  try {
    const result = command.op === 'probe' ? await probe(command.variant) : await emit(command.event);
    writePrivate(resultPath, { id: command.id, ...result });
  } catch {
    // Never serialize errors from requests: a future transport error might include credentials.
    writePrivate(resultPath, { id: command.id, failed: true });
  } finally { busy = false; }
}, 40);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(timer);
  for (const dispose of disposers) dispose();
});

const portIndex = process.argv.indexOf('--port');
process.argv[2] = process.argv[portIndex + 1];
await import('../../crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs');
