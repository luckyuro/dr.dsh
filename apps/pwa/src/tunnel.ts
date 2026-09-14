/**
 * The PWA's tunnel: everything between "the user pasted a room key" and "here are
 * encrypted bytes for the daemon".
 *
 * ## Why this module is separate from the page
 *
 * The browser half of this project has no test runner of its own: a service worker, a
 * `WebSocket`, and a `fetch` handler are all things `node --test` cannot drive. So the
 * *protocol* lives here, behind a minimal socket interface and using only WebCrypto and
 * typed arrays, and the page and the worker are thin wrappers that supply the real
 * objects. That is what makes the client end-to-end testable against the actual Rust
 * daemon in CI, rather than only in a browser someone has to open.
 *
 * ## What it implements
 *
 * The client half of `docs/protocol.md`:
 *
 * 1. **Room derivation.** The room id is HKDF(root, `pairing-root`) truncated to 16
 *    bytes, base64url — the same derivation the daemon performs, so both ends agree on a
 *    room from the shared key alone.
 * 2. **Session establishment.** The client picks a 32-byte salt, seals it under the
 *    *provisional* session (all-zero salt), and then adopts the session the salt defines.
 *    The daemon answers with a sealed acknowledgement, and only after that is it safe to
 *    speak — a request sent earlier races the daemon's own handshake step.
 * 3. **Frames.** `counter (8, big-endian) || AES-256-GCM ciphertext`, with the label,
 *    stream id, and counter authenticated as additional data.
 *
 * @module @dr.dsh/pwa/tunnel
 */

/** The carrier's frame header size, from `dr-dsh-proto`. */
export const FRAME_HEADER_LEN = 18;

/** Largest payload one carrier frame may carry. */
export const MAX_PAYLOAD_LEN = 64 * 1024;

/** Wire protocol version this client speaks. */
export const WIRE_VERSION: readonly [number, number] = [0, 1];

/** The stream that carries connection-level control, including the salt exchange. */
export const CONTROL_STREAM = 0;

/** The one byte the daemon sends once it holds the session the salt defines. */
export const SESSION_ACK = 'k';

/**
 * How long to wait after the acknowledgement for the daemon to say something about devices.
 *
 * The challenge and the acknowledgement are written back to back on one socket, so this only
 * has to cover one round trip plus scheduling. It is not a timeout for a remote operation: a
 * daemon that requires a device has already spoken by the time it elapses, and one that does
 * not is silent by design.
 */
const DEVICE_GRACE_MS = 250;

/** HKDF labels, matching `crates/dr-dsh-crypto`. */
export const LABELS = {
  room: 'dsh-remote/v1/pairing-root',
  clientToDaemon: 'dsh-remote/v1/session/c2d',
  daemonToClient: 'dsh-remote/v1/session/d2c',
  frame: 'dsh-remote/v1/frame',
} as const;

/** The minimal socket this client needs, so a test can supply its own. */
export interface TunnelSocket {
  /** Sends one binary message. */
  send(data: Uint8Array<ArrayBuffer>): void;
  /** Registers the message handler; the socket is single-consumer. */
  receive(handler: (data: Uint8Array<ArrayBuffer>) => void): void;
  /** Registers the close handler. */
  closed(handler: (reason: string) => void): void;
  /** Closes the socket. */
  close(): void;
}

/** Why the tunnel cannot be established or used. */
export class TunnelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TunnelError';
  }
}

/**
 * What a client needs to answer the daemon's device challenge.
 *
 * The key is non-extractable and never leaves the browser's crypto implementation: this type
 * carries a handle to it, not the bytes, so a page that logs an identity logs an id and a
 * label rather than key material.
 */
export interface DeviceIdentity {
  /** The enrolled device's id, base64url — the same string the daemon stores. */
  readonly deviceId: string;
  /** The room this connection is for; the signature binds it so a response cannot be replayed. */
  readonly room: string;
  /** The device's long-lived Ed25519 key pair. */
  readonly key: CryptoKeyPair;
}

/** The message types of the device-authentication step, from `crates/dr-dsh-proto`. */
export const RESUME = {
  challenge: 'resume_challenge',
  response: 'resume_response',
  accept: 'resume_accept',
  refuse: 'resume_reject',
} as const;

/** How a tunnel should be opened. */
export interface TunnelOptions {
  /**
   * Whether this connection runs the device-authentication step. Defaults to `true`.
   *
   * Only pairing turns it off, and it has to: the pairing exchange carries its PAKE messages on
   * the control stream *before* any device exists, so a step that intercepts control frames
   * would consume them as if they were a challenge. Passing `false` for anything else would
   * hand back a tunnel that never proved which device it is — which is the property the device
   * step exists to establish.
   */
  readonly deviceStep?: boolean;
}

/** A live tunnel: sealed, framed, and ready to carry DSH traffic. */
export class Tunnel {
  private sealKey: CryptoKey | null = null;
  private openKey: CryptoKey | null = null;
  private sealCounter = 0;
  private openCounter = 0;
  private acknowledged = false;
  /** Whether the real session (derived from the exchanged salt) is installed. */
  private sessionReady = false;
  /** The device this client claims to be, when it has one. */
  private identity: DeviceIdentity | null = null;
  /**
   * Whether this connection runs the device-authentication step.
   *
   * False for exactly one connection: pairing. A pairing exchange happens *before* any device
   * exists, and the daemon it talks to serves a rendezvous room with the room-key policy — so
   * there is nothing to authenticate against, and the step's interception of the control stream
   * would swallow the PAKE message the exchange is made of. Every other connection runs it; see
   * `docs/protocol.md` § 6.2.
   */
  private readonly deviceStepEnabled: boolean;
  /**
   * Whether the daemon has accepted this client, or requires nothing of it.
   *
   * Starts `false` and is settled by the device step, which every connection runs: the daemon
   * either says something — an acceptance, a challenge, a refusal — or stays silent, and
   * silence means it requires no device. Settling on *silence* rather than on "this client has
   * no identity" is what keeps an unpaired client from being handed a tunnel the daemon has
   * already refused; that bug shipped, and the test for it is in `device.test.ts`.
   */
  private deviceBound: boolean;
  /**
   * Whether the device step is still open.
   *
   * Distinct from {@link deviceBound}: the daemon may refuse a client that never had an
   * identity, and that refusal has to reach the caller. The step is open after the
   * acknowledgement until either the daemon says something or the grace period passes.
   */
  private deviceStepOpen = false;
  /** Resolves or rejects the device-authentication step. */
  private deviceWaiter: Promise<void> = Promise.resolve();
  private acceptDevice: () => void = () => {};
  private refuseDevice: (error: Error) => void = () => {};
  /** The timer that closes the device step when the daemon stays silent. */
  private deviceGrace: ReturnType<typeof setTimeout> | null = null;
  /**
   * Frames that arrived before the session was installed.
   *
   * The daemon sends its acknowledgement the moment it derives the session, so that frame
   * can win the race against this side's own key derivation — an HKDF away, and a network
   * round trip is easily longer than that. Opening it with the provisional key fails
   * authentication, which looks exactly like a wrong room key and sends you hunting for a
   * derivation bug that is not there. Holding the bytes and opening them once the session
   * exists removes the race instead of narrowing it.
   */
  private readonly deferred: Uint8Array<ArrayBuffer>[] = [];
  /**
   * Serializes frame handling.
   *
   * Opening a frame is asynchronous, so dispatching each one as it arrives lets a later
   * frame finish first — and because every frame consumes the next counter, "later" is
   * something this side knows precisely. Out-of-order delivery shows up as a body arriving
   * before its head, which the proxy layer rightly refuses; the frame that actually
   * arrived first is the one whose decryption was merely slower.
   */
  private chain: Promise<void> = Promise.resolve();

  /**
   * Explicit fields rather than constructor parameter properties: parameter properties
   * emit runtime code, which bare type-stripping loaders reject — the same constraint the
   * protocol package documents.
   */
  private readonly socket: TunnelSocket;
  private readonly root: Uint8Array<ArrayBuffer>;
  private readonly acknowledgedWaiter: Promise<void>;
  private readonly acknowledge: () => void;
  private readonly failHandshake: (error: Error) => void;

  private constructor(
    socket: TunnelSocket,
    root: Uint8Array<ArrayBuffer>,
    identity: DeviceIdentity | null,
    deviceStepEnabled: boolean,
  ) {
    this.socket = socket;
    this.root = root;
    this.identity = identity;
    this.deviceStepEnabled = deviceStepEnabled;
    // Every connection runs the device step. A daemon that requires nothing is silent, and the
    // step's grace period is what turns that silence into an answer.
    this.deviceBound = false;
    // A promise created with the tunnel rather than awaited after the handshake: a socket
    // that dies mid-handshake must reject it even though nobody has awaited it yet.
    let acknowledge = (): void => {};
    let failHandshake = (_error: Error): void => {};
    this.acknowledgedWaiter = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      failHandshake = reject;
    });
    this.acknowledge = () => acknowledge();
    this.failHandshake = error => failHandshake(error);

    let acceptDevice = (): void => {};
    let refuseDevice = (_error: Error): void => {};
    this.deviceWaiter = new Promise<void>((resolve, reject) => {
      acceptDevice = resolve;
      refuseDevice = reject;
    });
    this.deviceWaiter.catch(() => {});
    this.acceptDevice = () => acceptDevice();
    this.refuseDevice = error => refuseDevice(error);
    // A connection that does not run the step is bound by construction: there is no device to
    // prove and no challenge coming, and reporting "not bound" would make the handshake below
    // wait for a message that cannot arrive.
    if (!deviceStepEnabled) {
      this.deviceBound = true;
      acceptDevice();
    }
    // An unhandled rejection here would crash a page that simply lost its socket, so the
    // tunnel reports the failure through `failure` as well and this catch keeps the
    // runtime quiet until `open` awaits it.
    this.acknowledgedWaiter.catch(() => {});
    // Wired here, not after the handshake: a socket that closes *during* the handshake is
    // reporting it to nobody otherwise, and the handshake would wait forever for an
    // acknowledgement that is never coming. That is the failure mode where a page hangs on
    // a spinner instead of saying the connection dropped.
    socket.receive(data => this.absorb(data));
    socket.closed(reason => this.fail(new TunnelError(reason)));
  }

  /**
   * Derives the room id a daemon advertises for a room key.
   *
   * One-way, like the daemon's: the relay learns the room id, and a room id must not
   * reveal the key it came from.
   *
   * @param root - the 32-byte room key.
   */
  public static async roomFor(root: Uint8Array<ArrayBuffer>): Promise<string> {
    const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encode(LABELS.room) },
      material,
      16 * 8,
    );
    return base64url(new Uint8Array(bits));
  }

  /**
   * Opens a tunnel over an already-connected socket.
   *
   * @param socket - the carrier socket, parked on the client endpoint.
   * @param root - the 32-byte room key.
   * @param identity - the device this client claims to be, when it has one.
   * @param options - see {@link TunnelOptions}.
   * @returns a tunnel whose session is established and acknowledged.
   * @throws TunnelError when the daemon does not acknowledge the session.
   */
  public static async open(
    socket: TunnelSocket,
    root: Uint8Array<ArrayBuffer>,
    identity: DeviceIdentity | null = null,
    options: TunnelOptions = {},
  ): Promise<Tunnel> {
    const tunnel = new Tunnel(socket, root, identity, options.deviceStep ?? true);
    await tunnel.handshake();
    return tunnel;
  }

  /**
   * Registers a handler for the tunnel ending after it was established.
   *
   * The session's own `closed` hook fires when the *socket* closes, which also happens during a
   * handshake that never completed; this one is about a tunnel that was working and then died,
   * which is the fact a status panel needs to tell "the relay dropped" apart from "the daemon
   * stopped answering".
   *
   * @param handler - called with the reason.
   * @returns a function that unregisters it.
   */
  public onClosed(handler: (reason: string) => void): () => void {
    this.closedHandlers.add(handler);
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  /** Handlers waiting for the tunnel to end. */
  private readonly closedHandlers = new Set<(reason: string) => void>();

  /** Whether the daemon accepted this client as an enrolled device. */
  public get isDeviceBound(): boolean {
    return this.deviceBound;
  }

  /** Whether the daemon has acknowledged the session. */
  public get isEstablished(): boolean {
    return this.acknowledged;
  }

  /**
   * Seals a payload and writes it as one carrier frame.
   *
   * @param streamId - which stream the payload belongs to.
   * @param plaintext - the bytes to carry.
   * @throws TunnelError before the session is established, or when sealing fails.
   */
  public async send(streamId: number, plaintext: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.sealKey === null) {
      throw new TunnelError('the session is not established yet');
    }
    const counter = this.sealCounter;
    this.sealCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(streamId, counter) },
        this.sealKey,
        plaintext,
      ),
    );
    const body = new Uint8Array(8 + sealed.length);
    new DataView(body.buffer).setBigUint64(0, BigInt(counter), false);
    body.set(sealed, 8);
    this.socket.send(carrier(streamId, body));
  }

  /** Closes the underlying socket. */
  public close(): void {
    if (this.deviceGrace !== null) {
      clearTimeout(this.deviceGrace);
      this.deviceGrace = null;
    }
    this.socket.close();
  }

  /** Performs the salt exchange and waits for the daemon's acknowledgement. */
  private async handshake(): Promise<void> {
    const provisional = await deriveKey(this.root, new Uint8Array(32), LABELS.clientToDaemon);
    const provisionalOpen = await deriveKey(this.root, new Uint8Array(32), LABELS.daemonToClient);
    this.sealKey = provisional;
    this.openKey = provisionalOpen;

    const salt = crypto.getRandomValues(new Uint8Array(32));
    await this.sendSealed(CONTROL_STREAM, salt);
    // Carry the write across the derivation: the salt consumed counter zero of the
    // provisional session, so the client's next frame is counter one. A fresh session
    // starts counting from zero, and the daemon — which carries its matching read — would
    // refuse a frame sent at zero as out of order.
    const written = this.sealCounter;

    this.sealKey = await deriveKey(this.root, salt, LABELS.clientToDaemon);
    const realOpen = await deriveKey(this.root, salt, LABELS.daemonToClient);
    this.openKey = realOpen;
    this.sealCounter = written;
    // From here the session exists, so anything the daemon sent while this side was
    // deriving can be opened with the key it was sealed under.
    this.sessionReady = true;
    this.drainDeferred();

    // No client confirmation frame. This side once sent one, on the belief that the daemon read
    // a frame after deriving — and the daemon's handshake ends with *its* acknowledgement, so
    // that frame was read by whatever the daemon read next instead: on an enrolled daemon as the
    // answer to its device challenge (refused as a bad proof), and on a pairing room as the
    // client's PAKE message (`a SPAKE2 message is 33 bytes, got 1`, measured against a real
    // `drdshd pair`). Both failures are invisible in a stand-in daemon that skips the frame
    // because the test believes it is expected, which is exactly how it survived.
    //
    // The acknowledgement below is the handshake's end on both sides: the daemon proved it
    // holds the session, and the next frame either side sends is real content.

    await this.acknowledgedWaiter;

    // A daemon that requires a device speaks immediately after its acknowledgement: with a
    // challenge when this client has an identity to answer with, and with a refusal when it
    // does not. A daemon that requires nothing stays silent.
    //
    // The wait is therefore driven by what actually arrived, not by whether this client holds
    // an identity. Waiting whenever an identity exists hangs a client whose daemon never asks;
    // waiting only when an identity exists hangs the opposite case — an *unpaired* client is
    // refused, never told, and left staring at a tunnel it will never be allowed to use. The
    // first of those was found by reading the code, the second by running it.
    if (!this.deviceBound) {
      await this.deviceWaiter;
    }
    // A device step that ended without the daemon accepting this client is a refusal, whether
    // it arrived as a message or as a closed socket. Returning here would hand the caller a
    // tunnel that reports itself established and then serves nothing — the failure mode this
    // check exists to make impossible.
    if (!this.deviceBound) {
      throw new TunnelError('the daemon refused this device');
    }
  }

  /** Seals with the current session and writes the frame. */
  private async sendSealed(streamId: number, plaintext: Uint8Array<ArrayBuffer>): Promise<void> {
    const key = this.sealKey;
    if (key === null) throw new TunnelError('the session is not established yet');
    const counter = this.sealCounter;
    this.sealCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(streamId, counter) },
        key,
        plaintext,
      ),
    );
    const body = new Uint8Array(8 + sealed.length);
    new DataView(body.buffer).setBigUint64(0, BigInt(counter), false);
    body.set(sealed, 8);
    this.socket.send(carrier(streamId, body));
  }

  /** Opens one inbound frame and either resolves the handshake or dispatches it. */
  private absorb(frame: Uint8Array<ArrayBuffer>): void {
    if (!this.sessionReady) {
      this.deferred.push(frame);
      return;
    }
    this.enqueue(frame);
  }

  /** Opens everything that arrived while the session was being derived, in order. */
  private drainDeferred(): void {
    // Spliced before queueing: a frame arriving now must not be overtaken by one that
    // arrived while the session did not yet exist.
    const held = this.deferred.splice(0, this.deferred.length);
    for (const frame of held) this.enqueue(frame);
  }

  /** Chains one frame onto the handling order, so frames are opened strictly in sequence. */
  private enqueue(frame: Uint8Array<ArrayBuffer>): void {
    // One assignment, not two. `this.chain = this.chain.then(...)` followed by
    // `this.chain = this.chain.catch(...)` reads the field twice, so two frames arriving in the
    // same turn — which is exactly what a socket delivering a burst does — both start from the
    // same predecessor and the second assignment discards the first frame's handler. The
    // discarded link then rejects with nobody attached, which surfaces as an unhandled rejection
    // rather than as anything a caller can see.
    this.chain = this.chain
      .then(
        () => this.openFrame(frame),
        // A previous failure must not stall the frames behind it; it is reported below.
        () => this.openFrame(frame),
      )
      .catch(error => this.fail(error as Error));
  }

  private async openFrame(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const { streamId, body } = parseCarrier(frame);
    const key = this.openKey;
    if (key === null) throw new TunnelError('a frame arrived before the session existed');
    if (body.length < 8) throw new TunnelError('a sealed frame is missing its counter');
    const counter = Number(new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(0, false));
    if (counter !== this.openCounter) {
      // A gap means the relay dropped or reordered a frame. Continuing would silently lose
      // part of a stream, so this ends the connection instead.
      throw new TunnelError(`frame ${counter} arrived out of order; expected ${this.openCounter}`);
    }
    let plaintext: Uint8Array<ArrayBuffer>;
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(streamId, counter) },
          key,
          body.subarray(8),
        ),
      );
    } catch {
      throw new TunnelError('a frame failed authentication');
    }
    this.openCounter += 1;

    if (!this.acknowledged && streamId === CONTROL_STREAM && isAck(plaintext)) {
      this.acknowledged = true;
      this.acknowledge();
      // A connection that does not run the device step hands the control stream straight to its
      // subscriber: on a pairing room the very next frame is the daemon's PAKE message, and
      // intercepting it would both hide it and try to parse it as a device message.
      if (!this.deviceStepEnabled) {
        this.deviceBound = true;
        return;
      }
      // The device step opens here and is settled by whatever comes next. The grace period is
      // short because these messages arrive back to back on one socket: a daemon that meant to
      // say something has already said it by the time a round trip has passed, and one that
      // stays silent has nothing to say.
      this.deviceStepOpen = true;
      this.deviceGrace = setTimeout(() => {
        // Silence: this daemon requires no device, so the client is bound as far as it can tell
        // — and it will find out otherwise on the first request it sends.
        this.settleDevice(true);
      }, DEVICE_GRACE_MS);
      return;
    }
    // The device step owns the control stream until it is done: a challenge, an acceptance and
    // a refusal are all messages no subscriber asked for, and handing them to one would look
    // to that subscriber like a malformed proxy reply.
    if (streamId === CONTROL_STREAM && this.deviceStepOpen) {
      void this.handleDeviceMessage(plaintext).catch(error => {
        this.deviceBound = false;
        this.refuseDevice(error as Error);
        this.fail(error as Error);
      });
      return;
    }
    this.dispatch({ streamId, payload: plaintext });
  }

  /** Answers a challenge, or records the daemon's verdict. */
  private async handleDeviceMessage(plaintext: Uint8Array<ArrayBuffer>): Promise<void> {
    const message: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    const type = (message as { type?: unknown }).type;
    if (type === RESUME.accept) {
      this.settleDevice(true);
      return;
    }
    if (type === RESUME.refuse) {
      const reason = (message as { reason?: unknown }).reason;
      throw new TunnelError(
        reason === 'not_paired'
          ? 'this device is not paired with that daemon any more'
          : 'the daemon refused this device',
      );
    }
    if (type !== RESUME.challenge) {
      throw new TunnelError('the daemon sent something unexpected during device authentication');
    }
    if (this.identity === null) {
      // The daemon asked a client that never claimed an identity. Answering is impossible and
      // guessing would be worse, so the tunnel ends with something the user can act on.
      throw new TunnelError('the daemon requires a paired device and this client is not paired');
    }

    const identity = this.identity;
    if (identity === null) {
      throw new TunnelError('the daemon asked for a device this client does not have');
    }
    const nonce = (message as { nonce?: unknown }).nonce;
    if (typeof nonce !== 'string') {
      throw new TunnelError('the challenge carried no nonce');
    }
    const nonceBytes = base64urlDecode(nonce);
    if (nonceBytes.length !== 32) {
      throw new TunnelError('the challenge nonce is not 32 bytes');
    }
    // The signed message is the nonce followed by the room, matching `dr_dsh_crypto::resume_message`.
    // The room is bound in so a response captured on one room cannot be replayed on another.
    const signed = new Uint8Array(nonceBytes.length + identity.room.length);
    signed.set(nonceBytes, 0);
    signed.set(encode(identity.room), nonceBytes.length);
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, identity.key.privateKey, signed),
    );
    const response = {
      type: RESUME.response,
      device_id: identity.deviceId,
      signature: base64url(signature),
    };
    await this.sendSealed(CONTROL_STREAM, encode(JSON.stringify(response)));
  }

  /** Ends the device step, once, with the daemon's verdict. */
  private settleDevice(bound: boolean): void {
    if (this.deviceGrace !== null) {
      clearTimeout(this.deviceGrace);
      this.deviceGrace = null;
    }
    this.deviceStepOpen = false;
    this.deviceBound = bound;
    if (bound) this.acceptDevice();
  }

  /** Delivers a payload to everyone waiting on that stream. */
  private dispatch(message: { streamId: number; payload: Uint8Array<ArrayBuffer> }): void {
    const handlers = this.listeners.get(message.streamId);
    if (handlers === undefined || handlers.size === 0) {
      this.pending.push(message);
      return;
    }
    // Iterated over a copy: a handler is allowed to unsubscribe itself (the control client's reply
    // matcher does exactly that), and mutating the set mid-iteration would skip the next handler.
    for (const handler of [...handlers]) handler(message.payload);
  }

  /**
   * Stream subscribers, by stream id.
   *
   * A *set* per stream, and that is a correction rather than a detail: this used to be one handler per
   * stream, with the unsubscribe function deleting whatever was registered for that id. Two
   * subscribers therefore behaved as "the second one silently takes the stream, and whoever
   * unsubscribes first leaves nobody listening". Found by the crash-report smoke, where a raw control
   * frame read alongside the control client killed the client's subscription: its next request was
   * answered on the wire and never seen by anything. The browser has the same shape — the shell
   * subscribes to the proxy's streams while the control client owns stream 0 — so the fault was one
   * reply away from a user-visible hang.
   */
  private readonly listeners = new Map<number, Set<(payload: Uint8Array<ArrayBuffer>) => void>>();

  /** Payloads that arrived before anyone subscribed. */
  private readonly pending: { streamId: number; payload: Uint8Array<ArrayBuffer> }[] = [];

  /**
   * Subscribes to one stream.
   *
   * @param streamId - the stream to watch.
   * @param handler - called for each payload on it.
   * Several handlers may watch one stream, and each unsubscribe removes only its own: the control
   * client and a caller reading raw frames on the same stream must not be able to evict each other.
   *
   * @returns a function that unsubscribes this handler.
   */
  public on(streamId: number, handler: (payload: Uint8Array<ArrayBuffer>) => void): () => void {
    const handlers = this.listeners.get(streamId) ?? new Set();
    handlers.add(handler);
    this.listeners.set(streamId, handlers);
    // Buffered payloads are handed to the new subscriber only, and replayed in arrival order: the
    // ones a previous subscriber already consumed are gone, which is why the buffer is drained here
    // rather than kept for everyone who ever subscribes.
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const buffered = this.pending[index];
      if (buffered !== undefined && buffered.streamId === streamId) {
        this.pending.splice(index, 1);
        handler(buffered.payload);
      }
    }
    let stopped = false;
    return () => {
      // Removes only this handler, and only once: a caller that stops twice must not remove a
      // subscription that was registered after it.
      if (stopped) return;
      stopped = true;
      const current = this.listeners.get(streamId);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) this.listeners.delete(streamId);
    };
  }

  /** Marks the tunnel dead and ends the handshake if it was still running. */
  private fail(error: Error): void {
    // Told once: a tunnel that fails twice is one failure, and a panel that redrew on every
    // notification would report a count rather than a state.
    const wasAlive = this.acknowledged && this.closedError === null;
    if (wasAlive) {
      for (const handler of [...this.closedHandlers]) handler(error.message);
    }
    this.closedError = error;
    this.failHandshake(error);
    // A socket that dies during the device step is a refusal this client never got to read.
    // Without this the step stays open forever and the handshake waits for a message that
    // cannot arrive, because the connection that would carry it is already gone.
    if (this.deviceStepOpen) {
      this.deviceStepOpen = false;
      this.refuseDevice(error);
    }
    for (const streamId of [...this.listeners.keys()]) {
      this.dispatch({ streamId, payload: new Uint8Array(0) });
    }
  }

  /** The reason the tunnel ended, once it has. */
  private closedError: Error | null = null;

  /** The failure that ended the tunnel, or `null` while it is alive. */
  public get failure(): Error | null {
    return this.closedError;
  }
}

/**
 * Derives one direction's key with HKDF-SHA256.
 *
 * @param root - the room key.
 * @param salt - the connection salt.
 * @param info - the direction label.
 */
export async function deriveKey(
  root: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encode(info) },
    material,
    32 * 8,
  );
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Builds the 12-byte nonce for a counter: four zero bytes, then the big-endian counter.
 *
 * @param counter - the frame counter.
 */
export function nonceBytes(counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

/**
 * Additional authenticated data for a frame: the label, the stream, and the counter.
 *
 * Binding all three is what stops a relay from moving a payload to another stream or
 * rewriting the counter to make a replayed frame look like the next expected one.
 *
 * @param streamId - the stream the frame belongs to.
 * @param counter - the frame counter.
 */
export function additionalData(streamId: number, counter: number): Uint8Array<ArrayBuffer> {
  const label = encode(LABELS.frame);
  const aad = new Uint8Array(label.length + 4 + 8);
  aad.set(label, 0);
  const view = new DataView(aad.buffer);
  view.setUint32(label.length, streamId, false);
  view.setBigUint64(label.length + 4, BigInt(counter), false);
  return aad;
}

/**
 * Wraps a sealed body in a carrier frame.
 *
 * @param streamId - the stream the frame belongs to.
 * @param body - the sealed body, counter included.
 */
export function carrier(streamId: number, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (body.length > MAX_PAYLOAD_LEN) {
    throw new TunnelError(`a frame may carry at most ${MAX_PAYLOAD_LEN} bytes`);
  }
  const frame = new Uint8Array(FRAME_HEADER_LEN + body.length);
  frame.set([0x44, 0x52], 0); // 'DR'
  const view = new DataView(frame.buffer);
  view.setUint16(2, WIRE_VERSION[0], false);
  view.setUint16(4, WIRE_VERSION[1], false);
  view.setUint16(6, 0x10, false); // Data
  view.setUint16(8, 0, false);
  view.setUint32(10, streamId, false);
  view.setUint32(14, body.length, false);
  frame.set(body, FRAME_HEADER_LEN);
  return frame;
}

/**
 * Reads a carrier frame.
 *
 * @param frame - the bytes as they arrived.
 * @returns the stream id and the sealed body.
 * @throws TunnelError when the frame is not one this client can use.
 */
export function parseCarrier(
  frame: Uint8Array<ArrayBuffer>,
): { streamId: number; body: Uint8Array<ArrayBuffer> } {
  if (frame.length < FRAME_HEADER_LEN) throw new TunnelError('a frame is shorter than its header');
  if (frame[0] !== 0x44 || frame[1] !== 0x52) throw new TunnelError('a frame has bad magic');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const major = view.getUint16(2, false);
  if (major !== WIRE_VERSION[0]) throw new TunnelError(`the peer speaks wire ${major}, this client speaks ${WIRE_VERSION[0]}`);
  const type = view.getUint16(6, false);
  if (type !== 0x10) throw new TunnelError('a non-data frame arrived on a data stream');
  const declared = view.getUint32(14, false);
  if (declared > MAX_PAYLOAD_LEN) throw new TunnelError('a frame declares more than one frame may carry');
  if (frame.length !== FRAME_HEADER_LEN + declared) throw new TunnelError('a frame does not match its declared length');
  // `slice` rather than `subarray`: it returns a fresh view over an `ArrayBuffer`, which is
  // what WebCrypto's `BufferSource` accepts.
  return { streamId: view.getUint32(10, false), body: frame.slice(FRAME_HEADER_LEN) };
}

/** Whether a control-stream payload is the daemon's acknowledgement. */
function isAck(plaintext: Uint8Array<ArrayBuffer>): boolean {
  return plaintext.length === 1 && String.fromCharCode(plaintext[0] ?? 0) === SESSION_ACK;
}

/** Encodes text as UTF-8. */
function encode(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** Encodes bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Decodes unpadded base64url.
 *
 * @param text - the encoded value.
 * @throws TunnelError when the text is not base64url, which during a handshake means the peer
 * is not speaking this protocol.
 */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TunnelError('a value was not base64url');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
