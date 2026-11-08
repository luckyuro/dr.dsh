import assert from 'node:assert/strict';
import { test } from 'node:test';

const { readDoctorReport, summarizeReport } = await import(new URL('../web/diagnostics.js', import.meta.url).href);
test('native diagnosis failure and incomplete output cannot become a passing UI report', () => {
  const text = JSON.stringify({ version: 1, checks: [{ id: 'dsh', title: 'DSH', message: 'installed', level: 'pass' }] });
  assert.equal(summarizeReport(readDoctorReport({ text, exitCode: 0 })).level, 'pass');
  assert.equal(summarizeReport(readDoctorReport({ text, exitCode: 1 })).level, 'fail');
  assert.equal(summarizeReport(readDoctorReport({ text, exitCode: 0, truncated: true })).level, 'fail');
  for (const value of ['', 'arbitrary output', JSON.stringify({ version: 2, checks: [] }), JSON.stringify({ version: 1, checks: [{ level: 'pass' }] })]) {
    assert.equal(readDoctorReport({ text: value }), null);
  }
});
test('older native text retains warnings and failures instead of being interpreted as all clear', () => {
  const report = readDoctorReport({ text: '[ok  ] platform\n[warn] port busy\n[FAIL] missing DSH\n', exitCode: 1 });
  assert.equal(report.legacy, true);
  assert.deepEqual(summarizeReport(report).counts, { pass: 1, warn: 1, fail: 1 });
});
