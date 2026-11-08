// The relay serves flat ESM files, so resolve the shared workspace imports at packaging time.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await copyFile(new URL('packages/validation/src/index.js', root), new URL('apps/pwa/dist/validation.js', root));
const credential = new URL('apps/pwa/dist/credential.js', root);
await writeFile(credential, (await readFile(credential, 'utf8')).replaceAll("'@dr.dsh/validation'", "'./validation.js'"));
await copyFile(new URL('packages/protocol/dist/proxy-ws.js', root), new URL('apps/pwa/dist/proxy-ws.js', root));
for (const name of ['proxy.js', 'interface-bridge.js', 'websocket.js']) {
  const path = new URL(`apps/pwa/dist/${name}`, root);
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll("'@dr.dsh/protocol/proxy-ws'", "'./proxy-ws.js'"));
}
