/**
 * Measures the client's crash rate the only way this project can: by running it, repeatedly, here.
 *
 * M3's standard says "under 0.5% on mobile". There is no telemetry in this project — it is off by
 * default (ADR-0006) and a client that reported its users' failures home would contradict the reason
 * the project exists — so the number can only come from runs we perform, and the arithmetic of what
 * such a sample can support is part of the result rather than a footnote:
 *
 * ```text
 * 20 runs, 0 crashes: the 95% bound is still 15.00%, so this sample cannot support a claim about 0.50%
 * 600 runs, 0 crashes: under 0.50% with 95% confidence
 * ```
 *
 * Each run is a real page load against a real relay and daemon: the shell loads, its modules execute,
 * the service worker takes control, the tunnel connects and the panel reports a healthy DSH. A run
 * "crashes" if the page records an uncaught error or an unhandled rejection, or if it never reaches
 * that state before the timeout.
 *
 * Usage:
 *   node scripts/browser-soak-smoke.mjs <relay-url> <room-key> [--runs N] [--target 0.005] [--headed]
 *
 * Exit codes: 0 the sample supports the target rate, 1 crashes were observed, 2 the sample is too
 * small to say anything (which is the honest result of a short run, and not a failure).
 */

import { chromium } from 'playwright-core';

const [relayUrl, roomKey, ...rest] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/browser-soak-smoke.mjs <relay-url> <room-key> [--runs N] [--target 0.005]');
  process.exit(2);
}
/** Reads an option's value, or the default. */
function option(name, fallback) {
  const index = rest.indexOf(name);
  if (index < 0) return fallback;
  const value = rest[index + 1];
  if (value === undefined) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const runs = Number(option('--runs', '20'));
const target = Number(option('--target', '0.005'));
const headed = rest.includes('--headed');
/** Where Playwright's Chromium lives in this environment. */
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
/** How long one run may take before it counts as a crash of its own kind. */
const RUN_TIMEOUT_MS = 45_000;

/**
 * The rule of three, and the sentence it produces.
 *
 * Duplicated from `apps/pwa/src/health.ts` rather than imported: this script has to keep working when
 * the client does not load at all, which is the case it exists to measure.
 */
function reading(count, crashes, wanted) {
  const upperBound95 = count === 0 ? 1 : 3 / count;
  return {
    observed: count === 0 ? 0 : crashes / count,
    upperBound95,
    conclusive: count > 0 && upperBound95 <= wanted,
  };
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();

let crashes = 0;
const failures = [];
for (let run = 1; run <= runs; run += 1) {
  const page = await context.newPage();
  const started = Date.now();
  try {
    await page.goto(relayUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: RUN_TIMEOUT_MS,
    });
    await page.fill('#key', roomKey);
    await page.click('#connect');
    await page.waitForFunction(
      () => document.getElementById('panel')?.dataset.tone === 'ok',
      undefined,
      { timeout: RUN_TIMEOUT_MS },
    );
    const health = await page.evaluate(() => ({
      errors: window.__DR_DSH_HEALTH__?.errors ?? 0,
      rejections: window.__DR_DSH_HEALTH__?.rejections ?? 0,
      ready: window.__DR_DSH_HEALTH__?.ready ?? false,
      samples: (window.__DR_DSH_HEALTH__?.samples ?? []).slice(0, 2),
    }));
    if (!health.ready || health.errors > 0 || health.rejections > 0) {
      crashes += 1;
      failures.push(`run ${run}: ${JSON.stringify(health)}`);
    }
    const elapsed = Date.now() - started;
    process.stdout.write(
      `run ${String(run).padStart(3)}: ${elapsed}ms, errors ${health.errors}, rejections ${health.rejections}\n`,
    );
  } catch (error) {
    // A run that timed out or could not connect is a crash of the client as the user experiences it,
    // and it is reported with the reason rather than folded into a count.
    crashes += 1;
    failures.push(`run ${run}: ${error.message.split('\n')[0]}`);
    process.stdout.write(`run ${String(run).padStart(3)}: FAILED — ${error.message.split('\n')[0]}\n`);
  } finally {
    await page.close();
  }
}
await browser.close();

const result = reading(runs, crashes, target);
console.log('');
for (const failure of failures.slice(0, 5)) console.log(`crash: ${failure}`);
console.log(
  `${runs} runs, ${crashes} crashes: observed ${(result.observed * 100).toFixed(2)}%, ` +
    `95% upper bound ${(result.upperBound95 * 100).toFixed(2)}%, target ${(target * 100).toFixed(2)}%`,
);
if (result.conclusive) {
  console.log(`the sample supports a claim about ${(target * 100).toFixed(2)}%`);
} else {
  console.log(
    `this sample cannot support a claim about ${(target * 100).toFixed(2)}%: the bound needs at least ` +
      `${Math.ceil(3 / target)} runs`,
  );
}
process.exit(crashes > 0 ? 1 : result.conclusive ? 0 : 2);
