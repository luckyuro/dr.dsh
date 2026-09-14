/**
 * Keeps the Rust definition and the TypeScript mirror numerically identical.
 *
 * The conformance corpus pins frame *encoding*; it says nothing about the limits
 * that decide whether a frame is legal in the first place. Those constants — the
 * payload cap, the flow-control windows, the stream and device limits, the pairing
 * TTL — are the ones an attacker probes, and a one-sided edit (say, raising the cap
 * in Rust only) would produce two endpoints that disagree about what is acceptable
 * while every existing test still passes.
 *
 * So this test reads `crates/dr-dsh-proto/src/lib.rs` and compares. It is a source-text
 * comparison on purpose: there is no build step that could share a value between
 * the languages, and a check that only reads a checked-in file cannot drift from
 * what CI actually compiles.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as protocol from './index.ts';

/** URL of the normative Rust definition. */
const RUST_SOURCE_URL = new URL('../../../crates/dr-dsh-proto/src/lib.rs', import.meta.url);

/** Constant names that must agree across both implementations. */
const SHARED_CONSTANTS = [
  'WIRE_MAJOR',
  'WIRE_MINOR',
  'FRAME_HEADER_LEN',
  'MAX_PAYLOAD_LEN',
  'INITIAL_WINDOW',
  'MAX_WINDOW',
  'CONTROL_STREAM_ID',
  'FIRST_CLIENT_STREAM_ID',
  'FIRST_DAEMON_STREAM_ID',
  'MAX_CONCURRENT_STREAMS',
  'MAX_DEVICES_PER_ROOM',
  'PAIRING_CODE_TTL_SECS',
  'PAIRING_CODE_ENTROPY_BITS',
] as const;

/**
 * Reads one `pub const NAME: type = <expr>;` out of the Rust source and evaluates
 * the integer arithmetic Rust allows there (`64 * 1024`).
 *
 * @param source - the Rust source text.
 * @param name - constant to read.
 * @returns the numeric value.
 * @throws Error when the constant is absent or is not plain integer arithmetic.
 */
function rustConstant(source: string, name: string): number {
  const pattern = new RegExp(`pub const ${name}\\s*:\\s*[A-Za-z0-9_]+\\s*=\\s*([^;]+);`, 'u');
  const match = pattern.exec(source);
  if (match === null) throw new Error(`crates/dr-dsh-proto/src/lib.rs no longer defines ${name}`);
  const expression = (match[1] ?? '').trim();
  if (!/^[0-9_*\s()]+$/u.test(expression)) {
    throw new Error(`${name} is no longer plain integer arithmetic: ${expression}`);
  }
  // Evaluating Rust integer arithmetic here is safe because the character class
  // above admits only digits, underscores, whitespace, parentheses, and `*`.
  const evaluated: unknown = Function(`"use strict"; return (${expression.replaceAll('_', '')});`)();
  assert.equal(typeof evaluated, 'number', `${name}: not a number`);
  return evaluated as number;
}

test('every shared constant matches the Rust definition', () => {
  const rust = readFileSync(RUST_SOURCE_URL, 'utf8');
  for (const name of SHARED_CONSTANTS) {
    const expected = rustConstant(rust, name);
    const actual: unknown = (protocol as Record<string, unknown>)[name];
    assert.equal(actual, expected, `${name}: TypeScript ${String(actual)} vs Rust ${String(expected)}`);
  }
});

test('the shared list covers every constant the Rust definition publishes', () => {
  // If someone adds a protocol constant on the Rust side, it belongs in the shared
  // list — otherwise the two implementations can disagree about it unnoticed.
  const rust = readFileSync(RUST_SOURCE_URL, 'utf8');
  const declared = [...rust.matchAll(/pub const ([A-Z0-9_]+)\s*:/gu)].map(match => match[1] ?? '');
  const numeric = declared.filter(name => {
    try {
      rustConstant(rust, name);
      return true;
    } catch {
      return false;
    }
  });
  const uncovered = numeric.filter(name => !SHARED_CONSTANTS.includes(name as never));
  assert.deepEqual(uncovered, [], `add these to SHARED_CONSTANTS: ${uncovered.join(', ')}`);
});
