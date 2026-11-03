/** HTTP requests and interface sockets share one wire namespace for each tunnel. */
const nextStreams = new WeakMap<object, number>();

/** Never reuse a stream while its tunnel can still deliver a late response. */
export function allocateProxyStream(tunnel: object): number {
  const stream = nextStreams.get(tunnel) ?? 1;
  if (stream > 0xffff_ffff) {
    throw new Error('This connection has used every proxy stream. Reconnect to your computer before continuing.');
  }
  nextStreams.set(tunnel, stream + 2);
  return stream;
}
