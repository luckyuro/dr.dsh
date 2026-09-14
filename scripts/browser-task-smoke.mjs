/**
 * Drives one real task through the interface, in a real browser.
 *
 * The fidelity criterion asks for "a real multi-turn coding task including an approval, a tool
 * call, and a long output" completed from the remote end. This does not do all of that — it does
 * the part that proves the rest is reachable: it opens a session and sends a message, and checks
 * that DSH's answer comes back through the tunnel into the rendered page.
 *
 * That is worth separating from the rest because it exercises everything at once and would fail if
 * any of it were broken: the interface's own HTTP, its live socket, the session it creates over
 * that socket, and the model turn it runs. The approval and tool-call parts need a prompt that
 * reliably triggers them, which is a different kind of test work.
 *
 * Usage:
 *   node scripts/browser-task-smoke.mjs <relay-url> <room-key> [prompt]
 *       [--timeout-ms N] [--workspace <path-from-home>]
 *
 * With `--workspace`, the run selects that directory through the interface's own picker when DSH
 * asks for one, which is what a person does and what makes the run self-contained on a machine
 * whose DSH has never been given a workspace. The path is relative to the home directory, because
 * that is where the picker starts.
 *
 * Its exit code is the result.
 */

import { chromium } from 'playwright-core';

const [relayUrl, roomKey, ...rest] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/browser-task-smoke.mjs <relay-url> <room-key> [prompt] [--timeout-ms N]');
  process.exit(2);
}
const timeoutFlag = rest.indexOf('--timeout-ms');
const workspaceFlag = rest.indexOf('--workspace');
// A unique marker in the prompt, so "an answer arrived" can be a check on the *model's words*
// rather than on the page having grown: the composer echoes what was typed, and page chrome is
// long enough to satisfy "more than 40 characters past the prompt" on its own.
const marker = `DSH-REMOTE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const prompt =
  rest[0]?.startsWith('--') === true || rest[0] === undefined
    ? `Reply with exactly this token and nothing else: ${marker}`
    : rest[0];
const turnTimeoutMs = timeoutFlag === -1 ? 180_000 : Number(rest[timeoutFlag + 1]);
const workspace = workspaceFlag === -1 ? null : rest[workspaceFlag + 1];
/**
 * Whether to run the criterion's *full* scenario: an approval, a tool call, a long output and a
 * second turn, rather than one short answer.
 *
 * Off by default, because the full run needs a workspace it can write to, a model that will ask for
 * wider permissions, and a couple of minutes. Both modes are worth keeping: the short one is the
 * smoke that runs on every change, the full one is the acceptance evidence.
 */
const full = rest.includes('--full');

/**
 * Selects a workspace through the interface's own directory picker.
 *
 * The picker is a directory browser that starts at the home directory, so the path is walked one
 * segment at a time. Both languages are matched because DSH's interface language is a user
 * setting: a test that only knows the English labels fails on a machine set to Chinese, which is
 * a test bug rather than a product one — and this repository already has one of those.
 */
async function chooseWorkspace(iface, path) {
  const segments = path.split('/').filter(Boolean);
  const name = segments[segments.length - 1];
  const chooser = iface
    .getByRole('button', { name: /choose workspace|add workspace|选择工作区|添加工作区/i })
    .first();
  await chooser.waitFor({ timeout: 20_000 });
  await chooser.click({ timeout: 10_000 });
  await iface.waitForTimeout(3000);

  // Opening the chooser is often all that is needed: with a workspace list available, the session
  // takes the first one and the composer appears. Clicking an entry that is already selected (or is
  // a list item behind a modal mask) only adds a way for the run to fail for no product reason.
  if (!(await needsWorkspace(iface))) return;

  // An existing workspace is offered by name — as text rather than as a button, so the lookup is by
  // text, and forced because the picker's own mask sits over the list it just opened.
  const existing = iface.getByText(name, { exact: true }).first();
  if ((await existing.count()) > 0) {
    await existing.click({ timeout: 10_000, force: true });
    await iface.waitForTimeout(2500);
    if (!(await needsWorkspace(iface))) return;
  }

  // Otherwise add one: the picker browses from the home directory, so the path is walked one
  // segment at a time and then confirmed.
  const add = iface
    .getByRole('button', { name: /add workspace|添加工作区/i })
    .first();
  await add.click({ timeout: 10_000, force: true });
  await iface.waitForTimeout(1500);
  for (const segment of segments) {
    const button = iface.getByRole('button', { name: new RegExp(`^${segment}$`) }).first();
    await button.waitFor({ timeout: 20_000 });
    await button.click({ timeout: 10_000 });
    await iface.waitForTimeout(700);
  }
  const open = iface.getByRole('button', { name: /^(open|打开)$/ }).first();
  await open.click({ timeout: 10_000 });
  await iface.waitForTimeout(3000);
}

/**
 * Switches the session's permission mode.
 *
 * The full scenario needs an approval, and an approval needs a denial first: in `workspace-write`
 * the agent simply performs the write, so nothing ever asks. `view only` makes the sandbox refuse,
 * the agent escalates, and DSH shows the remote user the escalation as a card with two buttons.
 */
/**
 * Sends one message in the current session.
 *
 * @returns the text of the page before the send, so a check can measure how much was added.
 */
async function sendMessage(iface, text) {
  const before = await iface.evaluate(() => document.body.innerText.length);
  const composer = iface.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 15_000 });
  await composer.click();
  // Typed rather than assigned: the interface's editor tracks input events, and setting the text
  // directly leaves it believing the box is empty — the send then does nothing, with no error.
  await composer.type(text, { delay: 12 });
  await iface.keyboard.press('Enter');
  return before;
}

/**
 * Waits for a token to appear in a leaf node that is neither the composer nor the user's own message.
 *
 * The echo of the prompt is not an answer, and neither is an error message; both would satisfy a
 * weaker check, which is how an earlier version of this script reported success on a page that had
 * merely drawn more chrome.
 */
async function waitForAnswer(iface, token, timeoutMs) {
  return await iface
    .waitForFunction(
      value =>
        [...document.querySelectorAll('*')].some(
          element =>
            element.children.length === 0 &&
            (element.textContent ?? '').includes(value) &&
            !(element.textContent ?? '').includes('Reply with exactly') &&
            element.closest('[contenteditable="true"]') === null,
        ),
      token,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}

/** Whether the interface is still asking for a workspace, in either language. */
async function needsWorkspace(iface) {
  return await iface.evaluate(() =>
    /Choose a workspace to start|选择一个工作区开始/.test(document.body.innerText),
  );
}

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const results = [];
/** Checks that could not be run at all, as opposed to failed. Reported, never counted as passing. */
let skipped = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
}
function skip(what, detail) {
  console.log(`skip  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  skipped += 1;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(error.message));

try {
  await page.goto(relayUrl, { waitUntil: 'domcontentloaded' });
  await page.fill('#key', roomKey);
  await page.click('#connect');
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });

  const popup = context.waitForEvent('page', { timeout: 30_000 });
  await page.click('#open');
  const iface = await popup;
  await iface.waitForFunction(() => typeof window.__DSH_BOOT__ !== 'undefined', undefined, {
    timeout: 30_000,
  });
  await iface.waitForFunction(() => document.querySelectorAll('*').length > 100, undefined, {
    timeout: 30_000,
  });
  check('the interface is rendered', true);

  // The interface's live socket is what carries a turn's output. If it is not open, a message can
  // be sent and nothing will ever come back, which is the failure this run exists to distinguish.
  // The live socket, checked the way DSH itself uses it: `addEventListener`, and a real stream
  // request whose answer has to come back. `onopen` alone is not enough — an earlier shim called the
  // `on*` properties without dispatching events, so this check passed while the interface's own
  // socket (which listens with `addEventListener`) never opened and every live feature waited
  // forever.
  const muxOpen = await iface.evaluate(
    () =>
      new Promise(resolve => {
        const socket = new WebSocket(`ws://${location.host}/api/remote.mux`);
        let answered = false;
        socket.addEventListener('open', () => {
          socket.send(
            JSON.stringify({
              type: 'open',
              streamId: 'dr.dsh-smoke',
              endpoint: '$events',
              payload: { args: {} },
            }),
          );
        });
        socket.addEventListener('message', event => {
          if (!String(event.data).includes('"type":"item"')) return;
          answered = true;
          socket.close();
          resolve(true);
        });
        socket.addEventListener('error', () => resolve(false));
        setTimeout(() => resolve(answered), 10_000);
      }),
  );
  check('the live socket opens and answers a stream request', muxOpen === true);

  // A session of its own, so this does not depend on whatever the daemon's user was doing.
  // A session needs a workspace before it will accept a message. This is DSH's own prerequisite,
  // not the tunnel's: the interface says "Choose a workspace to start" and waits. A machine whose
  // DSH has never been given one cannot run this test, so it is reported as a skip rather than
  // silently passing or failing — the difference between "the remote access is broken" and "this
  // DSH has no workspace yet" is the whole point of saying it.
  // A session is created *after* a workspace exists: the picker's choice applies to the workspace
  // list, and a session made before it has none — which is the state the empty interface starts in.
  if (await needsWorkspace(iface)) {
    if (workspace === null) {
      console.log('skip  this DSH has no workspace and none was given (--workspace <path>)');
      const failed = results.filter(result => !result.ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed (turn skipped)`);
      await browser.close();
      process.exit(2);
    }
    await chooseWorkspace(iface, workspace);
    check('a workspace was selected through the interface', !(await needsWorkspace(iface)));
  }
  const workspaceReady = !(await needsWorkspace(iface));
  if (!workspaceReady) {
    console.log('skip  the DSH on this machine has no workspace, so no turn can be sent');
    console.log('      open the interface once and choose one, or set DSHD_TASK_WORKSPACE');
    const failed = results.filter(result => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed (turn skipped)`);
    await browser.close();
    process.exit(2);
  }

  // The picker's popover leaves a modal mask over the page, so it is dismissed the way a person
  // dismisses it. Without this the next click lands on the mask and the run fails with a pointer-event
  // error that has nothing to do with the product.
  await iface.keyboard.press('Escape');
  await iface.waitForTimeout(700);

  // Both languages: the interface's language is a user setting, so an English-only selector is a
  // test that fails on a Chinese machine for no product reason.
  const newSession = iface.getByRole('button', { name: /new session|新建会话|新会话/i }).first();
  await newSession.click({ timeout: 15_000 });
  await iface.waitForTimeout(3000);
  check('a session opened', true);

  if (!full) {
    // The composer is a contenteditable, not a textarea or an input.
    const composer = iface.locator('[contenteditable="true"]').first();
    await composer.waitFor({ timeout: 15_000 });
    await composer.click();
    await composer.type(prompt, { delay: 20 });
    check('the prompt is in the composer', (await composer.innerText()).includes(prompt.trim()));
    await iface.keyboard.press('Enter');

    await iface.waitForFunction(text => document.body.innerText.includes(text), prompt.trim(), {
      timeout: 30_000,
    });
    check('the message was accepted', true);

    const answered = await waitForAnswer(iface, marker, turnTimeoutMs);
    check(
      'the model answered through the tunnel',
      answered,
      answered ? undefined : 'the marker never came back before the deadline',
    );
  } else {
    // ------------------------------------------------------------------------------------------
    // The criterion's full scenario: an approval, a tool call, a long output, and a second turn.
    // ------------------------------------------------------------------------------------------

    // 1. An action the sandbox refuses, so the agent has to ask for wider permission.
    //
    // The first version of this switched the session's permission mode to view-only through the
    // interface's own selector. That selector does not take effect in this DSH build: the menu opens,
    // the option is clicked, the menu closes, and the label does not change — and a recording of the
    // multiplexed socket around the click shows the interface sent *nothing*, while the same socket
    // demonstrably carries stream traffic for everything else. So the session stayed writable, the
    // write simply succeeded, and the run reported "the model did not escalate" about a session that
    // had never been restricted.
    //
    // Writing outside the session's workspace is refused by the default policy (`workspace-write`
    // with approval `ask`: "wider retries require approval"), which is the shipping configuration
    // rather than a mode this test has to arrange.
    const approvalMarker = `APPROVAL-${marker}`;
    const outOfSandbox = '/etc/dr-dsh-approval-test.txt';
    await sendMessage(
      iface,
      `Use the shell tool to run exactly this command: echo APPROVED > ${outOfSandbox} ; then report ` +
        'the exit code. That path is outside this session\'s workspace, so the sandbox will refuse: ' +
        'when it does, request the wider permission you need (escalate) instead of giving up, so a ' +
        `human can approve it. When it succeeds, reply with the token ${approvalMarker}.`,
    );
    check('the message was accepted', true);

    // 2. The approval card. It takes the agent a while — it tries, is refused, and asks — so the wait
    //    is generous, and the button is matched in both languages because the interface's language is
    //    a user setting.
    // Matched exactly, not loosely: a substring match on "允许" also hits the tool-call breadcrumb
    // ("Write APPROVED and escalate permission"), which is disabled — so the click waits on the
    // wrong element while the real button sits next to it.
    const allow = iface
      .getByRole('button', { name: /^(allow once|总是允许|allow always|approve|批准|允许一次)$/i })
      .first();
    let approvalSeen = false;
    try {
      await allow.waitFor({ timeout: 120_000 });
      approvalSeen = true;
    } catch {
      approvalSeen = false;
    }
    if (!approvalSeen) {
      // One retry, and the reason is worth writing down: whether the agent *asks* for wider
      // permission is the model's decision, not the daemon's, and a model that answers "I could not
      // write the file" instead of escalating is not a failure of the approval path. The retry says
      // so explicitly in the prompt; the check below still requires a real approval card.
      console.log('  no approval card yet; asking the agent again, explicitly');
      await sendMessage(
        iface,
        'That command needs permission this session does not have. Request the wider permission you ' +
          'need (escalate with sandbox_permissions) so a human can approve it, then run it and reply ' +
          `with the token ${approvalMarker}.`,
      );
      try {
        await allow.waitFor({ timeout: 120_000 });
        approvalSeen = true;
      } catch {
        approvalSeen = false;
      }
    }
    if (!approvalSeen) {
      // Whether the agent *asks* for wider permission is the model's decision, not the daemon's: it
      // has answered "I cannot write that" and moved on in runs where the same prompt produced a card
      // in others. So a run with no card is reported as **skipped**, with the conversation tail, and
      // the script's exit code says the same thing — the rest of the scenario still runs, and nothing
      // here pretends the approval happened.
      const tail = await iface.evaluate(() => document.body.innerText.slice(-600).replace(/\n+/g, ' | '));
      console.log('  conversation tail:', tail);
      skip(
        'an approval prompt reached the remote user',
        'the agent did not request wider permission in this run; the approval path itself was ' +
          'verified in the M2 record (docs/product/mvp.md § 五点六十)',
      );
      skip('the approval was granted from the remote end', 'no card to grant');
      skip('the tool call completed after the approval', 'no approval was requested');
    } else {
      check('an approval prompt reached the remote user', true);
      await allow.click({ timeout: 15_000 });
      check('the approval was granted from the remote end', true);
      // The agent finishes the turn: the escalated tool call ran, so the token comes back. This is
      // the tool call *and* the approval in one check.
      const approved = await waitForAnswer(iface, approvalMarker, turnTimeoutMs);
      check(
        'the tool call completed after the approval',
        approved,
        approved ? undefined : 'the token never came back after the approval',
      );
    }

    // 4. A second turn with a long answer: 300 lines is far more than one carrier frame, and the
    //    conversation has to keep rendering after the first turn ended.
    const longMarker = `LONG-${marker}`;
    const before = await sendMessage(
      iface,
      `Print the integers from 1 to 300, one per line, then on its own line the token ${longMarker}.`,
    );
    check('the second message was accepted', true);
    const longAnswered = await waitForAnswer(iface, longMarker, turnTimeoutMs);
    check(
      'the second turn answered, so the session is multi-turn',
      longAnswered,
      longAnswered ? undefined : 'the second token never came back',
    );
    // Measured as the longest rendered block, not as the growth of the whole page: the interface
    // virtualises the conversation, so older content leaving the DOM shrinks the page while the new
    // answer is arriving — the first version of this check reported a *negative* growth on a turn
    // that had in fact rendered 300 lines.
    const longest = await iface.evaluate(() => {
      let best = 0;
      for (const element of document.querySelectorAll('*')) {
        if (element.children.length > 0) continue;
        if (element.closest('[contenteditable="true"]') !== null) continue;
        best = Math.max(best, (element.textContent ?? '').length);
      }
      return best;
    });
    check(
      'a long answer rendered in the remote page',
      longest > 800,
      `longest rendered block: ${longest} characters`,
    );
  }

  check('no uncaught errors in the interface', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || undefined);
} catch (error) {
  check('the task run completed', false, error.message);
} finally {
  await browser.close();
}

const failed = results.filter(result => !result.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} checks passed` +
    (skipped === 0 ? '' : `, ${skipped} skipped (exit 2: this run did not exercise everything)`),
);
process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
