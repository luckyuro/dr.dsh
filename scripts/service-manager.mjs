import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function paths(prefix, scope) {
  prefix = resolve(prefix);
  if (scope !== undefined && !['relay', 'daemon'].includes(scope)) throw new Error('Installation scope must be relay or daemon.');
  const root = join(prefix, 'lib/dr.dsh', ...(scope ? [scope] : []));
  const publicBin = join(prefix, 'bin');
  return { prefix, scope, root, bin: scope ? join(root, 'bin') : publicBin,
    command: join(publicBin, scope ? `drdsh-${scope}ctl` : 'drdsh'),
    config: join(prefix, 'etc/dr.dsh', scope ? `${scope}.json` : 'config.json'),
    state: join(prefix, 'share/dr.dsh', ...(scope ? [scope] : [])), logs: join(root, 'logs'), services: join(root, 'services') };
}

export function atomicWrite(file, text, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// None of these strings is a shell command. Each format has its own escaping rules.
export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
export function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
export function systemdQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    .replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;
}

export function execute(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 45_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} failed${result.status === null ? '' : ` (exit ${result.status})`}: `
      + `${result.error?.message ?? result.stderr?.trim() ?? ''}. Check the command and your user service session.`);
  }
  return result.stdout ?? '';
}

export async function inherit(file, args, options = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options });
    child.once('error', error => reject(new Error(`Cannot run ${file}: ${error.message}. Check that it is installed and executable.`)));
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${file} failed (${signal ?? code}); see its output above.`)));
  });
}

export function serviceSpec(config, component, platform = process.platform) {
  const p = paths(config.prefix, config.scope);
  const suffix = createHash('sha256').update(config.scope ? p.root : p.prefix).digest('hex').slice(0, 12);
  const name = platform === 'darwin' ? `dev.drdsh.${component}.${suffix}` : `drdsh-${component}-${suffix}.service`;
  const args = component === 'daemon'
    ? [join(p.bin, 'drdshd'), 'run', '--relay', config.relay, '--port', String(config.port)]
    : [join(p.bin, 'drdsh-relay')];
  const env = { RUST_LOG: 'info' };
  if (component === 'daemon') Object.assign(env, {
    PATH: config.path, DSHD_STATE_DIR: config.state, DSHD_DSH: config.dsh, DSH_HOME: config.dshHome,
  });
  else Object.assign(env, { DSH_RELAY_BIND: config.bind, DSH_RELAY_CLIENT_DIR: join(p.root, 'client') });
  return { name, args, env, cwd: component === 'daemon' ? config.workdir : p.root,
    file: join(p.services, platform === 'darwin' ? `${name}.plist` : name),
    log: join(p.logs, `${component}.log`) };
}

export function renderService(config, component, platform = process.platform) {
  const s = serviceSpec(config, component, platform);
  if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(s.name)}</string>
<key>ProgramArguments</key><array>${s.args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(s.cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(s.env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>35</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(s.log)}</string>
<key>StandardErrorPath</key><string>${xml(s.log)}</string>
</dict></plist>
`;
  if (platform !== 'linux') throw new Error('Automatic services require macOS or Linux with systemd. On Windows, run the installer inside a systemd-enabled WSL2 distribution.');
  // systemd restricts executable names and does not unquote WorkingDirectory.
  // GNU env receives both paths as ordinary arguments; ':' keeps $ literal.
  return `[Unit]
Description=dr.dsh ${component}
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=:/usr/bin/env ${['--chdir', s.cwd, '--', ...s.args].map(systemdQuote).join(' ')}
${Object.entries(s.env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=35
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function prepareService(config, component) {
  const p = paths(config.prefix, config.scope);
  if (component === 'daemon') mkdirSync(config.state, { recursive: true, mode: 0o700 });
  mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  const s = serviceSpec(config, component);
  if (!existsSync(s.log)) writeFileSync(s.log, '', { mode: 0o600 });
  atomicWrite(s.file, renderService(config, component));
  return s;
}

export function managerAvailable() {
  if (process.platform === 'darwin') execute('launchctl', ['print', `gui/${process.getuid()}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  else if (process.platform === 'linux') {
    execute('systemctl', ['--user', 'show-environment'], { stdio: ['ignore', 'ignore', 'pipe'] });
    execute('/usr/bin/env', ['--chdir', '/', '/bin/true']);
  }
  else throw new Error('Service commands support macOS and Linux. Use systemd-enabled WSL2 on Windows.');
}

function target(s) { return `gui/${process.getuid()}/${s.name}`; }

export function serviceState(config, component) {
  const s = serviceSpec(config, component);
  if (process.platform === 'darwin') {
    const result = spawnSync('launchctl', ['print', target(s)], { encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) return { loaded: false, running: false, pid: null, detail: 'stopped' };
    const pid = Number(result.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || null;
    return { loaded: true, running: pid !== null, pid, detail: pid ? `running (pid ${pid})` : 'loaded, no running process; inspect logs' };
  }
  const result = spawnSync('systemctl', ['--user', 'show', s.name, '--property=ActiveState,MainPID,LoadState'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  const values = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
  if ((!values.ActiveState || !values.LoadState) || (result.status !== 0 && values.LoadState !== 'not-found')) {
    throw new Error(`Cannot read ${component} service state: ${result.stderr.trim()}. Check systemctl --user and the user session.`);
  }
  const pid = Number(values.MainPID) || null;
  return { loaded: values.LoadState === 'loaded', running: values.ActiveState === 'active' && pid !== null, failed: values.ActiveState === 'failed',
    pid, detail: `${values.ActiveState}${pid ? ` (pid ${pid})` : ''}` };
}

export async function stopService(config, component) {
  const s = serviceSpec(config, component);
  const state = serviceState(config, component);
  if (process.platform === 'darwin') {
    if (state.loaded) execute('launchctl', ['bootout', target(s)]);
    // bootout can return while SIGTERM cleanup is still running. Never start a replacement yet.
    if (state.pid) {
      const deadline = Date.now() + 40_000;
      for (;;) {
        try { process.kill(state.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() > deadline) throw new Error(`${component} has not stopped; inspect its logs before restarting.`);
        await delay(100);
      }
    }
  } else if (state.loaded || state.running) execute('systemctl', ['--user', 'stop', s.name]);
  console.log(`${component}: stopped`);
}

export async function startService(config, component) {
  const s = prepareService(config, component);
  const before = serviceState(config, component);
  if (before.running) { console.log(`${component}: already running (pid ${before.pid})`); return; }
  if (process.platform === 'darwin') {
    if (before.loaded) execute('launchctl', ['bootout', target(s)]);
    execute('launchctl', ['enable', target(s)]);
    execute('launchctl', ['bootstrap', `gui/${process.getuid()}`, s.file]);
  } else {
    execute('systemctl', ['--user', 'link', s.file]);
    execute('systemctl', ['--user', 'daemon-reload']);
    if (before.failed) execute('systemctl', ['--user', 'reset-failed', s.name]);
    execute('systemctl', ['--user', 'start', s.name]);
  }
  await delay(1000);
  const state = serviceState(config, component);
  const command = config.scope ? `drdsh-${config.scope}ctl` : 'drdsh';
  const selection = config.scope ? '' : ` ${component}`;
  if (!state.running) throw new Error(`${component} did not stay running. Run \`${command} logs${selection}\` to see the startup failure.`);
  console.log(`${component}: ${state.detail}; use ${command} status${selection} to check readiness`);
}

export function setAutostart(config, component, enabled) {
  const s = prepareService(config, component);
  if (process.platform === 'darwin') {
    const link = join(homedir(), 'Library/LaunchAgents', `${s.name}.plist`);
    mkdirSync(dirname(link), { recursive: true });
    let present = false;
    try {
      const stat = lstatSync(link);
      if (!stat.isSymbolicLink() || resolve(dirname(link), readlinkSync(link)) !== s.file) {
        throw new Error(`Refusing to replace an unrelated LaunchAgent at ${link}; move it manually first.`);
      }
      present = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (enabled && !present) symlinkSync(s.file, link);
    if (!enabled && present) rmSync(link);
    if (enabled) execute('launchctl', ['enable', target(s)]);
  } else {
    if (enabled) execute('systemctl', ['--user', 'enable', s.file]);
    else if (serviceState(config, component).loaded) execute('systemctl', ['--user', 'disable', s.name]);
    execute('systemctl', ['--user', 'daemon-reload']);
  }
  console.log(`${component}: login autostart ${enabled ? 'enabled' : 'disabled'}`);
}

export async function showLogs(config, component, follow) {
  const s = serviceSpec(config, component);
  if (process.platform === 'linux') await inherit('journalctl', ['--user', '-u', s.name, '-n', '100', ...(follow ? ['-f'] : ['--no-pager'])]);
  else if (follow || existsSync(s.log)) await inherit('tail', ['-n', '100', ...(follow ? ['-F'] : []), s.log]);
  else console.log('No logs yet; start the service first.');
}
