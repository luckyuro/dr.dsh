/**
 * Two machines in one browser (ADR-0007), driven the way a person would.
 *
 * The failure this exists for was silent: the browser kept **one** pairing record, so pairing with a
 * second computer replaced the first one's key and the first machine became unreachable — with no error
 * anywhere, because the page had nothing left to compare against. What has to be true instead:
 *
 *   1. pairing with a second machine adds it, and the page says how many it knows;
 *   2. the list shows both, and the one just paired is selected;
 *   3. switching to the first and connecting really reaches **that** daemon — checked against the two
 *      daemons' audit logs, since both serve the same DSH build and the page looks identical either way;
 *   4. the identity is the *same* device in both daemons (`drdshd devices` on each lists one id), which
 *      is the "one identity, many rooms" half of the decision;
 *   5. forgetting one machine leaves the other usable.
 *
 * Usage:
 *   node scripts/browser-rooms-smoke.mjs [--relay-port 8895] [--headed]
 *                                       [--drdshd target/debug/drdshd] [--drdsh-relay target/debug/drdsh-relay]
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the run could not start.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

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
const drdshd = option('--drdshd', 'target/debug/drdshd');
const drdshRelay = option('--drdsh-relay', 'target/debug/drdsh-relay');
const relayPort = Number(option('--relay-port', '8895'));
const headed = args.includes('--headed');
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

if (!existsSync(drdshd) || !existsSync(drdshRelay)) {
  console.error(`need ${drdshd} and ${drdshRelay}; run \`cargo build --workspace\` first`);
  process.exit(2);
}
if (!existsSync('apps/pwa/dist/shell.js')) {
  console.error('need a client build: run `pnpm --filter @dr.dsh/pwa build`');
  process.exit(2);
}

const results = [];
let failures = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
  if (!ok) failures += 1;
}

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

async function waitFor(log, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pattern.test(log.text)) await sleep(200);
  return pattern.test(log.text);
}

/**
 * Kills a process **and its children**.
 *
 * Every daemon in these scripts supervises a real DSH, and killing only the daemon leaves that DSH
 * running: it keeps the port it bound, so the next run's daemon refuses to start and the smoke fails
 * with "port is already in use" — which looks like a product defect and is not one. The daemon is
 * spawned detached (its own process group) so the whole tree can be signalled at once.
 */
function killTree(child) {
  if (child === null || child === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone, or never got its own group (a spawn that failed): fall back to the process itself.
    try {
      killTree(child);
    } catch {
      // Nothing left to kill.
    }
  }
}

function start(command, argv, env) {
  const child = spawn(command, argv, { env: { ...process.env, ...env }, detached: true });
  const log = { text: '' };
  const absorb = chunk => {
    log.text += String(chunk);
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  return { child, log };
}

const running = [];
let relay = null;
function stopEverything() {
  for (const process_ of running) killTree(process_.child);
  killTree(relay?.child);
}

// A relay of this script's own, serving this build of the client: the browser has to load the shell the
// checks are about, and a stale build from another directory is the one way this could pass while the
// code is wrong.
rmSync('target/rooms-smoke', { recursive: true, force: true });
relay = start(drdshRelay, [], {
  DSH_RELAY_BIND: `127.0.0.1:${relayPort}`,
  DSH_RELAY_CLIENT_DIR: `${process.cwd()}/apps/pwa/dist`,
  RUST_LOG: 'warn',
});
if (!(await waitFor(relay.log, /listening on/, 15_000))) {
  console.error(`the relay never started: ${relay.log.text}`);
  process.exit(2);
}
const relayUrl = `http://127.0.0.1:${relayPort}`;

/** One machine: its own state directory, daemon port and audit log. */
async function machine(name) {
  const stateDir = join('target', 'rooms-smoke', name);
  const daemonPort = await freePort();
  const pairing = start(drdshd, ['pair', '--relay', `ws://127.0.0.1:${relayPort}`, '--wait', '120'], {
    DSHD_STATE_DIR: stateDir,
    PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
  });
  running.push(pairing);
  if (!(await waitFor(pairing.log, /code:/, 20_000))) {
    console.error(`${name} never printed a code: ${pairing.log.text}`);
    stopEverything();
    process.exit(2);
  }
  return {
    name,
    stateDir,
    daemonPort,
    pairing,
    code: /code:\s+(\S+)/.exec(pairing.log.text)?.[1] ?? '',
    auditPath: join(stateDir, 'audit.jsonl'),
    daemon: null,
  };
}

/** Starts the daemon for a machine, once its device has been enrolled. */
async function serve(machine_) {
  machine_.daemon = start(
    drdshd,
    ['run', '--relay', `ws://127.0.0.1:${relayPort}`, '--port', String(machine_.daemonPort)],
    {
      DSHD_STATE_DIR: machine_.stateDir,
      PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
    },
  );
  running.push(machine_.daemon);
  return await waitFor(machine_.daemon.log, /relay: Connected/, 40_000);
}

function auditEvents(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(entry => entry !== null);
  } catch {
    return [];
  }
}

const laptop = await machine('laptop');
const desktop = await machine('desktop');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', error => consoleErrors.push(`uncaught: ${error.message}`));

try {
  // ---------------------------------------------------------------------------------------------
  // 0. A v1 database — identity and room in one record — is migrated on the way in.
  //
  // The migration is the one moment where getting it wrong costs somebody their pairing, and the
  // upgrade path only runs when a v1 database exists. Rather than trusting the unit tests of the pure
  // transform, this creates a real v1 database first: the shell is blocked from loading, the old record
  // is written by hand through the same IndexedDB API the old build used, and only then is the page
  // allowed to open it. If the upgrade loses the record, the page says "not paired" and this fails.
  // ---------------------------------------------------------------------------------------------
  const legacy = {
    privateKey: 'legacy-private-key-not-a-real-key',
    publicKey: 'legacy-public-key-not-a-real-key',
    deviceId: 'legacy-device-id',
    roomKey: 'legacy-room-key',
    room: 'legacy-room',
  };
  await page.route('**/client/shell.js', route => route.abort());
  await page.goto(relayUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.evaluate(
    record =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('dr.dsh', 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('device')) database.createObjectStore('device');
        };
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('device', 'readwrite');
          transaction.objectStore('device').put(record, 'this-device');
          transaction.oncomplete = () => {
            database.close();
            resolve(true);
          };
          transaction.onerror = () => reject(new Error('could not write the v1 record'));
        };
        request.onerror = () => reject(new Error('could not create the v1 database'));
      }),
    legacy,
  );
  await page.unroute('**/client/shell.js');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(1500);
  const migrated = await page.evaluate(
    () =>
      new Promise(resolve => {
        const request = indexedDB.open('dr.dsh', 2);
        request.onsuccess = () => {
          const database = request.result;
          const stores = [...database.objectStoreNames];
          const transaction = database.transaction(['identity', 'rooms'], 'readonly');
          const identity = transaction.objectStore('identity').get('this-device');
          const rooms = transaction.objectStore('rooms').getAll();
          transaction.oncomplete = () => {
            database.close();
            resolve({ stores, identity: identity.result ?? null, rooms: rooms.result ?? [] });
          };
          transaction.onerror = () => {
            database.close();
            resolve({ stores, identity: null, rooms: [] });
          };
        };
        request.onerror = () => resolve({ stores: [], identity: null, rooms: [] });
      }),
  );
  check(
    'a v1 record is migrated into an identity and a room, not dropped',
    migrated.identity?.deviceId === legacy.deviceId &&
      migrated.identity?.privateKey === legacy.privateKey &&
      migrated.rooms.length === 1 &&
      migrated.rooms[0].room === legacy.room &&
      migrated.rooms[0].roomKey === legacy.roomKey,
    `stores [${migrated.stores.join(', ')}], identity ${migrated.identity?.deviceId ?? '(none)'}, ${migrated.rooms.length} room(s)`,
  );
  check(
    'and the old store is gone, so the key is not kept twice',
    !migrated.stores.includes('device'),
    `stores [${migrated.stores.join(', ')}]`,
  );
  // The blocked shell above produced one console error on purpose; from here on, errors count again.
  consoleErrors.length = 0;
  // The migrated record is a *bad* one — its key is not a key — so the page must keep it and fail
  // where it can say what to do, rather than throwing it away. That is what makes the next step (a
  // fresh context) necessary for the rest of this smoke.
  await context.clearCookies();
  await page.evaluate(
    () =>
      new Promise(resolve => {
        const request = indexedDB.deleteDatabase('dr.dsh');
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(true);
        request.onblocked = () => resolve(true);
      }),
  );

  await page.goto(relayUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  check('the page loaded', (await page.title()) === 'dr.dsh', await page.title());

  // 1. Pair with the first machine, exactly as a person does: type the code, press Connect.
  await page.fill('#key', laptop.code);
  await page.click('#connect');
  await page.waitForFunction(
    () => /Paired as/.test(document.getElementById('state')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const afterFirst = (await page.textContent('#device')) ?? '';
  check(
    'the first pairing is remembered as a machine',
    /with paired|with laptop|Paired as \S+ with/.test(afterFirst),
    afterFirst.trim(),
  );

  await serve(laptop);

  // 2. Pair with a second machine. Before ADR-0007 this replaced the first record and the first
  //    machine became unreachable without a word.
  await page.fill('#key', desktop.code);
  await page.click('#connect');
  await page.waitForFunction(
    () => /2 computers/.test(document.getElementById('device')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const rooms = await page.$$eval('#room-list li', rows =>
    rows.map(row => row.querySelector('button')?.textContent ?? ''),
  );
  check(
    'a second pairing is added instead of replacing the first',
    rooms.length === 2,
    `${rooms.length} row(s): ${rooms.join(' | ')}`,
  );
  // A list whose rows all say "Chrome on Linux" is a list nobody can use; the first version of this
  // page produced exactly that, and the smoke found it here.
  const labels = rooms.map(label => label.replace('• ', ''));
  check(
    'and the two machines are told apart by name',
    new Set(labels).size === labels.length,
    labels.join(' | '),
  );
  check(
    'and the list marks one of them as selected',
    rooms.some(label => label.startsWith('•')),
    rooms.join(' | '),
  );

  await serve(desktop);

  // 3. Switch to the first machine and connect. Both daemons serve the same DSH build, so the page
  //    looks identical either way — the audit logs are what say which one the session reached.
  const laptopSessionsBefore = auditEvents(laptop.auditPath).filter(
    entry => entry.event === 'tunnel_established',
  ).length;
  const desktopSessionsBefore = auditEvents(desktop.auditPath).filter(
    entry => entry.event === 'tunnel_established',
  ).length;

  const target = rooms.findIndex(label => !label.startsWith('•'));
  check('one row is not the selected one, so there is something to switch to', target >= 0, rooms.join(' | '));
  await page.click(`#room-list li:nth-child(${target + 1}) button`);
  const selected = await page.textContent('#state');
  check('switching says which machine is selected', /Selected/.test(selected ?? ''), (selected ?? '').trim());

  await page.fill('#key', '');
  await page.click('#connect');
  await page.waitForFunction(
    () => document.getElementById('panel')?.dataset.tone === 'ok',
    undefined,
    { timeout: 60_000 },
  );
  const headline = (await page.textContent('#headline')) ?? '';
  check('the selected machine answers', /running/i.test(headline), headline.trim());

  // Which daemon did that session reach? Exactly one of them should have a new `tunnel_established`.
  await sleep(1500);
  const laptopSessions = auditEvents(laptop.auditPath).filter(
    entry => entry.event === 'tunnel_established',
  );
  const desktopSessions = auditEvents(desktop.auditPath).filter(
    entry => entry.event === 'tunnel_established',
  );
  check(
    'and it was the machine that was selected, not the most recent one',
    laptopSessions.length === laptopSessionsBefore + 1 &&
      desktopSessions.length === desktopSessionsBefore,
    `laptop ${laptopSessionsBefore}→${laptopSessions.length}, desktop ${desktopSessionsBefore}→${desktopSessions.length}`,
  );

  // 4. One identity, many rooms: each daemon knows the same device id.
  const deviceId = (await page.textContent('#device'))?.match(/Paired as (\S+)/)?.[1] ?? '';
  const listedFor = async stateDir =>
    await new Promise(resolve => {
      const child = spawn(drdshd, ['devices'], {
        env: { ...process.env, DSHD_STATE_DIR: stateDir },
      });
      let out = '';
      child.stdout.on('data', chunk => {
        out += String(chunk);
      });
      child.on('close', () => resolve(out));
    });
  const inLaptop = await listedFor(laptop.stateDir);
  const inDesktop = await listedFor(desktop.stateDir);
  check(
    'both daemons list the same device id: one identity, two rooms',
    deviceId !== '' && inLaptop.includes(deviceId) && inDesktop.includes(deviceId),
    `${deviceId} in laptop: ${inLaptop.includes(deviceId)}, in desktop: ${inDesktop.includes(deviceId)}`,
  );

  // 5. Forgetting one machine leaves the other in place.
  const forgetButtons = await page.$$('#room-list li button:last-child');
  await forgetButtons[0].click();
  await page.waitForFunction(
    () => document.querySelectorAll('#room-list li').length === 1,
    undefined,
    { timeout: 10_000 },
  );
  const remaining = await page.$$eval('#room-list li', rows => rows.length);
  check('forgetting one machine leaves the other', remaining === 1, `${remaining} row(s) left`);

  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || undefined,
  );
} catch (error) {
  // The page's own words are the diagnosis: "Connecting…" forever and a named failure look the same
  // from the outside, and a smoke that only printed a timeout would send the reader to the daemon logs.
  try {
    const state = (await page.textContent('#state')) ?? '';
    const detail = (await page.textContent('#detail')) ?? '';
    console.log(`      page said: ${state.trim()} | ${detail.trim()}`);
    console.log(`      console: ${consoleErrors.slice(0, 3).join(' | ') || '(clean)'}`);
    console.log(`      laptop log tail: ${laptop.daemon?.log.text.trim().split('\n').slice(-3).join(' | ')}`);
    console.log(`      desktop log tail: ${desktop.daemon?.log.text.trim().split('\n').slice(-3).join(' | ')}`);
  } catch {
    // The page may be gone; the failure itself is what matters.
  }
  check('the browser run completed', false, error.message);
} finally {
  await browser.close();
  stopEverything();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
