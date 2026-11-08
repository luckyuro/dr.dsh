/** Browser API availability only; it cannot establish network or daemon health. */
export interface BrowserCapabilities {
  secure: boolean;
  crypto: boolean;
  websocket: boolean;
  worker: boolean;
  storage: boolean;
  streams: boolean;
}
export type BrowserCheck = { id: keyof BrowserCapabilities; available: boolean };
export function browserChecks(capabilities: BrowserCapabilities): BrowserCheck[] {
  return (['secure', 'crypto', 'websocket', 'worker', 'storage', 'streams'] as const)
    .map(id => ({ id, available: capabilities[id] === true }));
}

/** Detect the transfer itself, since a ReadableStream constructor alone is insufficient. */
export function transferableStreamsAvailable(): boolean {
  if (typeof ReadableStream !== 'function' || typeof structuredClone !== 'function') return false;
  try {
    const stream = new ReadableStream({ start(controller) { controller.close(); } });
    const transferred = structuredClone(stream, { transfer: [stream] });
    void transferred.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
