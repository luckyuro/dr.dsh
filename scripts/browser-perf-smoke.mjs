/**
 * Measures how the interface scrolls, and says exactly what was scrolled.
 *
 * M3's standard says a long session — more than a thousand messages — must scroll without jank. This
 * script measures frame times while scrolling the real interface, first as it is, then with the
 * conversation padded to a thousand message-sized blocks. **It says which of the two it measured**,
 * because they are not the same claim:
 *
 * * the first is the real DSH interface rendering a real session, of whatever length this machine has;
 * * the second is that interface rendering a thousand extra blocks in its own list container. It is a
 *   real measurement of layout and scroll cost in the real client, and it is *not* the same as a
 *   session DSH produced with a thousand messages — no such session exists here, and seeding one would
 *   mean writing into DSH's own session store, which this project does not do.
 *
 * Frame times come from `requestAnimationFrame` deltas sampled while the page is scrolled a step per
 * frame. The numbers are from a headless Chromium on whatever machine runs this, so the budget is a
 * *jank* budget (a pathological frame) rather than a phone-refresh-rate budget, and the report says so.
 *
 * Usage:
 *   node scripts/browser-perf-smoke.mjs <relay-url> <room-key> [--messages 1000] [--budget-ms 100]
 *
 * Exit codes: 0 within budget, 1 over budget or the run failed, 2 the run could not start.
 */

import { chromium } from 'playwright-core';

const [relayUrl, roomKey, ...rest] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/browser-perf-smoke.mjs <relay-url> <room-key> [--messages N] [--budget-ms N]');
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
const messages = Number(option('--messages', '1000'));
const budgetMs = Number(option('--budget-ms', '100'));
/** Where Playwright's Chromium lives in this environment. */
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

const results = [];
let failures = 0;
/** Measurements that could not be taken, as opposed to taken and over budget. */
let skipped = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
  if (!ok) failures += 1;
}
function skip(what, detail) {
  console.log(`skip  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  skipped += 1;
}

/**
 * Measures scrolling in whatever container the interface scrolls its conversation in.
 *
 * One self-contained function, because Playwright serialises only what is passed: a helper defined at
 * this level is *not* in the page, and calling it there fails with `findScroller is not defined` — which
 * is how the first version of this rewrite failed. Everything the probe needs is inside it.
 *
 * The measurement is deliberately split from the padding: called with `pad: 0` it measures the real
 * interface as it is, and called with a count it first grows the conversation and then measures the
 * same way. Both halves are reported, because they are different claims.
 *
 * Why the scroll container and not the document: the first version scrolled `document.scrollingElement`,
 * which was 720px tall — nothing to scroll, every frame delta one 60Hz vsync interval of an **idle**
 * page. A measurement that reports 16.7ms for scrolling that never happened is worse than none, because
 * it looks like evidence.
 *
 * @param options - how many synthetic blocks to add, and how many frames to sample.
 */
async function measureScrolling(options) {
  const findScroller = () => {
    let best = null;
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (!/(auto|scroll)/u.test(style.overflowY)) continue;
      if (element.scrollHeight <= element.clientHeight + 40) continue;
      if (best === null || element.scrollHeight > best.scrollHeight) best = element;
    }
    return best;
  };

  const scroller = findScroller();
  let padded = { added: 0, into: 'nothing', scrollHeight: 0 };
  if (options.pad > 0) {
    const container = scroller ?? document.body;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < options.pad; index += 1) {
      const block = document.createElement('div');
      block.style.padding = '8px 12px';
      block.textContent =
        `synthetic message ${index}: the quick brown fox jumps over the lazy dog, and a long session ` +
        'is what makes scrolling visible in the first place. '.repeat(2);
      fragment.append(block);
    }
    container.append(fragment);
    padded = {
      added: options.pad,
      into:
        scroller === null
          ? 'body (no scrolling container existed)'
          : `${scroller.tagName.toLowerCase()}.${String(scroller.className).slice(0, 24)}`,
      scrollHeight: container.scrollHeight,
    };
  }

  const target = findScroller() ?? document.scrollingElement ?? document.documentElement;
  const deltas = [];
  let previous = performance.now();
  await new Promise(resolve => {
    let remaining = options.frames;
    const tick = now => {
      deltas.push(now - previous);
      previous = now;
      target.scrollTop += 240;
      if (target.scrollTop + target.clientHeight >= target.scrollHeight - 4) target.scrollTop = 0;
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  deltas.shift();
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    padded,
    frames: deltas.length,
    median: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    worst: Number((sorted.at(-1) ?? 0).toFixed(1)),
    long: deltas.filter(delta => delta > 50).length,
    scrolled: `${target.tagName.toLowerCase()} (${target.scrollHeight}px of content in ${target.clientHeight}px)`,
  };
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(relayUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.fill('#key', roomKey);
  await page.click('#connect');
  await page.waitForFunction(
    () => document.getElementById('panel')?.dataset.tone === 'ok',
    undefined,
    { timeout: 40_000 },
  );

  const popup = context.waitForEvent('page', { timeout: 30_000 });
  await page.click('#open');
  const iface = await popup;
  await iface.waitForFunction(() => typeof window.__DSH_BOOT__ !== 'undefined', undefined, {
    timeout: 30_000,
  });
  await iface.waitForFunction(() => document.querySelectorAll('*').length > 100, undefined, {
    timeout: 30_000,
  });
  // Let the interface settle: measuring during the first paint measures the boot, not scrolling.
  await iface.waitForTimeout(3000);

  const asIs = await iface.evaluate(measureScrolling, { pad: 0, frames: 120 });
  if (asIs.scrolled.includes('of content in 720px') || /(\d+)px of content in \1px/u.test(asIs.scrolled)) {
    // Nothing to scroll in this session. Reporting a frame budget for an idle page is the mistake the
    // first version made, so this says so instead of passing.
    skip(
      'the real interface scrolls without a pathological frame',
      `this session has nothing to scroll (${asIs.scrolled}); the padded measurement below is the one that means something`,
    );
  } else {
    check(
      'the real interface scrolls without a pathological frame',
      asIs.p95 <= budgetMs,
      `p50 ${asIs.median}ms, p95 ${asIs.p95}ms, worst ${asIs.worst}ms, ${asIs.long} long frames, scrolling ${asIs.scrolled}`,
    );
  }

  const withMany = await iface.evaluate(measureScrolling, { pad: messages, frames: 180 });
  console.log(
    `  padded with ${withMany.padded.added} blocks into ${withMany.padded.into}, ` +
      `scroll height ${withMany.padded.scrollHeight}px`,
  );
  check(
    `scrolling ${messages} message-sized blocks stays within the frame budget`,
    withMany.p95 <= budgetMs,
    `p50 ${withMany.median}ms, p95 ${withMany.p95}ms, worst ${withMany.worst}ms, ${withMany.long} long frames, scrolling ${withMany.scrolled}`,
  );

  check(
    'the interface is still alive after the measurement',
    await iface.evaluate(() => typeof window.__DSH_BOOT__ !== 'undefined'),
  );
} catch (error) {
  check('the performance run completed', false, error.message);
} finally {
  await browser.close();
}

console.log(
  `\n${results.length - failures}/${results.length} checks passed` +
    (skipped === 0 ? '' : `, ${skipped} skipped`) +
    ' (headless Chromium on this machine; the metric is *dropped frames*, and the frame deltas are ' +
    'quantised to one vsync interval, so only a long frame means anything)',
);
process.exit(failures > 0 ? 1 : skipped > 0 ? 2 : 0);
