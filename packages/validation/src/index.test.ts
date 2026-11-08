import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSchemas, fieldErrors, schemas, validateCapability, validateConfiguration, validateCredential, validatePort, validateRelay } from './index.js';

test('relay validation rejects credentials, hidden syntax and non-origin endpoints without echoing secrets', () => {
  for (const input of ['https://relay.example', 'wss:relay.example', 'ws:///relay.example', 'wss://user:PRIVATE@relay.example', 'wss://relay.example/ws', 'wss://relay.example?', 'wss://relay.example#', 'ws://relay.example/../', 'wss://relay.example\\', 'ws://relay.exa\tmple', 'ws://relay.example:70000']) {
    const result = validateRelay(input);
    assert.ok(result.issues, input);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  for (const input of ['ws://127.0.0.1:8787', 'wss://relay.example/', 'ws://[::1]:8787']) assert.equal(validateRelay(input).issues, undefined);
});

test('decimal ports normalize without accepting JavaScript coercion tricks', () => {
  assert.deepEqual(validatePort(' 3080 '), { value: 3080 });
  for (const input of ['', '0x50', '1e3', '2.5', true, null, NaN, Infinity, [], 0, 65536]) assert.ok(validatePort(input).issues, String(input));
});

test('configuration returns all field errors and leaves the caller input untouched', () => {
  const value = { relay: 'https://relay.example', port: '0', workdir: 'relative', caCert: '/bad\npath' };
  const result = validateConfiguration(value, 'zh-CN');
  assert.deepEqual(Object.keys(fieldErrors(result)), ['relay', 'port', 'workdir', 'caCert']);
  assert.equal(value.port, '0');
  assert.match(fieldErrors(result).port!, /整数/u);
  assert.deepEqual(validateConfiguration({ relay: ' wss://relay.example ', port: '3080', workdir: '', caCert: null }), { value: { relay: 'wss://relay.example', port: 3080, caCert: null } });
  for (const input of [null, [], { relay: 'ws://localhost', port: 3080, command: 'PRIVATE' }, { relay: 'ws://localhost', port: 3080, tlsInsecure: 'true' }]) {
    const failed = validateConfiguration(input);
    assert.ok(failed.issues);
    assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  }
});

test('capabilities and pairing codes have separate shapes; errors never expose input', () => {
  assert.ok(validateCapability('ABCD-EFGH-JK').issues);
  assert.deepEqual(validateCapability(` ${'x'.repeat(43)}\n`), { value: 'x'.repeat(43) });
  assert.deepEqual(validateCredential(' iLoU-abcd-23 '), { value: { kind: 'code', code: '110V-ABCD-23' } });
  assert.deepEqual(validateCredential('x'.repeat(43)), { value: { kind: 'roomKey', roomKey: 'x'.repeat(43) } });
  const result = validateCredential('PRIVATE-INVALID-CODE');
  assert.ok(result.issues);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('Standard Schema interface returns normalized values and paths for independent consumers', async () => {
  const spec = schemas.configuration['~standard'];
  assert.equal(spec.version, 1);
  assert.equal(spec.vendor, 'dr.dsh');
  assert.deepEqual(await spec.validate({ relay: 'wss://relay.example', port: '3080' }), { value: { relay: 'wss://relay.example', port: 3080 } });
  const result = await createSchemas('zh-CN').configuration['~standard'].validate({ relay: 'bad', port: 0 });
  assert.deepEqual(result.issues?.map(issue => issue.path), [['relay'], ['port']]);
  assert.match(result.issues![0]!.message, /中继/u);
  assert.equal(Object.getPrototypeOf(fieldErrors(result)), null);
});
