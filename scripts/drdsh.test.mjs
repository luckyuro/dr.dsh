import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse, validateConfig } from './drdsh.mjs';
import { componentArguments, componentHelp } from './component-cli.mjs';
import { paths, renderService, serviceSpec, shellQuote, systemdQuote } from './service-manager.mjs';

function configuration() {
  return { version: 1, prefix: '/tmp/dr dsh & % $test', source: '/repo', relay: 'wss://relay.example',
    port: 3080, bind: '[::1]:8787', dsh: '/opt/a b/dsh', dshHome: '/home/alice/.dsh', workdir: '/projects/a b',
    state: '/private/state', path: '/opt/a b:/usr/bin:/bin', components: ['daemon', 'relay', 'client'] };
}

test('rejects misspelled, duplicated and irrelevant options before changing services', () => {
  for (const args of [ ['restart', 'daemon', '--relay', 'wss://elsewhere'], ['install', '--port'],
    ['install', '--prefix', '/one', '--prefix', '/two'], ['logs', 'all'], ['restart', 'daemon', 'extra'],
    ['devices', '--clear'], ['install', '--start', '--stat'], ['pair', 'daemon'] ]) {
    assert.throws(() => parse(args));
  }
  assert.deepEqual(parse(['restart', 'client', '--prefix', '/tmp/custom']), {
    action: 'restart', component: 'client', options: { prefix: '/tmp/custom' },
  });
  assert.equal(parse(['install', 'all', '--with-plugin', '--start']).options['with-plugin'], true);
});

test('configuration rejects credentials, invalid ports and malformed local paths', () => {
  for (const patch of [ { relay: 'https://example.com' }, { relay: 'wss://user:secret@example.com' },
    { relay: 'ws://example.com/?token=secret' }, { relay: 'ws://example.com/ws/daemon' }, { bind: 'localhost:8787' },
    { bind: '127.0.0.1:0' }, { port: 65536 }, { port: '12.5' }, { state: 'relative' },
    { path: '/bin\nInjected=1' }, { dsh: '/bin/dsh\nInjected=1' }, { dsh: null },
    { relay: 'ws://example.com\n/' }, { components: ['unknown'] } ]) {
    assert.throws(() => validateConfig({ ...configuration(), ...patch }));
  }
  assert.equal(validateConfig(configuration()).bind, '[::1]:8787');
});

test('launchers pass shell metacharacters as literal path bytes', () => {
  const value = "space ' quote $(printf INJECTED) `printf INJECTED` $HOME & % \\\t";
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, value);
});

test('service definitions keep state and executable paths explicit without including keys', () => {
  const c = configuration();
  const plist = renderService(c, 'daemon', 'darwin');
  assert.match(plist, /DSHD_STATE_DIR<\/key><string>\/private\/state/);
  assert.match(plist, /DSHD_DSH<\/key><string>\/opt\/a b\/dsh/);
  assert.match(plist, /dr dsh &amp; % \$test/);
  const unit = renderService(c, 'daemon', 'linux');
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /ExecStart=:/);
  assert.match(unit, /dr dsh & %% \$test/);
  assert.match(unit, /"--chdir" "\/projects\/a b"/);
  assert.equal(systemdQuote('$HOME/%h/"'), '"$HOME/%%h/\\""');
  for (const text of [plist, unit]) {
    assert.doesNotMatch(text, /--room-key|DSHD_ROOM_KEY|attach-token|sudo/);
  }
  const relay = renderService(c, 'relay', 'linux');
  assert.doesNotMatch(relay, /DSHD_|DSH_HOME/);
  assert.match(relay, /DSH_RELAY_CLIENT_DIR=/);
  assert.notEqual(serviceSpec(c, 'daemon').name, serviceSpec({ ...c, prefix: '/other' }, 'daemon').name);
});

test('component commands reject operations and settings belonging to the other component', () => {
  for (const argv of [['pair'], ['devices'], ['install', 'plugin'], ['install', '--dsh', '/bin/dsh'],
    ['install', '--state-dir', '/state'], ['install', '--with-plugin'], ['restart', 'daemon']]) {
    assert.throws(() => componentArguments('relay', argv));
  }
  for (const argv of [['install', 'relay'], ['install', '--bind', '127.0.0.1:8787'], ['stop', 'relay']]) {
    assert.throws(() => componentArguments('daemon', argv));
  }
  assert.deepEqual(componentArguments('relay', ['install', '--start']), ['install', 'all', '--start']);
  assert.deepEqual(componentArguments('relay', ['install', 'client']), ['install', 'client']);
  assert.deepEqual(componentArguments('daemon', ['install', '--with-plugin']), ['install', 'all', '--with-plugin']);
  assert.deepEqual(componentArguments('daemon', ['pair', '--wait', '20']), ['pair', '--wait', '20']);
  assert.deepEqual(componentArguments('relay', ['logs', '--follow']), ['logs', 'relay', '--follow']);
  assert.doesNotMatch(componentHelp('relay'), /\s--dsh\s|\s--relay\s|ctl pair/);
  assert.doesNotMatch(componentHelp('daemon'), /\s--bind\s/);
  assert.throws(() => parse(['install', 'all', '--with-plugin'], 'relay'));
  assert.throws(() => parse(['install', 'relay'], 'daemon'));
});

test('scoped installations have separate programs, configuration, logs, locks and services', () => {
  const prefix = '/tmp/same prefix';
  const relay = paths(prefix, 'relay');
  const daemon = paths(prefix, 'daemon');
  const legacy = paths(prefix);
  for (const key of ['root', 'bin', 'config', 'logs', 'services', 'command', 'state']) {
    assert.equal(new Set([relay[key], daemon[key], legacy[key]]).size, 3, key);
  }
  const c = configuration();
  assert.notEqual(serviceSpec(c, 'daemon').name, serviceSpec({ ...c, scope: 'daemon' }, 'daemon').name);
  assert.notEqual(serviceSpec(c, 'relay').name, serviceSpec({ ...c, scope: 'relay' }, 'relay').name);
});

test('relay configuration and services work without any DSH settings or state directory', () => {
  const relay = { version: 1, scope: 'relay', prefix: '/tmp/relay', source: '/repo',
    bind: '127.0.0.1:8787', components: ['relay', 'client'] };
  validateConfig(relay);
  for (const platform of ['darwin', 'linux']) {
    const rendered = renderService(relay, 'relay', platform);
    assert.doesNotMatch(rendered, /DSHD_|DSH_HOME|undefined|\/projects|room-key/);
    assert.match(rendered, /\/lib\/dr\.dsh\/relay\/bin\/drdsh-relay/);
  }
  assert.throws(() => validateConfig({ ...relay, components: ['relay', 'daemon'] }));
  const daemon = { ...configuration(), scope: 'daemon', components: ['daemon'] };
  delete daemon.bind;
  validateConfig(daemon);
  assert.throws(() => validateConfig({ ...daemon, components: ['daemon', 'client'] }));
  const legacy = configuration();
  assert.equal(renderService(legacy, 'relay'), renderService({ ...legacy, dsh: '/another/dsh',
    state: '/another/state', path: '/another/bin', workdir: '/another/project' }, 'relay'));
});
