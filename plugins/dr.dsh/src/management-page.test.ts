import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { createManagementHandler } from './management-web.ts';
import { createLocalManagementAuthority } from './manager.ts';

const storageKey = 'drdsh.management.job';
const jobId = 'a'.repeat(32);
const prefix = '/private/test-instance';
type Reply = { status?: number; body: unknown };
type FetchOptions = { body?: string; headers: Record<string, string>; method: string };
type ResponsePort = { status: number; ok: boolean; json(): Promise<unknown> };
type Listener = (event: { preventDefault(): void }) => unknown;

class PageElement {
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  className = '';
  open = false;
  dataset: Record<string, string> = {};
  listeners = new Map<string, Listener>();
  children: PageElement[] = [];
  files: { size: number; text(): Promise<string> }[] = [];
  flags = new Map<string, boolean>();
  classList = { toggle: (name: string, value: boolean) => this.flags.set(name, value) };
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, listener); }
  append(...children: PageElement[]): void { this.children.push(...children); }
  replaceChildren(...children: PageElement[]): void { this.children = children; this.textContent = ''; }
  querySelector(): PageElement { return this; }
}

const success = (result: unknown): Reply => ({ body: { version: 1, requestId: 'page-test', ok: true, result } });
const terminal = (state: string) => success({ jobId, operation: 'service.disable', createdAtMs: 1, state, ...(state === 'failed' ? { error: { message: 'The service could not be changed.' } } : {}) });
const missing = (): Reply => ({ body: { version: 1, requestId: 'page-test', ok: false, error: { code: 'job_request_failed', message: 'The saved job no longer exists.', retryable: false } } });

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'the page action must settle');
    await delay(5);
  }
}

async function page(options: {
  saved?: string;
  replies?: (Reply | Error)[];
  fetch?: (path: string, init: FetchOptions) => Promise<ResponsePort>;
  clipboardDenied?: boolean;
} = {}) {
  const clipboard: string[] = [];
  const elements = new Map<string, PageElement>();
  const get = (id: string): PageElement => {
    let found = elements.get(id);
    if (!found) { found = new PageElement(); elements.set(id, found); }
    return found;
  };
  const submit = get('submit-job'); submit.dataset.operation = 'service.disable';
  const buttons = [submit, get('unlock-button'), get('lock'), get('refresh'), get('jobs-refresh')];
  const storage = new Map<string, string>();
  if (options.saved !== undefined) storage.set(storageKey, options.saved);
  const timers = new Map<number, { callback: () => unknown; milliseconds: number }>();
  let nextTimer = 0;
  const requests: { operation: string; params: unknown }[] = [];
  const replies = [...(options.replies ?? [])];
  const fetchPage = async (path: string, init: FetchOptions): Promise<ResponsePort> => {
    if (options.fetch) return options.fetch(path, init);
    let reply: Reply;
    if (path.endsWith('/access')) reply = { body: { capabilityFile: '/private/local-unlock' } };
    else if (path.endsWith('/unlock')) reply = { body: { token: 't'.repeat(43), expiresAtMs: Date.now() + 900_000 } };
    else if (path.endsWith('/state')) reply = { body: { prefix, installed: false, hasConfiguration: false, host: { port: 3080, profile: { name: 'web' } } } };
    else {
      const request = JSON.parse(init.body ?? '{}') as { operation: string; params: unknown };
      requests.push(request);
      if (request.operation === 'job.list') reply = success({ jobs: [] });
      else if (request.operation === 'service.disable') reply = terminal('queued');
      else {
        assert.equal(request.operation, 'job.status');
        const next = replies.shift();
        assert.ok(next, 'unexpected extra polling request');
        if (next instanceof Error) throw next;
        reply = next;
      }
    }
    const status = reply.status ?? 200;
    return { status, ok: status >= 200 && status < 300, async json() { return reply.body; } };
  };
  const context = createContext({
    document: {
      getElementById: get,
      createElement: () => new PageElement(),
      querySelectorAll: (selector: string) => selector === 'button' ? buttons : selector === '[data-operation]' ? [submit] : [],
    },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    location: { hash: '', pathname: '/_drdsh/manage', search: '' }, history: { replaceState() {} },
    URLSearchParams, AbortSignal, Date, confirm: () => true, fetch: fetchPage,
    navigator: { clipboard: { async writeText(text: string) {
      if (options.clipboardDenied) throw new Error('clipboard denied');
      clipboard.push(text);
    } } },
    setTimeout(callback: () => unknown, milliseconds = 0) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  runInContext(await readFile(new URL('../web/manage.js', import.meta.url), 'utf8'), context);
  await until(() => !submit.disabled);
  const click = async (id: string, type = 'click') => {
    const listener = get(id).listeners.get(type);
    assert.ok(listener, `the actual page must register ${id}`);
    listener({ preventDefault() {} });
    await until(() => !submit.disabled);
  };
  const polls = () => [...timers.entries()].filter(([, value]) => value.milliseconds < 60_000);
  return {
    get, storage, requests, polls, click, clipboard,
    async unlock(capability = 'c'.repeat(43)) { get('capability').value = capability; await click('unlock-form', 'submit'); },
    async poll() {
      const pending = polls();
      assert.equal(pending.length, 1, 'exactly one recovery poll should be scheduled');
      const [id, timer] = pending[0]!;
      timers.delete(id); await timer.callback();
    },
  };
}

function pairingService(replies: (Reply | Error | Promise<Reply>)[] = []) {
  const requests: { operation: string; params: { pairingId?: string } }[] = [];
  let current: { pairingId: string; state: string } | undefined;
  let sequence = 0;
  return {
    requests,
    async fetch(path: string, init: FetchOptions): Promise<ResponsePort> {
      let reply: Reply;
      if (path.endsWith('/access')) reply = { body: { capabilityFile: '/private/local-unlock' } };
      else if (path.endsWith('/unlock')) reply = { body: { token: 't'.repeat(43), expiresAtMs: Date.now() + 900_000 } };
      else if (path.endsWith('/state')) reply = { body: { prefix, installed: true, hasConfiguration: true, host: { port: 3080, profile: { name: 'web' } } } };
      else {
        const request = JSON.parse(init.body ?? '{}') as { operation: string; params: { pairingId?: string } };
        requests.push(request);
        switch (request.operation) {
          case 'status': reply = success({ runtime: { ok: true, result: { pid: 1234, pairing: current } } }); break;
          case 'devices.list': reply = success({ devices: [] }); break;
          case 'job.list': reply = success({ jobs: [] }); break;
          case 'pair.begin': {
            assert.equal(current, undefined, 'the page must not submit another begin while a pairing is pending');
            sequence += 1;
            current = { pairingId: String(sequence).padStart(32, '0'), state: 'pending' };
            reply = success({ ...current, code: `PRIVATE-CODE-${sequence}`, relay: 'ws://127.0.0.1:8765', expiresAtMs: Date.now() + 300_000 });
            break;
          }
          case 'pair.status': {
            const next = replies.shift();
            if (next instanceof Error) throw next;
            reply = next === undefined ? success(current) : await next;
            break;
          }
          case 'pair.cancel':
            assert.equal(request.params.pairingId, current?.pairingId);
            current = undefined;
            reply = success({ state: 'cancelled' });
            break;
          default: throw new Error(`Unexpected pairing fixture operation: ${request.operation}`);
        }
      }
      const status = reply.status ?? 200;
      return { status, ok: status >= 200 && status < 300, async json() { return reply.body; } };
    },
  };
}

test('copying a pairing is explicit, uses the browser address and stops after cancellation or locking', async () => {
  const service = pairingService();
  const app = await page({ fetch: service.fetch });
  await app.unlock(); await app.click('pair-begin');
  assert.deepEqual(app.clipboard, []);
  assert.equal(app.get('pair-copy').hidden, false);
  assert.match(app.get('pair-detail').textContent, /http:\/\/127\.0\.0\.1:8765/u);
  await app.click('pair-copy');
  assert.deepEqual(app.clipboard, ['PRIVATE-CODE-1']);
  await app.click('pair-cancel');
  assert.equal(app.get('pair-copy').hidden, true);
  await app.click('pair-copy');
  assert.equal(app.clipboard.length, 1);
  await app.click('pair-begin'); await app.click('lock');
  assert.equal(app.get('pair-copy').hidden, true);
  await app.click('pair-copy');
  assert.equal(app.clipboard.length, 1);
  assert.equal(app.storage.size, 0, 'copying must not persist the pairing secret');
});

test('clipboard denial leaves the current code visible with manual copy instructions', async () => {
  const service = pairingService();
  const app = await page({ fetch: service.fetch, clipboardDenied: true });
  await app.unlock(); await app.click('pair-begin'); await app.click('pair-copy');
  assert.match(app.get('notice').textContent, /手动选择/u);
  assert.equal(app.get('pair-code').textContent, 'PRIVATE-CODE-1');
  assert.equal(app.get('pair-copy').hidden, false);
  assert.equal(app.polls().length, 1);
});

test('locking and a fresh page recover pending pairing cancellation without redisplaying the code or submitting another begin', async () => {
  const service = pairingService();
  const original = await page({ fetch: service.fetch });
  await original.unlock(); await original.click('pair-begin');
  assert.equal(original.get('pair-code').textContent, 'PRIVATE-CODE-1');
  await original.click('lock');
  assert.equal(original.get('pair-code').textContent, '');
  assert.equal(original.polls().length, 0);
  await original.unlock();
  assert.equal(original.get('pairing').hidden, false);
  assert.equal(original.get('pair-cancel').hidden, false);
  assert.equal(original.get('pair-code').textContent, '');
  assert.match(original.get('pair-detail').textContent, /配对码不会再次显示/u);
  await original.click('pair-begin');
  assert.equal(service.requests.filter(request => request.operation === 'pair.begin').length, 1);
  assert.match(original.get('notice').textContent, /已有配对正在等待/u);
  await original.click('lock');

  const reopened = await page({ fetch: service.fetch });
  await reopened.unlock();
  assert.equal(reopened.get('pairing').hidden, false);
  assert.equal(reopened.get('pair-cancel').hidden, false);
  assert.equal(reopened.get('pair-code').textContent, '');
  assert.equal(reopened.polls().length, 1);
  await reopened.click('pair-cancel');
  assert.equal(reopened.get('pairing').hidden, true);
  assert.equal(reopened.polls().length, 0);
  assert.equal(service.requests.find(request => request.operation === 'pair.cancel')?.params.pairingId, '1'.padStart(32, '0'));
  await reopened.click('pair-begin');
  assert.equal(reopened.get('pair-code').textContent, 'PRIVATE-CODE-2');
});

test('a temporary pairing network failure hides the code and a successful pending poll restores the normal explanation', async () => {
  const service = pairingService([new Error('connection interrupted')]);
  const app = await page({ fetch: service.fetch });
  await app.unlock(); await app.click('pair-begin');
  assert.equal(app.get('pair-code').textContent, 'PRIVATE-CODE-1');
  await app.poll();
  assert.equal(app.get('pair-code').textContent, '');
  assert.equal(app.get('pair-cancel').hidden, false);
  assert.match(app.get('pair-detail').textContent, /正在重新确认配对状态/u);
  assert.equal(app.polls().length, 1);
  await app.poll();
  assert.equal(app.get('pair-code').textContent, '');
  assert.match(app.get('pair-detail').textContent, /配对仍在等待/u);
  assert.doesNotMatch(app.get('pair-detail').textContent, /无法连接|正在重新确认/u);
  assert.equal(app.polls().length, 1);
  await app.click('pair-cancel');
  assert.equal(app.polls().length, 0);
});

test('an unavailable pairing ID stops polling and removes the stale cancellation action', async () => {
  const service = pairingService([{ body: { version: 1, requestId: 'pairing-test', ok: false, error: { code: 'pairing_not_found', message: 'Pairing no longer exists.', retryable: false } } }]);
  const app = await page({ fetch: service.fetch });
  await app.unlock(); await app.click('pair-begin'); await app.poll();
  assert.equal(app.get('pair-code').textContent, '');
  assert.equal(app.get('pair-cancel').hidden, true);
  assert.equal(app.polls().length, 0);
  assert.match(app.get('pair-detail').textContent, /本次配对已不可用/u);
  await app.click('pair-cancel');
  assert.equal(service.requests.filter(request => request.operation === 'pair.cancel').length, 0);
  assert.equal(service.requests.filter(request => request.operation === 'pair.status').length, 1);
});

test('an old in-flight pairing response cannot overwrite a new pairing after locking and reauthorization', async () => {
  for (const staleReply of [
    success({ state: 'complete' }),
    { body: { version: 1, requestId: 'stale-pairing', ok: false, error: { code: 'pairing_not_found', message: 'Old pairing expired.', retryable: false } } },
  ]) {
    let finish!: (reply: Reply) => void;
    const pending = new Promise<Reply>(accept => { finish = accept; });
    const service = pairingService([pending]);
    const app = await page({ fetch: service.fetch });
    await app.unlock(); await app.click('pair-begin');
    const inflight = app.poll();
    await until(() => service.requests.some(request => request.operation === 'pair.status'));
    await app.click('lock'); await app.unlock(); await app.click('pair-cancel'); await app.click('pair-begin');
    const detail = app.get('pair-detail').textContent;
    const deviceReads = service.requests.filter(request => request.operation === 'devices.list').length;
    finish(staleReply); await inflight;
    assert.equal(app.get('pairing').hidden, false);
    assert.equal(app.get('pair-code').textContent, 'PRIVATE-CODE-2');
    assert.equal(app.get('pair-cancel').hidden, false);
    assert.equal(app.get('pair-detail').textContent, detail);
    assert.equal(app.polls().length, 1);
    assert.equal(service.requests.filter(request => request.operation === 'devices.list').length, deviceReads);
    await app.poll();
    assert.equal(service.requests.filter(request => request.operation === 'pair.status').at(-1)?.params.pairingId, '2'.padStart(32, '0'));
  }
});

test('a deterministic missing-job response stops polling and clears the legacy hint without reporting success', async () => {
  const app = await page({ saved: jobId, replies: [missing()] });
  await app.unlock(); await app.poll();
  assert.equal(app.requests.filter(request => request.operation === 'job.status').length, 1);
  assert.equal(app.polls().length, 0);
  assert.equal(app.storage.has(storageKey), false);
  assert.match(app.get('notice').textContent, /状态尚未确认/u);
  assert.doesNotMatch(app.get('notice').textContent, /已完成/u);
  assert.equal(app.get('notice').flags.get('error'), true);
});

test('network loss backs off, retains a running job, and clears the hint only after a real terminal result', async () => {
  const app = await page({ saved: jobId, replies: [new Error('connection interrupted'), terminal('running'), terminal('failed')] });
  await app.unlock(); await app.poll();
  assert.equal(app.polls()[0]?.[1].milliseconds, 3600);
  assert.equal(JSON.parse(app.storage.get(storageKey)!).jobId, jobId);
  await app.poll();
  assert.equal(app.polls()[0]?.[1].milliseconds, 1800);
  assert.equal(app.storage.has(storageKey), true);
  await app.poll();
  assert.equal(app.polls().length, 0); assert.equal(app.storage.has(storageKey), false);
  assert.match(app.get('notice').textContent, /后台作业失败/u);
});

test('temporary server failures retry, while 401 locks the page and keeps recovery for reauthorization', async () => {
  const app = await page({ saved: jobId, replies: [
    { status: 503, body: { error: { code: 'management_busy', message: 'Try later.', retryable: false } } },
    { status: 401, body: { error: { code: 'management_unlock_required', message: 'Unlock again.', retryable: false } } },
    terminal('succeeded'),
  ] });
  await app.unlock(); await app.poll();
  assert.equal(app.polls().length, 1); assert.equal(app.storage.has(storageKey), true);
  await app.poll();
  assert.equal(app.polls().length, 0); assert.equal(app.storage.has(storageKey), true);
  assert.equal(app.get('authorization').hidden, false); assert.equal(app.get('dashboard').hidden, true);
  await app.unlock(); await app.poll();
  assert.equal(app.storage.has(storageKey), false); assert.match(app.get('notice').textContent, /已完成/u);
});

test('recovery is scoped to its prefix and malformed hints are discarded', async () => {
  const wrong = await page({ saved: JSON.stringify({ version: 1, jobId, prefix: '/another-instance' }) });
  await wrong.unlock();
  assert.equal(wrong.requests.filter(request => request.operation === 'job.status').length, 0);
  assert.equal(wrong.polls().length, 0); assert.equal(wrong.storage.has(storageKey), false);
  assert.match(wrong.get('notice').textContent, /另一个本机实例/u);
  const malformed = await page({ saved: '{broken' });
  await malformed.unlock();
  assert.equal(malformed.polls().length, 0); assert.equal(malformed.storage.has(storageKey), false);
});

test('new submissions save only the instance and job ID, and manual locking keeps the recovery hint', async () => {
  const app = await page(); await app.unlock(); await app.click('submit-job');
  assert.deepEqual(JSON.parse(app.storage.get(storageKey)!), { version: 1, jobId, prefix });
  assert.equal(app.polls().length, 1);
  await app.click('lock');
  assert.equal(app.polls().length, 0); assert.equal(app.storage.has(storageKey), true);
});

test('the real HTTP handler preserves a native non-retryable error and the actual page stops recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-page-http-'));
  const authority = await createLocalManagementAuthority({ storageRoot: directory });
  let handler: ReturnType<typeof createManagementHandler>['handler'] | undefined;
  const server = createServer((request, response) => { void handler?.(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let statusCalls = 0;
  const web = createManagementHandler({
    origin, port: address.port,
    attachCredentials() { return { port: address.port, token: 'x'.repeat(43) }; },
    profile: { name: 'web', home: directory, dir: directory, cwd: directory, installAnchor: directory },
    registerRoute() { return () => {}; }, requestRejection(request) { return request.headers.cookie === 'dsh-session=valid' ? undefined : 401; },
    requestHostExit() {}, onReady() { return () => {}; }, registerManagementLink() { return () => {}; },
  }, {
    manager: {
      async state() { return { prefix, installed: false, hasConfiguration: false, nativeReady: true, bootstrapRequired: false }; },
      async execute(operation) {
        if (operation === 'job.status') { statusCalls += 1; return { version: 1, requestId: 'real-http', ok: false, error: { code: 'job_request_failed', message: 'The saved job no longer exists.', retryable: false } }; }
        return { version: 1, requestId: 'real-http', ok: true, result: { jobs: [] } };
      },
    },
    authority, installDefaults: {}, managed: false, localBrowserAvailable: false,
    async readAsset() { return Buffer.from(''); }, async openLocal() {},
  });
  handler = web.handler;
  try {
    const app = await page({ saved: jobId, async fetch(path, init) {
      return fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, cookie: 'dsh-session=valid', origin } });
    } });
    await app.unlock((await readFile(authority.capabilityFile, 'utf8')).trim());
    await app.poll();
    assert.equal(statusCalls, 1); assert.equal(app.polls().length, 0);
    assert.equal(app.storage.has(storageKey), false);
    assert.match(app.get('notice').textContent, /状态尚未确认/u);
  } finally {
    web.dispose(); server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    await rm(directory, { recursive: true, force: true });
  }
});
