#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parse } from './drdsh.mjs';

const RELATED = { relay: 'client', daemon: 'plugin' };
const DAEMON_ACTIONS = ['pair', 'doctor', 'devices', 'audit', 'crashes'];

export function componentArguments(scope, argv) {
  if (!Object.hasOwn(RELATED, scope)) throw new Error('Choose relay or daemon.');
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return null;
  const [action, ...rest] = argv;
  let args;
  if (DAEMON_ACTIONS.includes(action)) args = argv;
  else if (['install', 'uninstall'].includes(action)) {
    const explicit = rest[0] && !rest[0].startsWith('-');
    if (explicit && rest[0] !== RELATED[scope]) throw new Error(`Use ${action} for ${scope}, or ${action} ${RELATED[scope]} for its optional component.`);
    args = [action, ...(explicit ? rest : ['all', ...rest])];
  } else args = [action, scope, ...rest];
  parse(args, scope);
  return args;
}

export function componentHelp(scope) {
  if (!Object.hasOwn(RELATED, scope)) throw new Error('Choose relay or daemon.');
  const command = `drdsh-${scope}ctl`;
  return `${command} — install and manage only ${scope}

  ${command} install [${RELATED[scope]}] [options]
  ${command} start|stop|restart|status|enable|disable
  ${command} logs [--follow]
  ${command} uninstall [${RELATED[scope]}]
${scope === 'daemon' ? `  ${command} pair [--wait <seconds>]
  ${command} doctor | devices [--revoke <id>] | audit [--clear] | crashes [--clear]
` : ''}
Install options:
  --prefix <path>       base directory (default ~/.local; separate ${scope} configuration)
  --source <checkout>   source checkout, remembered for updates
${scope === 'relay' ? `  --bind <ip:port>     listen address (default 127.0.0.1:8787)
` : `  --relay <ws://url>    relay address (default ws://127.0.0.1:8787; direct WSS is unavailable)
  --dsh <executable>    DSH executable (default: dsh on PATH)
  --dsh-home <path>     DSH home (default DSH_HOME or ~/.dsh)
  --workdir <path>      DSH working directory (default current directory)
  --port <1..65535>     DSH loopback port (default 3080)
  --state-dir <path>    pairing keys, registry, audit and crash records
  --with-plugin        include the optional DSH plugin
`}  --start              start after installation
  --enable             enable login autostart
  --skip-build         install existing build outputs
  --build-profile <release|debug>  default release

--prefix works for every command. Updates affect only ${scope}; uninstall preserves its configuration and data.
${scope === 'relay' ? 'Relay includes PWA files and needs no DSH installation.' : 'Daemon needs DSH and a reachable relay. It does not install a relay or PWA.'}
`;
}

export async function componentMain(scope, argv) {
  const args = componentArguments(scope, argv);
  if (args === null) { console.log(componentHelp(scope)); return 0; }
  return await main(args, scope);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  componentMain(process.argv[2], process.argv.slice(3)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`drdsh-${process.argv[2]}ctl: ${error.message}`); process.exitCode = 1;
  });
}
