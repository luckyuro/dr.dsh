#!/usr/bin/env node
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { atomicWrite, inherit, managerAvailable, paths, prepareService, serviceSpec, serviceState,
  setAutostart, shellQuote, showLogs, startService, stopService } from './service-manager.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = ['daemon', 'relay', 'client', 'plugin'];
const ACTIONS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'enable', 'disable', 'pair', 'doctor', 'devices', 'audit', 'crashes'];
const DAEMON_ACTIONS = ['pair', 'doctor', 'devices', 'audit', 'crashes'];
const SCOPES = { relay: ['relay', 'client'], daemon: ['daemon', 'plugin'] };
const HELP = `drdsh — install and manage dr.dsh (macOS / Linux; Windows via systemd-enabled WSL2)

  drdsh install [all|daemon|relay|client|plugin] [options]
  drdsh start|stop|restart|status|enable|disable [all|daemon|relay|client|plugin]
  drdsh logs [daemon|relay] [--follow]
  drdsh uninstall [all|daemon|relay|client|plugin]
  drdsh pair [--wait <seconds>]
  drdsh doctor | devices [--revoke <id>] | audit [--clear] | crashes [--clear]

Install options:
  --prefix <path>       install prefix (default ~/.local; isolated services per prefix)
  --source <checkout>   source checkout (remembered for subsequent installs/updates)
  --relay <ws[s]://url> daemon's relay (default ws://127.0.0.1:8787)
  --dsh <executable>    DSH executable (default: find dsh on PATH)
  --dsh-home <path>     DSH home (default DSH_HOME or ~/.dsh)
  --workdir <path>      working directory for DSH (default current directory)
  --port <1..65535>     DSH loopback port (default 3080)
  --bind <ip:port>      relay listen address (default 127.0.0.1:8787)
  --state-dir <path>    daemon state (default DSHD_STATE_DIR or <prefix>/share/dr.dsh)
  --with-plugin        include the optional plugin when installing all
  --start              start installed services after installation
  --enable             enable login autostart after installation
  --skip-build         install existing local build outputs (no downloads/builds)
  --build-profile <release|debug>  default release

all installs daemon + relay + client. relay includes client; client/plugin have no separate process.
client lifecycle commands use relay; plugin lifecycle commands use daemon's DSH web profile.
install preserves settings unless overridden. uninstall preserves configuration, keys and logs.
--prefix works for every command. No services start or gain autostart without an explicit flag.
`;

export function parse(argv, scope) {
  if (scope !== undefined && !Object.hasOwn(SCOPES, scope)) throw new Error('Installation scope must be relay or daemon.');
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const action = argv[0];
  if (!ACTIONS.includes(action)) throw new Error(`Unknown command ${action}; run drdsh --help.`);
  const values = new Set(['prefix', 'source', 'relay', 'dsh', 'dsh-home', 'workdir', 'port', 'bind', 'state-dir', 'build-profile', 'wait', 'revoke']);
  const switches = new Set(['start', 'enable', 'with-plugin', 'skip-build', 'follow', 'clear']);
  const options = {};
  let component;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') && component === undefined) { component = arg; continue; }
    const key = arg.slice(2);
    if (!arg.startsWith('--') || (!values.has(key) && !switches.has(key))) throw new Error(`Unknown option ${arg}; run drdsh --help.`);
    if (Object.hasOwn(options, key)) throw new Error(`Repeated option ${arg}; specify it once.`);
    if (switches.has(key)) options[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--') || /[\0\r\n]/u.test(value)) throw new Error(`${arg} needs a value without line breaks.`);
      options[key] = value;
    }
  }
  const allowed = new Set(['prefix']);
  if (action === 'install') for (const key of [...values, ...switches]) {
    if (!['wait', 'revoke', 'follow', 'clear'].includes(key)) allowed.add(key);
  }
  if (action === 'logs') allowed.add('follow');
  if (action === 'pair') allowed.add('wait');
  if (action === 'devices') allowed.add('revoke');
  if (['audit', 'crashes'].includes(action)) allowed.add('clear');
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`--${key} is not supported by ${action}.`);
  if (['pair', 'doctor', 'devices', 'audit', 'crashes'].includes(action)) {
    if (component !== undefined) throw new Error(`${action} does not take a component.`);
  } else {
    component ??= action === 'logs' ? 'daemon' : 'all';
    if (![...COMPONENTS, 'all'].includes(component)) throw new Error(`Unknown component ${component}; choose all, daemon, relay, client or plugin.`);
    if (action === 'logs' && component === 'all') throw new Error('Choose daemon or relay for logs.');
  }
  if (options['with-plugin'] && component !== 'all') throw new Error('--with-plugin is only needed with install all.');
  if (scope && ((component && component !== 'all' && !SCOPES[scope].includes(component)) || (scope === 'relay' && DAEMON_ACTIONS.includes(action)))) {
    throw new Error(`The ${scope} installation cannot run ${action}${component ? ` ${component}` : ''}; use the other component's command.`);
  }
  if (action === 'install') {
    const owner = scope ?? Object.keys(SCOPES).find(name => SCOPES[name].includes(component));
    const irrelevant = owner === 'relay' ? ['relay', 'dsh', 'dsh-home', 'workdir', 'port', 'state-dir', 'with-plugin']
      : owner === 'daemon' ? ['bind'] : [];
    for (const key of irrelevant) if (Object.hasOwn(options, key)) throw new Error(`--${key} does not configure ${owner}; use the other component's install command.`);
  }
  return { action, component, options };
}

function executable(value) {
  const candidates = value.includes('/') ? [resolve(value)] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, value));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  throw new Error(`Cannot find executable ${value}. Install it first and add its directory to PATH (for DSH, --dsh accepts an absolute path).`);
}

function integer(value, name, maximum = 65535) {
  if (!/^\d+$/u.test(String(value)) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return Number(value);
}

export function validateConfig(config) {
  if (config.version !== 1) throw new Error('Unsupported installation configuration version; use the matching drdsh installer.');
  if (config.scope !== undefined && !Object.hasOwn(SCOPES, config.scope)) throw new Error('Invalid installation scope; expected relay or daemon.');
  const daemonConfig = config.scope !== 'relay';
  for (const key of ['prefix', 'source', ...(daemonConfig ? ['state', 'dshHome', 'workdir'] : [])]) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key]) || /[\0\r\n]/u.test(config[key])) throw new Error(`Configuration ${key} must be an absolute path without line breaks.`);
  }
  if (daemonConfig) {
    if (typeof config.path !== 'string' || /[\0\r\n]/u.test(config.path)) throw new Error('Configuration PATH must be a string without line breaks.');
    if (config.dsh !== null && (typeof config.dsh !== 'string' || !isAbsolute(config.dsh) || /[\0\r\n]/u.test(config.dsh))) throw new Error('Configuration dsh must be an absolute executable path.');
    let url;
    if (typeof config.relay !== 'string' || /[\0\r\n]/u.test(config.relay)) throw new Error('Relay URL must be a string without line breaks.');
    try { url = new URL(config.relay); } catch { throw new Error('Relay must be an absolute ws:// or wss:// URL.'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Relay must be a ws:// or wss:// origin, without credentials, query, fragment or path.');
    }
    config.port = integer(config.port, 'DSH port');
  }
  if (config.scope !== 'daemon') {
    const match = typeof config.bind === 'string' && config.bind.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u);
    if (!match || !isIP(match[1] ?? match[2])) throw new Error('Relay bind must be an IP address and port, such as 127.0.0.1:8787 or [::1]:8787.');
    integer(match[3], 'Relay port');
  }
  if (!Array.isArray(config.components) || config.components.some(c => !COMPONENTS.includes(c))) throw new Error('Invalid installed component list in configuration.');
  if (config.scope && config.components.some(c => !SCOPES[config.scope].includes(c))) throw new Error(`The ${config.scope} configuration contains components from the other installation; repair its component list.`);
  if (config.components.some(c => ['daemon', 'plugin'].includes(c)) && !config.dsh) throw new Error('Daemon/plugin configuration requires an absolute DSH executable path; reinstall with --dsh <path>.');
  return config;
}

function readConfig(p) {
  if (!existsSync(p.config)) throw new Error(`No installation at ${p.prefix}; run sh install.sh first or choose the correct --prefix.`);
  let config;
  try { config = JSON.parse(readFileSync(p.config, 'utf8')); } catch { throw new Error(`Cannot read ${p.config}; repair the JSON configuration before continuing.`); }
  validateConfig(config);
  if (config.scope !== p.scope) throw new Error('Configuration scope does not match this command; use the matching relay or daemon command.');
  if (resolve(config.prefix) !== p.prefix) throw new Error('Installation prefix does not match its configuration; use the original prefix or reinstall.');
  return config;
}

function saveConfig(p, config) { atomicWrite(p.config, `${JSON.stringify(config, null, 2)}\n`); }

function selected(component, config) {
  if (component === 'all') return config.components;
  return [component];
}

function services(components) {
  return ['relay', 'daemon'].filter(name => components.some(c => (c === 'client' ? 'relay' : c === 'plugin' ? 'daemon' : c) === name));
}

function requireInstalled(config, component) {
  if (!config.components.includes(component)) throw new Error(`${component} is not installed; run drdsh install ${component}.`);
}

async function pluginCommand(config, verb) {
  if (!config.dsh) throw new Error('Plugin installation requires DSH; install DSH first, then use --dsh <path>.');
  const spec = verb === 'add' ? join(paths(config.prefix, config.scope).root, 'plugin') : '@dr.dsh/dsh-plugin';
  await inherit(config.dsh, ['plugin', '--profile', 'web', verb, spec], {
    cwd: config.workdir, env: { ...process.env, PATH: config.path, DSH_HOME: config.dshHome },
  });
}

function promote(source, destination) {
  const temporary = `${destination}.${process.pid}.new`;
  const backup = `${destination}.${process.pid}.old`;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    cpSync(source, temporary, { recursive: true });
    if (existsSync(destination)) renameSync(destination, backup);
    try { renameSync(temporary, destination); } catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
    rmSync(backup, { force: true, recursive: true });
  }
}

async function install(component, options, p) {
  const previous = existsSync(p.config) ? readConfig(p) : null;
  const source = resolve(options.source ?? previous?.source ?? join(HERE, '..'));
  const list = component === 'all' ? [...(p.scope === 'relay' ? ['relay', 'client'] : p.scope === 'daemon' ? ['daemon'] : ['daemon', 'relay', 'client']), ...(options['with-plugin'] ? ['plugin'] : [])]
    : component === 'relay' ? ['relay', 'client'] : [component];
  const config = {
    version: 1, prefix: p.prefix, ...(p.scope ? { scope: p.scope } : {}), source,
    relay: options.relay ?? previous?.relay ?? 'ws://127.0.0.1:8787',
    port: options.port ?? previous?.port ?? 3080, bind: options.bind ?? previous?.bind ?? '127.0.0.1:8787',
    dsh: options.dsh ? executable(options.dsh) : previous?.dsh ?? (list.some(c => ['daemon', 'plugin'].includes(c)) ? executable('dsh') : null),
    dshHome: resolve(options['dsh-home'] ?? previous?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    workdir: resolve(options.workdir ?? previous?.workdir ?? process.cwd()),
    state: resolve(options['state-dir'] ?? previous?.state ?? process.env.DSHD_STATE_DIR ?? p.state),
    path: previous?.path ?? process.env.PATH ?? '/usr/bin:/bin',
    components: [...new Set([...(previous?.components ?? []), ...list])],
  };
  if (p.scope === 'relay') for (const key of ['relay', 'port', 'dsh', 'dshHome', 'workdir', 'state', 'path']) delete config[key];
  if (p.scope === 'daemon') delete config.bind;
  validateConfig(config);
  if (options.dsh) config.path = `${dirname(config.dsh)}${delimiter}${process.env.PATH ?? config.path}`;
  if (previous?.components.includes('plugin') && previous.dshHome !== config.dshHome) {
    throw new Error('Uninstall plugin before changing --dsh-home, so its registration in the previous DSH home can be removed.');
  }
  if (list.some(c => ['daemon', 'plugin'].includes(c))) executable(config.dsh);
  if (list.some(c => ['daemon', 'plugin'].includes(c)) && !existsSync(config.workdir)) throw new Error(`DSH working directory is missing: ${config.workdir}; choose --workdir.`);
  if (!existsSync(join(source, 'Cargo.toml')) || !existsSync(join(source, 'scripts/drdsh.mjs'))) throw new Error(`Source checkout is missing at ${source}; pass --source <checkout>.`);
  if (!previous) for (const file of ['drdsh', ...list.filter(c => ['daemon', 'relay'].includes(c)).map(c => c === 'daemon' ? 'drdshd' : 'drdsh-relay')]) {
    if (existsSync(join(p.bin, file))) throw new Error(`Refusing to overwrite an existing unmanaged command at ${join(p.bin, file)}; choose another --prefix or move it first.`);
  }
  if (!previous && p.scope && existsSync(p.command)) throw new Error(`Refusing to overwrite an unmanaged command at ${p.command}; choose another --prefix or move it first.`);
  const buildProfile = options['build-profile'] ?? 'release';
  if (!['release', 'debug'].includes(buildProfile)) throw new Error('--build-profile must be release or debug.');
  const binaries = list.filter(c => ['daemon', 'relay'].includes(c));
  if (list.includes('plugin') || (!options['skip-build'] && list.includes('client'))) executable('pnpm');
  if (!options['skip-build'] && binaries.length) executable('cargo');
  if (options.start || options.enable || previous?.components.some(c => ['daemon', 'relay'].includes(c))) managerAvailable();
  console.log(`Installing ${list.join(', ')} into ${p.prefix}`);
  if (!options['skip-build']) {
    if (binaries.length) await inherit('cargo', ['build', '--locked', ...(buildProfile === 'release' ? ['--release'] : []),
      '--target-dir', join(source, 'target'), ...binaries.flatMap(c => ['-p', c === 'daemon' ? 'dr-dsh-daemon' : 'dr-dsh-relay'])], {
      cwd: source, env: { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? 'stable' },
    });
    if (list.includes('client')) {
      await inherit('pnpm', ['install', '--frozen-lockfile', '--filter', '@dr.dsh/pwa...'], { cwd: source });
      await inherit('pnpm', ['--filter', '@dr.dsh/pwa', 'build'], { cwd: source });
    }
  }
  // Validate every source before touching a working installation or stopping a service.
  try {
    for (const file of ['drdsh.mjs', 'service-manager.mjs', ...(p.scope ? ['component-cli.mjs'] : [])]) accessSync(join(source, 'scripts', file), constants.R_OK);
    for (const name of binaries) accessSync(join(source, 'target', buildProfile, name === 'daemon' ? 'drdshd' : 'drdsh-relay'), constants.X_OK);
    if (list.includes('client')) for (const file of ['shell.js', 'service-worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
      accessSync(join(source, 'apps/pwa/dist', file), constants.R_OK);
    }
    if (list.includes('plugin')) accessSync(join(source, 'plugins/dr.dsh/package.json'), constants.R_OK);
  } catch (error) {
    throw new Error(`Build artifact is missing or unreadable: ${error.path}. Run install without --skip-build, or check --source and --build-profile before retrying.`);
  }
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(p.root, '.stage-'));
  const active = [];
  try {
    for (const name of binaries) {
      const binary = name === 'daemon' ? 'drdshd' : 'drdsh-relay';
      cpSync(join(source, 'target', buildProfile, binary), join(staging, binary));
    }
    if (list.includes('client')) cpSync(join(source, 'apps/pwa/dist'), join(staging, 'client'), { recursive: true });
    if (list.includes('plugin')) {
      const dest = join(staging, 'plugin');
      mkdirSync(dest);
      for (const file of ['package.json', 'cordis.patch.yml', 'src']) cpSync(join(source, 'plugins/dr.dsh', file), join(dest, file), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
      delete manifest.devDependencies;
      delete manifest.scripts;
      atomicWrite(join(dest, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    if (previous) for (const name of [...services(list)].reverse()) {
      if (previous.components.includes(name) && serviceState(previous, name).running) {
        await stopService(previous, name); active.push(name);
      }
    }
    for (const name of binaries) {
      const binary = name === 'daemon' ? 'drdshd' : 'drdsh-relay';
      promote(join(staging, binary), join(p.bin, binary));
    }
    for (const name of ['client', 'plugin']) if (list.includes(name)) promote(join(staging, name), join(p.root, name));
    for (const file of ['drdsh.mjs', 'service-manager.mjs', ...(p.scope ? ['component-cli.mjs'] : [])]) promote(join(source, 'scripts', file), join(p.root, file));
    atomicWrite(join(p.bin, 'drdsh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(p.root, 'drdsh.mjs'))} "$@"\n`, 0o755);
    // The launcher carries its prefix so custom installations work from any directory.
    atomicWrite(join(p.root, 'prefix.json'), JSON.stringify(p.scope ? { prefix: p.prefix, scope: p.scope } : p.prefix));
    if (p.scope) atomicWrite(p.command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(p.root, 'component-cli.mjs'))} ${p.scope} "$@"\n`, 0o755);
    saveConfig(p, { ...config, components: config.components.filter(c => c !== 'plugin' || previous?.components.includes(c)) });
    if (list.includes('plugin')) {
      await pluginCommand(config, 'add');
      console.log('plugin: registered in DSH web profile; reports require the daemon report endpoint (not implemented yet)');
    }
    saveConfig(p, config);
    for (const name of services(list)) if (config.components.includes(name)) prepareService(config, name);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    for (const name of active.reverse()) await startService(existsSync(p.config) ? readConfig(p) : previous, name);
  }
  for (const name of services(list)) if (config.components.includes(name)) {
    if (options.enable) setAutostart(config, name, true);
    if (options.start && !active.includes(name)) await startService(config, name);
  }
  console.log(`Installed. Command: ${p.command}\nConfig: ${p.config}\nShell PATH: export PATH=${shellQuote(dirname(p.command))}:"$PATH"`);
}

async function uninstall(config, component) {
  const restartHost = component === 'plugin' && config.components.includes('daemon') && serviceState(config, 'daemon').running;
  if (restartHost) await stopService(config, 'daemon');
  try { await removeComponents(config, component); }
  finally { if (restartHost) await startService(readConfig(paths(config.prefix, config.scope)), 'daemon'); }
}

async function removeComponents(config, component) {
  const p = paths(config.prefix, config.scope);
  const list = component === 'all' ? [...config.components] : component === 'relay' ? ['relay', 'client'] : [component];
  if (list.includes('client') && !list.includes('relay') && config.components.includes('relay')) {
    throw new Error('The installed relay serves this client. Uninstall relay to remove both, or reinstall client to update it.');
  }
  if (list.includes('daemon') && !list.includes('plugin') && config.components.includes('plugin')) {
    throw new Error('Uninstall plugin first, or use uninstall all; the plugin uses daemon configuration.');
  }
  if (list.includes('plugin') && config.components.includes('plugin')) await pluginCommand(config, 'remove');
  for (const name of ['daemon', 'relay']) if (list.includes(name) && config.components.includes(name)) {
    await stopService(config, name);
    setAutostart(config, name, false);
    rmSync(serviceSpec(config, name).file, { force: true });
    rmSync(join(p.bin, name === 'daemon' ? 'drdshd' : 'drdsh-relay'), { force: true });
  }
  for (const name of ['client', 'plugin']) if (list.includes(name)) rmSync(join(p.root, name), { recursive: true, force: true });
  config.components = config.components.filter(c => !list.includes(c));
  saveConfig(p, config);
  if (component === 'all') {
    rmSync(p.command, { force: true });
    rmSync(join(p.bin, 'drdsh'), { force: true });
    for (const file of ['drdsh.mjs', 'service-manager.mjs', 'component-cli.mjs', 'prefix.json']) rmSync(join(p.root, file), { force: true });
  }
  console.log(`Uninstalled: ${list.join(', ')}. Configuration, daemon state and logs retained; run sh install.sh to reinstall.`);
}

async function status(config, names) {
  let ok = true;
  for (const name of names) {
    const state = serviceState(config, name);
    console.log(`${name}: ${state.detail}`);
    if (!state.running) { ok = false; continue; }
    const url = name === 'relay' ? `http://${config.bind.replace(/^0\.0\.0\.0:/u, '127.0.0.1:').replace(/^\[::\]:/u, '[::1]:')}/healthz` : `http://127.0.0.1:${config.port}/`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      const healthy = name === 'relay' ? response.ok : [200, 401, 403].includes(response.status);
      await response.body?.cancel();
      console.log(`  ${name === 'relay' ? 'relay health' : 'DSH HTTP (no authentication check)'}: ${healthy ? 'responding' : `HTTP ${response.status}`}`);
      if (!healthy) ok = false;
    } catch { console.log(`  ${name === 'relay' ? 'relay' : 'DSH'} HTTP: not responding; inspect logs`); ok = false; }
  }
  return ok ? 0 : 1;
}

async function dispatch(parsed, p) {
  const { action, component, options } = parsed;
  if (action === 'install') { await install(component, options, p); return 0; }
  const config = readConfig(p);
  if (['pair', 'doctor', 'devices', 'audit', 'crashes'].includes(action)) {
    requireInstalled(config, 'daemon');
    const args = [action];
    if (action === 'pair') args.push('--relay', config.relay);
    if (action === 'doctor') args.push('--dsh', config.dsh, '--port', String(config.port));
    if (options.wait) args.push('--wait', String(integer(options.wait, '--wait', 86400)));
    if (options.revoke) args.push('--revoke', options.revoke);
    if (options.clear) args.push('--clear');
    await inherit(join(p.bin, 'drdshd'), args, { cwd: config.workdir,
      env: { ...process.env, PATH: config.path, DSHD_DSH: config.dsh, DSHD_STATE_DIR: config.state, DSH_HOME: config.dshHome } });
    return 0;
  }
  managerAvailable();
  if (action === 'uninstall') { await uninstall(config, component); return 0; }
  const chosen = selected(component, config);
  if (chosen.length === 0) throw new Error('No components installed; run drdsh install first.');
  for (const name of chosen) requireInstalled(config, name);
  const names = services(chosen);
  for (const name of names) requireInstalled(config, name);
  if (component === 'client') console.log('client: served by relay; managing relay');
  if (component === 'plugin') console.log('plugin: loaded by DSH web profile; managing daemon and its DSH process');
  if (action === 'status') return await status(config, names);
  if (action === 'logs') { await showLogs(config, names[0], Boolean(options.follow)); return 0; }
  if (action === 'stop' || action === 'restart') for (const name of [...names].reverse()) await stopService(config, name);
  if (action === 'start' || action === 'restart') for (const name of names) await startService(config, name);
  if (action === 'enable' || action === 'disable') for (const name of names) setAutostart(config, name, action === 'enable');
  return 0;
}

export async function main(argv = process.argv.slice(2), scope) {
  const installation = existsSync(join(HERE, 'prefix.json')) ? JSON.parse(readFileSync(join(HERE, 'prefix.json'), 'utf8')) : undefined;
  scope ??= typeof installation === 'object' ? installation.scope : undefined;
  const parsed = parse(argv, scope);
  if (parsed.help) { console.log(HELP); return 0; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || (major === 22 && minor >= 19))) throw new Error('Node.js 22.19+ or 24+ is required; update Node.js first.');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Use macOS, Linux or systemd-enabled WSL2 for this installer.');
  const { action, options } = parsed;
  const defaultPrefix = typeof installation === 'string' ? installation : installation?.prefix ?? join(homedir(), '.local');
  const p = paths(options.prefix ?? defaultPrefix, scope);
  if (!['install', 'uninstall', 'start', 'stop', 'restart', 'enable', 'disable'].includes(action)) return await dispatch(parsed, p);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  const lock = join(p.root, '.operation-lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another installation/service operation holds ${lock}. Wait for it to finish; after a crashed command, remove this empty lock directory before retrying.`);
  }
  try { return await dispatch(parsed, p); } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`drdsh: ${error.message}`); process.exitCode = 1;
  });
}
