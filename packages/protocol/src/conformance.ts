/**
 * The cross-language conformance corpus — loader.
 *
 * The vectors live in `conformance/vectors.json` because there are two
 * implementations of this protocol and a corpus that exists twice is a corpus
 * that drifts. Rust reads the same file with `include_str!`; the file is
 * normative, and changing a vector is a wire-breaking change that needs a
 * protocol version bump (see `docs/decisions/0004-wire-protocol.md`).
 *
 * @module
 */

import { readFileSync } from 'node:fs';

import type { Frame, FrameTypeValue } from './index.ts';

/** One carrier-frame vector: bytes on the wire and the frame they decode to. */
export interface FrameVector {
  /** Human-readable name, used in failure messages on both sides. */
  readonly name: string;
  /** Hex of the complete encoded frame. */
  readonly hex: string;
  /** Expected version field, as `[major, minor]`. */
  readonly version: readonly [number, number];
  /** Expected frame type. */
  readonly frameType: number;
  /** Expected flags. */
  readonly flags: number;
  /** Expected stream id. */
  readonly streamId: number;
  /** Hex of the expected payload. */
  readonly payloadHex: string;
}

/** Which validation a rejection vector must trip. */
export type RejectionReason =
  | 'bad_magic'
  | 'version_mismatch'
  | 'payload_too_large'
  | 'unknown_frame_type';

/** A byte sequence that must not decode into a frame, with the reason. */
export interface RejectionVector {
  /** Human-readable name, used in failure messages on both sides. */
  readonly name: string;
  /** Hex of the bytes that must be rejected. */
  readonly hex: string;
  /** Which validation must reject it. */
  readonly reason: RejectionReason;
}

/** The corpus file's shape. */
interface Corpus {
  readonly comment: string;
  readonly frames: readonly FrameVector[];
  readonly rejections: readonly RejectionVector[];
}

/** URL of the normative corpus, so both languages load the same bytes. */
export const CONFORMANCE_VECTORS_URL = new URL('../conformance/vectors.json', import.meta.url);

function loadCorpus(): Corpus {
  const raw = readFileSync(CONFORMANCE_VECTORS_URL, 'utf8');
  const parsed = JSON.parse(raw) as Corpus;
  return parsed;
}

const corpus = loadCorpus();

/** Frames both implementations must decode and re-encode byte for byte. */
export const FRAME_VECTORS: readonly FrameVector[] = corpus.frames;

/** Byte sequences both implementations must reject, for the stated reason. */
export const REJECTION_VECTORS: readonly RejectionVector[] = corpus.rejections;

/** Decodes a hex string into bytes; helper shared by the tests on both sides. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex string has an odd length: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex string has a non-hex pair at ${index * 2}`);
    out[index] = byte;
  }
  return out;
}

/** Encodes bytes as lowercase hex; helper shared by the tests on both sides. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Rebuilds a {@link Frame} from a vector, for round-trip assertions. */
export function frameOf(vector: FrameVector): Frame {
  return {
    version: vector.version,
    frameType: vector.frameType as FrameTypeValue,
    flags: vector.flags,
    streamId: vector.streamId,
    payload: hexToBytes(vector.payloadHex),
  };
}
