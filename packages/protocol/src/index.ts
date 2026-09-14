/**
 * dr.dsh wire protocol — the TypeScript view.
 *
 * This package is a **mirror**, not the source of truth. `crates/dr-dsh-proto` owns
 * the normative definition; `src/conformance.ts` carries the shared corpus that
 * fails the build when the two drift. When the two disagree, Rust is right and
 * this file is the bug (ADR-0004).
 *
 * Two planes, and the boundary matters:
 *
 * - **Carrier** ({@link FrameType}, {@link encodeFrame}, {@link decodeFrame}) is
 *   what the relay understands: framing and stream ids, no semantics.
 * - **Payload** (`control.ts`) rides inside encrypted carrier payloads and is
 *   never visible to the relay.
 *
 * @module @dr.dsh/protocol
 */

/** Wire protocol major version. A mismatch refuses the connection. */
export const WIRE_MAJOR = 0;

/** Wire protocol minor version. Additive; negotiated downward. */
export const WIRE_MINOR = 1;

/** Fixed frame header size: 2 magic + 2+2 version + 2 type + 2 flags + 4 id + 4 length. */
export const FRAME_HEADER_LEN = 18;

/** Frame magic, the ASCII bytes `DR`. */
export const FRAME_MAGIC = Uint8Array.of(0x44, 0x52);

/** Largest payload one frame may carry. */
export const MAX_PAYLOAD_LEN = 64 * 1024;

/** Stream id of the connection control stream (handshake, ping). */
export const CONTROL_STREAM_ID = 0;

/** First stream id a client may allocate (odd). */
export const FIRST_CLIENT_STREAM_ID = 1;

/** First stream id a daemon may allocate for server-pushed streams (even). */
export const FIRST_DAEMON_STREAM_ID = 2;

/** Initial per-stream flow-control window, in bytes. */
export const INITIAL_WINDOW = 256 * 1024;

/** Largest flow-control window a peer may advertise. */
export const MAX_WINDOW = 16 * 1024 * 1024;

/** Largest number of streams open at once on one connection. */
export const MAX_CONCURRENT_STREAMS = 64;

/** Largest number of devices a single room may register. */
export const MAX_DEVICES_PER_ROOM = 16;

/** Lifetime of a pairing code, in seconds. */
export const PAIRING_CODE_TTL_SECS = 300;

/**
 * Entropy of a pairing code, in bits, once its grouping is removed.
 *
 * Published in the protocol rather than hidden in an implementation because it is
 * the security parameter users are implicitly trusting when they read a code off
 * one screen and type it into another.
 */
export const PAIRING_CODE_ENTROPY_BITS = 40;

/**
 * What a frame means to the carrier. Values are the wire encoding.
 *
 * A frozen object rather than a TypeScript `enum`: enums emit runtime code that
 * bare type-stripping loaders reject, and this module has to run unbundled in
 * node's test runner and in the browser alike.
 */
export const FrameType = {
  /** Opens a stream and carries the client's binding to a room or device. */
  Open: 0x0001,
  /** Accepts a previously opened stream. */
  OpenAck: 0x0002,
  /** Refuses a stream open; the payload carries a reason code. */
  OpenReject: 0x0003,
  /** Application bytes for a stream; the payload is endpoint-encrypted. */
  Data: 0x0010,
  /** Half-close: no more data from this sender on this stream. */
  Fin: 0x0011,
  /** Aborts a stream; the payload carries a reason code. */
  Reset: 0x0012,
  /** Grants the peer permission to send more bytes on a stream. */
  WindowUpdate: 0x0020,
  /** Liveness probe, answered by `Pong`. */
  Ping: 0x0030,
  /** Answer to `Ping`. */
  Pong: 0x0031,
  /** Connection-level error; the connection closes afterwards. */
  GoAway: 0x007f,
} as const;

/** One of the {@link FrameType} wire values. */
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** A decoded frame: cleartext routing header plus opaque payload. */
export interface Frame {
  /** Protocol version the frame was written with, as `[major, minor]`. */
  readonly version: readonly [number, number];
  /** What the frame is. */
  readonly frameType: FrameTypeValue;
  /** Frame-type-specific flags; zero unless the type defines them. */
  readonly flags: number;
  /** Stream this frame belongs to. */
  readonly streamId: number;
  /** Payload bytes, exactly as they arrived. */
  readonly payload: Uint8Array;
}

/** Raised for any protocol violation; mirrors `dr_dsh_proto::ProtoError`. */
export class ProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Encodes one frame.
 *
 * @param frame - the frame to write.
 * @returns the encoded bytes, header and payload.
 * @throws ProtocolError when the payload exceeds {@link MAX_PAYLOAD_LEN}; the
 * caller is expected to have chunked already, so this is a programming fault.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  const payloadLength = frame.payload.byteLength;
  if (payloadLength > MAX_PAYLOAD_LEN) {
    throw new ProtocolError(`payload ${payloadLength} exceeds the maximum ${MAX_PAYLOAD_LEN}`);
  }
  const out = new Uint8Array(FRAME_HEADER_LEN + payloadLength);
  const view = new DataView(out.buffer);
  out[0] = FRAME_MAGIC[0] as number;
  out[1] = FRAME_MAGIC[1] as number;
  view.setUint16(2, frame.version[0]);
  view.setUint16(4, frame.version[1]);
  view.setUint16(6, frame.frameType);
  view.setUint16(8, frame.flags);
  view.setUint32(10, frame.streamId);
  view.setUint32(14, payloadLength);
  out.set(frame.payload, FRAME_HEADER_LEN);
  return out;
}

/**
 * Decodes exactly one frame from the front of `buffer`.
 *
 * @param buffer - bytes received so far.
 * @returns the frame and how many bytes it consumed, or `undefined` when
 * `buffer` does not yet hold a complete frame (read more and retry).
 * @throws ProtocolError on bad magic, a major-version mismatch, an unknown
 * frame type, or an oversized declared length.
 */
export function decodeFrame(
  buffer: Uint8Array,
): { readonly frame: Frame; readonly consumed: number } | undefined {
  if (buffer.byteLength < FRAME_HEADER_LEN) return undefined;
  if (buffer[0] !== FRAME_MAGIC[0] || buffer[1] !== FRAME_MAGIC[1]) {
    throw new ProtocolError('bad frame magic');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const major = view.getUint16(2);
  if (major !== WIRE_MAJOR) {
    throw new ProtocolError(`incompatible wire major version: peer speaks ${major}, we speak ${WIRE_MAJOR}`);
  }
  const minor = view.getUint16(4);
  const rawType = view.getUint16(6);
  const flags = view.getUint16(8);
  const streamId = view.getUint32(10);
  const payloadLength = view.getUint32(14);
  if (payloadLength > MAX_PAYLOAD_LEN) {
    throw new ProtocolError(`declared payload length ${payloadLength} exceeds the maximum ${MAX_PAYLOAD_LEN}`);
  }
  const total = FRAME_HEADER_LEN + payloadLength;
  if (buffer.byteLength < total) return undefined;
  const frameType = frameTypeFromWire(rawType);
  return {
    frame: {
      version: [major, minor],
      frameType,
      flags,
      streamId,
      payload: buffer.slice(FRAME_HEADER_LEN, total),
    },
    consumed: total,
  };
}

/**
 * Maps a wire value to a {@link FrameType}.
 *
 * @throws ProtocolError for an unknown type, which the carrier turns into a
 * `GoAway`.
 */
export function frameTypeFromWire(value: number): FrameTypeValue {
  switch (value) {
    case 0x0001:
      return FrameType.Open;
    case 0x0002:
      return FrameType.OpenAck;
    case 0x0003:
      return FrameType.OpenReject;
    case 0x0010:
      return FrameType.Data;
    case 0x0011:
      return FrameType.Fin;
    case 0x0012:
      return FrameType.Reset;
    case 0x0020:
      return FrameType.WindowUpdate;
    case 0x0030:
      return FrameType.Ping;
    case 0x0031:
      return FrameType.Pong;
    case 0x007f:
      return FrameType.GoAway;
    default:
      throw new ProtocolError(`unknown frame type 0x${value.toString(16).padStart(4, '0')}`);
  }
}
