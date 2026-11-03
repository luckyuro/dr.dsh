import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayOrigin, startNativeCompanion } from './companion.ts';

test('standalone relay configuration accepts origins and never includes secrets in rejection errors', () => {
  for (const scheme of ['http', 'https', 'ws', 'wss']) {
    assert.equal(relayOrigin(`${scheme}://relay.example:8443/`), `${scheme}://relay.example:8443`);
  }
  for (const value of ['file:///private', 'https://user:private@relay.example', 'wss://relay.example/ws/daemon',
    'https://relay.example?token=private', 'https://relay.example#private', undefined]) {
    assert.throws(() => relayOrigin(value), error => error instanceof Error && !error.message.includes('private'));
  }
});

async function fixture(response: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'drdsh-companion-test-'));
  const script = join(root, 'native.mjs');
  const binary = join(root, 'native');
  const record = join(root, 'request.json');
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(script, `import {writeFileSync} from 'node:fs';
let pending='';
process.stdin.on('data', chunk=>{
  pending+=chunk;
  if(!pending.includes('\\n'))return;
  const request=JSON.parse(pending.split('\\n')[0]);
  writeFileSync(${JSON.stringify(record)},JSON.stringify({request,args:process.argv.slice(2),pid:process.pid,insecure:process.env.DRDSH_TLS_INSECURE??null,modelCredential:process.env.DEEPSEEK_API_KEY??null}),{mode:0o600});
  console.log('safe native startup diagnostic');
  console.log(JSON.stringify(${JSON.stringify(response)}));
});
process.stdin.on('end',()=>process.exit(0));
`);
  await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
  return { root, binary, record, async close() { await rm(root, { recursive: true, force: true }); } };
}

const ready = { version: 1, ready: true, reportUrl: 'http://127.0.0.1:12345', reportToken: 'r'.repeat(43), roomId: 'a'.repeat(22) };

test('native credentials travel over stdin and abort reaps the child without an unexpected-exit notice', async () => {
  const app = await fixture(ready);
  const controller = new AbortController();
  let unexpected = 0;
  const previousInsecure = process.env.DRDSH_TLS_INSECURE;
  const previousModelKey = process.env.DEEPSEEK_API_KEY;
  process.env.DRDSH_TLS_INSECURE = '1';
  process.env.DEEPSEEK_API_KEY = 'private-model-key';
  try {
    const connection = await startNativeCompanion({ binary: app.binary, relayUrl: 'wss://relay.example', stateDir: app.root,
      port: 3080, token: 'private-launch-token', signal: controller.signal, onExit() { unexpected++; } });
    const recorded = JSON.parse(await readFile(app.record, 'utf8')) as { request: Record<string, unknown>; args: string[]; pid: number; insecure: unknown; modelCredential: unknown };
    assert.deepEqual(recorded.args, ['daemon', 'plugin-connect']);
    assert.equal(recorded.request.token, 'private-launch-token');
    assert.equal(recorded.insecure, null);
    assert.equal(recorded.modelCredential, null);
    assert.equal(connection.reportToken, ready.reportToken);
    assert.doesNotThrow(() => process.kill(recorded.pid, 0));
    controller.abort();
    await connection.stop();
    assert.throws(() => process.kill(recorded.pid, 0));
    assert.equal(unexpected, 0);
  } finally {
    if (previousInsecure === undefined) delete process.env.DRDSH_TLS_INSECURE;
    else process.env.DRDSH_TLS_INSECURE = previousInsecure;
    if (previousModelKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousModelKey;
    controller.abort(); await app.close();
  }
});

test('a native receiver outside loopback fails closed without echoing its payload', async () => {
  const app = await fixture({ ...ready, reportUrl: 'https://private.example/report?token=private' });
  const controller = new AbortController();
  try {
    await assert.rejects(startNativeCompanion({ binary: app.binary, relayUrl: 'wss://relay.example', stateDir: app.root,
      port: 3080, token: 'private-launch-token', signal: controller.signal, onExit() {} }),
    error => error instanceof Error && !error.message.includes('private'));
  } finally { controller.abort(); await app.close(); }
});
