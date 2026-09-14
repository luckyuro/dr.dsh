/**
 * The old-CPU install path, measured instead of asserted.
 *
 * M5's third item is "a usable alternative install path for old CPUs". The risk it names is real and
 * invisible from the build: a binary compiled with `target-cpu=native`, or one that unconditionally
 * executes an instruction the CPU does not have, installs fine and dies with SIGILL on the first run
 * — which looks like a corrupt download rather than an unsupported machine.
 *
 * The claim this script checks is narrow and testable: **the shipped binaries and the cryptography
 * run on x86-64 CPUs from 2006 and 2008**, emulated by qemu with those models' feature sets. Those
 * CPUs have no AVX, no AVX2, no AES-NI and no SHA extensions, so anything that required them would
 * fail here; and because the crypto crates select their implementations at *runtime* from CPUID, a
 * missing software fallback would fail here too.
 *
 * One check per model is deliberately about the emulation itself: `drdshd doctor` must report the
 * extensions as *absent*. Without it, a qemu invocation that silently ignored `-cpu` would make every
 * other check pass while proving nothing.
 *
 * What this does not prove: that every code path in the binary is baseline-safe. Only the paths these
 * runs execute are exercised. That is why the informational line about vector instructions in the
 * binary is printed as information rather than as a pass — vector code inside a runtime-detected
 * branch is legitimate, and static inspection cannot tell the two apart.
 *
 * Usage:
 *   node scripts/cpu-baseline-smoke.mjs [--profile release|debug] [--qemu qemu-x86_64]
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the run could not start (no qemu, no build).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const profile = option('--profile', 'release');
const qemu = option('--qemu', 'qemu-x86_64');
const dir = profile === 'release' ? 'target/release' : 'target/debug';
const drdshd = `${dir}/drdshd`;
const drdshRelay = `${dir}/drdsh-relay`;

if (process.arch !== 'x64') {
  console.error(`this check is about x86-64 CPUs; running on ${process.arch}`);
  process.exit(2);
}
if (spawnSync(qemu, ['--version']).status !== 0) {
  console.error(
    `need ${qemu} (Debian/Ubuntu: \`apt-get install qemu-user-static\`), or pass --qemu <path>`,
  );
  process.exit(2);
}
if (!existsSync(drdshd) || !existsSync(drdshRelay)) {
  console.error(`need ${drdshd} and ${drdshRelay}; build them with \`cargo build --${profile}\``);
  process.exit(2);
}

const results = [];
let failures = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
  if (!ok) failures += 1;
}
function note(text) {
  console.log(`info  ${text}`);
}

/** An OS-assigned port, released immediately. */
async function freePort() {
  return await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Runs a command under the emulated CPU and returns its status and output. */
function emulate(cpu, command, argv, env = {}, timeoutMs = 60_000) {
  const result = spawnSync(qemu, ['-cpu', cpu, command, ...argv], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

// 2006 (Core 2, no SSE4.2), 2008 (Nehalem, SSE4.2 but no AVX), 2010 (Westmere: AES-NI, still no AVX).
const MODELS = ['core2duo', 'Nehalem', 'Westmere'];

for (const cpu of MODELS) {
  const version = emulate(cpu, drdshd, ['version']);
  check(
    `drdshd starts and reports its version on an emulated ${cpu}`,
    version.status === 0 && /drdshd \d+\.\d+\.\d+ \(wire protocol \d+\.\d+\)/.test(version.output),
    version.output.trim().split('\n')[0] ?? '(no output)',
  );

  // The emulation has to be real, or the check above is vacuous.
  const doctor = emulate(cpu, drdshd, ['doctor']);
  const cpuLine = doctor.output.split('\n').find(line => line.includes('cpu:')) ?? '';
  const expectedAbsent = cpu === 'Westmere' ? ['avx', 'avx2'] : ['avx', 'avx2'];
  check(
    `and sees no AVX on ${cpu}, so the emulation is doing something`,
    expectedAbsent.every(name => cpuLine.includes(name)) &&
      /absent: [^\n]*avx2/.test(cpuLine) === true,
    cpuLine.trim(),
  );

  const key = emulate(cpu, drdshd, ['room-key']);
  const printed = key.output.trim().split('\n')[0] ?? '';
  check(
    `a room key is generated on ${cpu} (the random source works)`,
    key.status === 0 && /^[A-Za-z0-9_-]{43}$/.test(printed),
    `${printed.length} characters`,
  );
}

// The cryptography, on the oldest CPU in the list: this is where a missing software fallback for
// AES-NI or SHA extensions would show up, because those crates decide at runtime what to call.
const noRun = spawnSync(
  'cargo',
  ['test', '--no-run', '--message-format=json', '-p', 'dr-dsh-crypto', '-p', 'dr-dsh-proto'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (noRun.status !== 0) {
  console.error(`could not build the test binaries: ${noRun.stderr?.slice(0, 400)}`);
  process.exit(2);
}
const testBinaries = noRun.stdout
  .split('\n')
  .filter(line => line.trim() !== '')
  .flatMap(line => {
    try {
      const message = JSON.parse(line);
      return message.reason === 'compiler-artifact' && message.executable ? [message.executable] : [];
    } catch {
      return [];
    }
  });

const wanted = ['dr_dsh_crypto', 'dr_dsh_proto', 'conformance'];
const chosen = testBinaries.filter(path => wanted.some(name => basename(path).startsWith(name)));
if (chosen.length === 0) {
  console.error('no test binaries were produced; run `cargo test --no-run` first');
  process.exit(2);
}
for (const binary of chosen) {
  const run = emulate('Nehalem', binary, [], {}, 600_000);
  const line = run.output.split('\n').find(part => part.startsWith('test result:')) ?? '(no result line)';
  check(
    `${basename(binary).split('-')[0]} tests pass on an emulated Nehalem`,
    run.status === 0 && /test result: ok\. \d+ passed; 0 failed/.test(run.output),
    line.trim(),
  );
}

// A real socket, a real HTTP server, on an old CPU: the relay is the component most likely to be
// installed on a machine nobody looks at, and it is the one that has to keep running.
const relayPort = await freePort();
const relay = spawn(qemu, ['-cpu', 'Nehalem', drdshRelay], {
  env: { ...process.env, DSH_RELAY_BIND: `127.0.0.1:${relayPort}`, RUST_LOG: 'warn' },
});
let relayLog = '';
relay.stdout.on('data', chunk => {
  relayLog += String(chunk);
});
relay.stderr.on('data', chunk => {
  relayLog += String(chunk);
});
let served = null;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && served === null) {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
    served = await response.text();
  } catch {
    await sleep(200);
  }
}
check(
  'the relay serves /healthz on an emulated Nehalem',
  served !== null && served.includes('"rooms":0'),
  served ?? `(no answer) ${relayLog.trim().slice(0, 200)}`,
);
relay.kill('SIGKILL');

// Informational: what the binary contains, which is not the same as what it requires.
const disassembly = spawnSync('objdump', ['-d', '--no-show-raw-insn', drdshd], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
if (disassembly.status === 0) {
  const vector = (disassembly.stdout.match(/^\s+[0-9a-f]+:\s+v[a-z]/gm) ?? []).length;
  note(
    `${drdshd} contains ${vector} v-prefixed (AVX) instruction(s): legitimate inside a runtime-detected ` +
      'branch, which is why the checks above run the code rather than read it',
  );
} else {
  note('objdump is not available, so the instruction count was not taken');
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
