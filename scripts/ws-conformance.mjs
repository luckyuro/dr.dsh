/**
 * Writes the bytes the client's WebSocket encoder produces, for the Rust daemon to decode.
 *
 * The mirror of a wire format is worthless if nothing ever compares it to the original: the client
 * writes these messages and the daemon reads them, so the only check that means anything is the
 * daemon's own decoder reading the client's own bytes. 
 * is that check, and it reads the file this script writes — so  fails if the two
 * ever disagree.
 */
import { writeFileSync } from 'node:fs';
import { encodeWsOpen, encodeWsData } from '../apps/pwa/src/proxy.ts';
const hex = b => Buffer.from(b).toString('hex');
const vectors = {
  open: hex(encodeWsOpen(1, '/api/remote.mux')),
  text: hex(encodeWsData(1, { kind: 'text', text: 'hello' })),
  close: hex(encodeWsData(1, { kind: 'close' })),
};
writeFileSync('target/ws-vectors.json', JSON.stringify(vectors));
console.log('wrote target/ws-vectors.json');
