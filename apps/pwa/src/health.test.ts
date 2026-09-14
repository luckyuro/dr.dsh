/**
 * The crash-rate arithmetic, checked on constructed samples.
 *
 * The point of these tests is the *honesty* of the number: a soak of twenty runs cannot say anything
 * about a 0.5% rate, and the code has to be able to say so rather than printing "0%".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLIENT_VERSION,
  HEALTH_GLOBAL,
  MAX_SAMPLES,
  MAX_USER_AGENT,
  crashReport,
  describeRate,
  emptyHealth,
  hasSomethingToReport,
  rateReading,
  recordFailure,
} from './health.ts';

test('a fresh reading is all zeroes and not ready', () => {
  const health = emptyHealth();
  assert.deepEqual(health, { errors: 0, rejections: 0, samples: [], ready: false });
  assert.equal(HEALTH_GLOBAL, '__DR_DSH_HEALTH__');
});

test('failure text is flattened, truncated and capped', () => {
  const health = emptyHealth();
  recordFailure(health, 'line one\nline two\twith tabs');
  assert.deepEqual(health.samples, ['line one line two with tabs']);
  recordFailure(health, 'x'.repeat(500));
  assert.equal(health.samples[1]?.length, 160, 'an error message can carry a token; keep it short');
  for (let index = 0; index < MAX_SAMPLES + 5; index += 1) recordFailure(health, `failure ${index}`);
  assert.equal(health.samples.length, MAX_SAMPLES, 'the retained text is capped');
  assert.match(health.samples.at(-1) ?? '', /failure 24/, 'the newest sample is the one kept');
});

test('a small sample cannot support a claim about a small rate', () => {
  const small = rateReading(20, 0, 0.005);
  assert.equal(small.crashes, 0);
  assert.equal(small.observed, 0);
  assert.ok(small.upperBound95 > 0.005, 'the bound must still be above the target');
  assert.equal(small.conclusive, false);
  assert.match(describeRate(small, 0.005), /cannot support a claim/);
  // The sentence must carry the sample size: "0% crashes" without one is the claim this prevents.
  assert.match(describeRate(small, 0.005), /20 runs/);
});

test('a sample large enough is conclusive, and says so', () => {
  // 3/n <= 0.005 needs n >= 600. That is the number the soak script prints.
  assert.equal(rateReading(600, 0, 0.005).conclusive, true);
  assert.equal(rateReading(599, 0, 0.005).conclusive, false);
  assert.match(describeRate(rateReading(600, 0, 0.005), 0.005), /95% confidence/);
});

test('crashes are reported as a rate, never as a pass', () => {
  const reading = rateReading(100, 3, 0.005);
  assert.equal(reading.observed, 0.03);
  assert.equal(reading.conclusive, false, 'a failing sample is not a conclusive one');
  assert.match(describeRate(reading, 0.005), /3\.00% observed/);
});

test('an empty run reports that it observed nothing', () => {
  const reading = rateReading(0, 0, 0.005);
  assert.equal(reading.conclusive, false);
  assert.equal(reading.upperBound95, 1);
  assert.equal(describeRate(reading, 0.005), 'no runs observed');
});

test('a healthy run has nothing to report, and a failed one does', () => {
  const healthy = emptyHealth();
  healthy.ready = true;
  // Telemetry is the thing this avoids: a run that worked says nothing to anyone.
  assert.equal(hasSomethingToReport(healthy), false);

  const errored = emptyHealth();
  errored.ready = true;
  errored.errors = 1;
  assert.equal(hasSomethingToReport(errored), true);

  const rejected = emptyHealth();
  rejected.ready = true;
  rejected.rejections = 1;
  assert.equal(hasSomethingToReport(rejected), true);

  // A run that never reached a usable state is a crash even with no error event: the page that
  // simply never worked is exactly the case a report exists for.
  assert.equal(hasSomethingToReport(emptyHealth()), true);
});

test('a report carries counters and truncated text, and nothing from the session', () => {
  const health = emptyHealth();
  health.errors = 2;
  health.rejections = 1;
  recordFailure(health, 'TypeError: x is not a function');
  const report = crashReport(health, 'connecting', {
    now: 1_700_000_000_000,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
  });

  assert.equal(report.client, CLIENT_VERSION);
  assert.equal(report.phase, 'connecting');
  assert.equal(report.reached_ready, false);
  assert.equal(report.errors, 2);
  assert.equal(report.rejections, 1);
  assert.equal(report.at_ms, 1_700_000_000_000);
  assert.deepEqual(report.samples, ['TypeError: x is not a function']);

  // The field list is the contract with `dr_dsh_proto::control::CrashReport`: a field the daemon
  // does not know is a field it refuses the whole report for, and a field that could name the room
  // or the device is a field that must never exist.
  assert.deepEqual(Object.keys(report).sort(), [
    'at_ms',
    'client',
    'errors',
    'phase',
    'reached_ready',
    'rejections',
    'samples',
    'user_agent',
  ]);
});

test('a report is sanitized before it leaves the page', () => {
  const health = emptyHealth();
  recordFailure(health, 'first line');
  // `recordFailure` already flattens newlines; this is the second line of defence for anything that
  // reached the samples another way, because a newline in a report is how one log line becomes two.
  health.samples.push('tab\there\u0007');
  const report = crashReport(health, 'ready', { now: 0, userAgent: '\u001b[31mred' });
  assert.equal(report.samples[1], 'tab here ');
  assert.equal(report.user_agent, ' [31mred');
  assert.ok(report.user_agent.length <= MAX_USER_AGENT);
});

test('a long user agent is truncated rather than refused', () => {
  const report = crashReport(emptyHealth(), 'ready', {
    now: 0,
    userAgent: 'u'.repeat(MAX_USER_AGENT + 500),
  });
  // The daemon refuses a report over its cap, so a client that sent an untruncated user agent would
  // lose the whole report over a header string.
  assert.equal(report.user_agent.length, MAX_USER_AGENT);
});
