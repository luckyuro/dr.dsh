import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';

import {
  observeHarness,
  watchManagementSurface,
  type DshContextLike,
  type DshManagementDisposer,
  type DshManagementRouteHandler,
  type DshManagementSurface,
} from './dsh-surface.ts';

type EventHandler = (...args: readonly unknown[]) => unknown;
type Route = { path: string; kind: 'exact' | 'prefix'; handler: DshManagementRouteHandler };
interface TestContext extends DshContextLike {
  get(key: string): unknown;
  inject(dependencies: string[], callback: (ctx: TestContext) => void): { dispose(): Promise<void> };
}

function fixture() {
  const events = new Map<string, Set<EventHandler>>();
  const routes = new Map<string, Route>();
  const readyListeners = new Set<() => void>();
  const errors: Error[] = [];
  const exits: number[] = [];
  let rejection: unknown;
  let activate: ((ctx: TestContext) => void) | undefined;
  let childDisposers: DshManagementDisposer[] = [];
  let disposing: Promise<void> = Promise.resolve();
  let fiberDisposals = 0;
  const profile = {
    name: 'custom-web',
    home: '/private/dsh-home',
    dir: '/private/dsh-home/profiles/custom-web',
    cwd: '/workspace/project',
    installAnchor: '/opt/dsh/lib/bin.js',
    overlays: ['not part of the public surface'],
  };
  const services: Record<string, unknown> = {
    webServer: {
      port: 3080,
      getOrigin() { assert.equal(this, services.webServer); return 'http://127.0.0.1:3080'; },
      register(route: Route) {
        assert.equal(this, services.webServer);
        const key = `${route.kind}:${route.path}`;
        assert.ok(!routes.has(key), 'a service reload must remove the old registration');
        routes.set(key, route);
        return () => { routes.delete(key); };
      },
    },
    connection: {
      requestRejection(_req: IncomingMessage) { assert.equal(this, services.connection); return rejection; },
      authenticatedUrl(base: string) { assert.equal(this, services.connection); return `${base}?token=${'a'.repeat(43)}`; },
    },
    profileContext: profile,
    appExit: (code: number) => { exits.push(code); },
    appReady: {
      onReady(fn: () => void) {
        assert.equal(this, services.appReady);
        readyListeners.add(fn);
        return () => { readyListeners.delete(fn); };
      },
    },
  };
  const on = (event: string, handler: EventHandler): (() => void) => {
    const listeners = events.get(event) ?? new Set();
    events.set(event, listeners);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  };
  const get = (key: string): unknown => services[key];
  function childContext(): TestContext {
    return {
      on,
      get,
      effect(factory: () => DshManagementDisposer) { childDisposers.push(factory()); },
      inject: context.inject,
    };
  }
  async function unload() {
    for (const stop of childDisposers.splice(0).reverse()) await stop();
  }
  const context: TestContext = {
    on,
    get,
    effect: () => {},
    inject(dependencies: string[], callback: (ctx: TestContext) => void) {
      assert.deepEqual(dependencies, ['webServer', 'connection']);
      activate = callback;
      callback(childContext());
      return {
        dispose() {
          fiberDisposals += 1;
          disposing = unload();
          return disposing;
        },
      };
    },
  };
  return {
    context, routes, errors, exits, profile, services,
    report(error: Error) { errors.push(error); },
    emit(event: string, ...args: readonly unknown[]) {
      for (const handler of [...(events.get(event) ?? [])]) handler(...args);
    },
    setRejection(value: unknown) { rejection = value; },
    ready() { for (const fn of [...readyListeners]) fn(); },
    async reload() { await unload(); activate?.(childContext()); },
    async settled() { await disposing; await new Promise(resolve => setImmediate(resolve)); },
    get readyCount() { return readyListeners.size; },
    get fiberDisposals() { return fiberDisposals; },
  };
}

test('the management surface uses current DSH services and scopes all resources to its child fiber', async () => {
  const host = fixture();
  let surface: DshManagementSurface | undefined;
  let ready = 0;
  let mountedDisposals = 0;
  const stop = watchManagementSurface(host.context, value => {
    surface = value;
    value.registerRoute('/_drdsh/manage', 'exact', () => {});
    value.registerRoute('/_drdsh/api', 'prefix', () => {});
    value.onReady(() => { ready += 1; });
    return async () => { await Promise.resolve(); mountedDisposals += 1; };
  }, host.report);
  assert.ok(surface);
  assert.deepEqual(surface.profile, {
    name: host.profile.name, home: host.profile.home, dir: host.profile.dir,
    cwd: host.profile.cwd, installAnchor: host.profile.installAnchor,
  });
  assert.ok(Object.isFrozen(surface.profile));
  assert.equal(surface.origin, 'http://127.0.0.1:3080');
  assert.equal(surface.port, 3080);
  assert.equal(ready, 0);
  host.ready();
  assert.equal(ready, 1);
  for (const rejection of [undefined, 401, 403] as const) {
    host.setRejection(rejection);
    assert.equal(surface.requestRejection({} as IncomingMessage), rejection);
  }
  host.setRejection(200);
  assert.throws(() => surface!.requestRejection({} as IncomingMessage), /unknown browser authorization result/);
  surface.requestHostExit();
  assert.deepEqual(host.exits, [0]);
  stop();
  stop();
  await host.settled();
  assert.equal(host.fiberDisposals, 1);
  assert.equal(mountedDisposals, 1);
  assert.equal(host.routes.size, 0);
  assert.equal(host.readyCount, 0);
  assert.throws(() => surface!.requestHostExit(), /surface has closed/);
  assert.deepEqual(host.errors, []);
});

test('the native tunnel receives the public DSH loopback launch credential without exposing it to routes', async () => {
  const host = fixture();
  let surface: DshManagementSurface | undefined;
  const stop = watchManagementSurface(host.context, value => { surface = value; }, host.report);
  assert.deepEqual(surface!.attachCredentials(), { port: 3080, token: 'a'.repeat(43) });
  assert.equal(host.routes.size, 0);
  const connection = host.services.connection as { authenticatedUrl(base: string): string };
  for (const url of ['https://relay.example/?token=private', 'http://127.0.0.1:3080/?token=private',
    `http://127.0.0.1:3080/?token=${'a'.repeat(43)}&extra=private`,
    `http://127.0.0.1:3080/?token=${'a'.repeat(43)}&token=${'b'.repeat(43)}`]) {
    connection.authenticatedUrl = () => url;
    assert.throws(() => surface!.attachCredentials(), error => error instanceof Error && !error.message.includes('private'));
  }
  stop();
  await host.settled();
  assert.throws(() => surface!.attachCredentials(), /closed/);
});

test('the DSH index link contains only a fixed public path and is removed on reload', async () => {
  const host = fixture();
  let mounts = 0;
  const stop = watchManagementSurface(host.context, surface => {
    mounts += 1;
    assert.equal(surface.registerManagementLink(), surface.registerManagementLink());
  }, host.report);
  const rows: unknown[] = [];
  host.emit('webserver/index-inject', rows);
  assert.equal(rows.length, 2);
  const encoded = JSON.stringify(rows);
  assert.match(encoded, /\.\/_drdsh\/manage/);
  assert.match(encoded, /dr\.dsh 管理/);
  assert.doesNotMatch(encoded, /private|3080|token|secret|capability/i);
  await host.reload();
  const afterReload: unknown[] = [];
  host.emit('webserver/index-inject', afterReload);
  assert.equal(mounts, 2);
  assert.equal(afterReload.length, 2, 'reloading must not stack index links');
  stop();
  await host.settled();
  const afterStop: unknown[] = [];
  host.emit('webserver/index-inject', afterStop);
  assert.deepEqual(afterStop, []);
});

test('partial management setup is rolled back without removing the report observer', async () => {
  const host = fixture();
  const reported: string[] = [];
  const stopReports = observeHarness(host.context, notification => reported.push(notification.event));
  const stop = watchManagementSurface(host.context, surface => {
    surface.registerRoute('/_drdsh/manage', 'exact', () => {});
    surface.registerManagementLink();
    throw new Error('management asset could not be loaded');
  }, host.report);
  await host.settled();
  assert.equal(host.routes.size, 0);
  const rows: unknown[] = [];
  host.emit('webserver/index-inject', rows);
  assert.deepEqual(rows, []);
  assert.equal(host.errors.length, 1);
  assert.match(host.errors[0]!.message, /management asset/);
  host.emit('session/event', { id: 'session' }, { type: 'turn/end' });
  assert.deepEqual(reported, ['turn_complete']);
  stop();
  await host.settled();
  host.emit('session/event', { id: 'session' }, { type: 'turn/end' });
  assert.deepEqual(reported, ['turn_complete', 'turn_complete']);
  stopReports();
});

test('missing management contracts and failing diagnostics cannot fail the report-only host', async () => {
  const minimal: DshContextLike = { on: () => () => {}, effect: () => {} };
  assert.doesNotThrow(() => watchManagementSurface(minimal, () => { throw new Error('must not mount'); }, () => { throw new Error('logger failed'); })());
  for (const service of ['webServer', 'connection', 'profileContext', 'appExit', 'appReady']) {
    const host = fixture();
    delete host.services[service];
    let mounted = false;
    const stop = watchManagementSurface(host.context, () => { mounted = true; }, host.report);
    await host.settled();
    assert.equal(mounted, false, service);
    assert.equal(host.errors.length, 1, service);
    stop();
    await host.settled();
  }
});

test('route ownership cannot escape the management namespace or silently normalize a path', async () => {
  const host = fixture();
  const stop = watchManagementSurface(host.context, surface => {
    for (const path of ['/api', '/_drdsh-evil/api', '/_drdsh/api/', '/_drdsh/../api',
      '/_drdsh/%2e%2e/api', '/_drdsh/api?token=x', '/_drdsh/api#key', '/_drdsh/\\api']) {
      assert.throws(() => surface.registerRoute(path, 'prefix', () => {}), /canonical path/);
    }
    assert.equal(host.routes.size, 0);
  }, host.report);
  assert.deepEqual(host.errors, []);
  stop();
  await host.settled();
});

test('readiness callback failures are reported without unmounting management or reports', async () => {
  const host = fixture();
  const stop = watchManagementSurface(host.context, surface => {
    surface.registerRoute('/_drdsh/manage', 'exact', () => {});
    surface.onReady(() => { throw new Error('announcement failed'); });
  }, host.report);
  assert.doesNotThrow(() => host.ready());
  assert.match(host.errors[0]!.message, /announcement failed/);
  assert.equal(host.routes.size, 1);
  stop();
  await host.settled();
});
