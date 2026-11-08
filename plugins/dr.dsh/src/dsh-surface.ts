/**
 * The DSH surface this project depends on — all of it, in one file.
 *
 * ## The rule
 *
 * No other module in this repository may import from `@deepseek-ai/*`. DSH is a
 * developer preview whose README says, in bold, that there *will* be
 * compatibility-breaking changes; when one lands, exactly one file should need
 * reading and exactly one test should fail. That file is this one.
 *
 * ## How the assumptions are recorded
 *
 * Every entry in {@link DSH_SURFACE} names the behaviour relied on and the DSH
 * release it was verified against. The runtime guard checks the Cordis methods;
 * event names and payloads require the real-harness upgrade smoke test. Cordis
 * accepts arbitrary event names, so a static name set cannot detect an upgrade.
 *
 * ## What is relied on (DSH 0.2.2-rc.1)
 *
 * | Assumption | Evidence in DSH |
 * | :--- | :--- |
 * | Plugins are `apply(ctx, config)` with optional `name`/`inject` | `docs/cordis-primer.md` |
 * | A bundle contributes one layer via `dsh.bundle.patch` | `docs/user/develop/basic/publish.md` § The bundle manifest |
 * | `ctx.effect(fn, label)` scopes a disposable to plugin lifetime | `packages/host/webserver/src/index.ts`, `packages/client/connection/src/index.ts` |
 * | `session/event(session, event)` carries every committed session event | `packages/core/session/src/index.ts` |
 * | Approval/question observers must return `next()`; session is `request.agent.session` | `packages/interaction/{user-approval,user-questions}/src/types.ts` |
 * | Goal completion is `payload.change.operation === 'complete'` | `packages/goal/goal/src/domain.ts` |
 * | `subagent/end` carries the child session id as `info.id` | `packages/subagent/subagent/src/index.ts` |
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** DSH release this surface was verified against. */
export const VERIFIED_DSH_VERSION = '0.2.2-rc.1';
/** Exact upstream source revision reviewed for this integration. */
export const VERIFIED_DSH_REVISION = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db';

/**
 * The minimal shape of the Cordis context this plugin uses.
 *
 * Declared structurally instead of importing `@deepseek-ai/cordis`'s type: the
 * bundle stays free of DSH type dependencies, so a type change upstream is a
 * one-file fix here rather than a compile error in every package. The cost is
 * that this interface can drift from the real one — which is why the runtime
 * guard below exists and why this file is the one to review on upgrade.
 */
export interface DshContextLike {
  /**
   * Scopes a disposable to the plugin's lifetime.
   *
   * @param factory - runs immediately; returns the disposer.
   * @param label - optional name used by DSH's diagnostics.
   * @returns nothing; Cordis owns the disposer.
   */
  effect(factory: () => () => void, label?: string): void;
  /**
   * Subscribes to a harness event.
   *
   * @param event - event name, from {@link DSH_SURFACE}.
   * @param listener - receives the producer's arguments positionally.
   * @returns a disposer that unsubscribes.
   */
  on(
    event: string,
    listener: (...args: readonly unknown[]) => unknown,
    options?: { readonly prepend?: boolean },
  ): () => void;
}

/** One upstream assumption checked by the upgrade smoke test. */
export interface SurfaceEntry {
  /** Harness event or service key that must exist. */
  readonly key: string;
  /** Why the project needs it. */
  readonly why: string;
  /** Whether losing this event blocks compatibility acceptance. */
  readonly required: boolean;
}

/**
 * Every harness event this plugin listens to.
 *
 * Required events block upgrade acceptance. Their existence is not discoverable
 * at runtime; the real event producers must be exercised when upgrading DSH.
 */
export const DSH_SURFACE: readonly SurfaceEntry[] = [
  {
    key: 'session/event',
    why: 'turn completion notifications without retaining message content',
    required: false,
  },
  {
    key: 'approval/request',
    why: 'the one notification users must not miss while away from the machine',
    required: true,
  },
  {
    key: 'user-questions/request',
    why: 'a question waiting for an answer is an interruption, like approval',
    required: true,
  },
  {
    key: 'subagent/end',
    why: 'subagent completion is a notification-worthy milestone',
    required: false,
  },
  {
    key: 'goal/changed',
    why: 'goal completion is the clearest "your task is done" signal',
    required: false,
  },
];

/**
 * Checks the methods used to mount this plugin. This cannot check whether DSH
 * emits our event names or payload shapes; see docs/integration/dsh-surface.md.
 *
 * @param ctx - the context to probe; must offer the methods this plugin calls.
 * @throws Error when the Cordis plugin methods are unavailable.
 */
export function assertSupportedSurface(ctx: DshContextLike): void {
  const problems: string[] = [];
  if (typeof ctx.effect !== 'function' || typeof ctx.on !== 'function') {
    problems.push('ctx.effect/ctx.on (the Cordis plugin contract itself)');
  }
  if (problems.length > 0) {
    throw new Error(
      `dr.dsh: this DSH build does not offer what dr.dsh requires: ${problems.join('; ')}. `
      + `This bundle was verified against DSH ${VERIFIED_DSH_VERSION}; `
      + 'check the plugin version against your harness version.',
    );
  }
}

/** Event names required for upgrade acceptance; see {@link DSH_SURFACE}. */
export const REQUIRED_EVENT_NAMES: readonly string[] = DSH_SURFACE
  .filter(entry => entry.required)
  .map(entry => entry.key);

/** Content-free events the rest of the plugin understands. */
export interface HarnessNotification {
  readonly event: 'approval_requested' | 'turn_complete' | 'goal_complete' | 'subagent_complete';
  readonly sessionRef: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sessionRef(value: unknown): string | null {
  const id = typeof value === 'string' ? value : record(value)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function agentSessionRef(value: unknown): string | null {
  return sessionRef(record(value)?.session);
}

/** Session observers receive a Session instance followed by its committed event. */
export function sessionNotification(args: readonly unknown[]): HarnessNotification | undefined {
  if (record(args[1])?.type !== 'turn/end') return undefined;
  return { event: 'turn_complete', sessionRef: sessionRef(args[0]) };
}

/**
 * Subscribe without claiming an approval/question or retaining harness payloads.
 * Prepending ensures existing answerers cannot short-circuit our observation.
 */
export function observeHarness(
  ctx: DshContextLike,
  notify: (notification: HarnessNotification) => void,
): () => void {
  const disposers: (() => void)[] = [];
  const dispose = (): void => { for (const stop of disposers.splice(0).reverse()) stop(); };
  const observed = (notification: HarnessNotification): void => {
    // A failing notification sink must not change DSH's task or approval outcome.
    try { notify(notification); } catch { /* Best-effort observer only. */ }
  };
  try {
    for (const event of ['approval/request', 'user-questions/request']) {
      disposers.push(ctx.on(event, (...args) => {
        observed({ event: 'approval_requested', sessionRef: agentSessionRef(record(args[0])?.agent) });
        const next = args.at(-1);
        return typeof next === 'function' ? next() : undefined;
      }, { prepend: true }));
    }
    disposers.push(ctx.on('session/event', (...args) => {
      const notification = sessionNotification(args);
      if (notification !== undefined) observed(notification);
    }));
    disposers.push(ctx.on('goal/changed', (value) => {
      const payload = record(value);
      if (record(payload?.change)?.operation !== 'complete') return;
      observed({ event: 'goal_complete', sessionRef: agentSessionRef(payload?.agent) });
    }));
    disposers.push(ctx.on('subagent/end', (value) => {
      const id = sessionRef(record(value));
      if (id === null) return;
      observed({ event: 'subagent_complete', sessionRef: id });
    }));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

/** Current launcher facts, copied from DSH's profileContext rather than inferred from argv. */
export interface DshManagementProfile {
  readonly name: string;
  readonly home: string;
  readonly dir: string;
  readonly cwd: string;
  readonly installAnchor: string;
}

/** A route retains the Node response until its handler has completed. */
export type DshManagementRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Management resources may need asynchronous cleanup when their owning DSH fiber unloads. */
export type DshManagementDisposer = () => void | Promise<void>;

/**
 * The optional Web surface available to the management implementation.
 *
 * DSH's request check is only the browser trust fence. It accepts the daemon's
 * authenticated proxy too, so the management handler must additionally require
 * its own authorization and the daemon must refuse to proxy this namespace.
 */
export interface DshManagementSurface {
  readonly origin: string;
  readonly port: number;
  readonly profile: DshManagementProfile;
  /** Obtain DSH's own launch credential for the scoped native tunnel, never for a browser response. */
  attachCredentials(): { port: number; token: string };
  /** Register inside /_drdsh; the caller owns request authentication and the response. */
  registerRoute(path: string, kind: 'exact' | 'prefix', handler: DshManagementRouteHandler): () => void;
  /** Apply DSH's Host/Origin and authenticated browser/API peer checks. */
  requestRejection(req: IncomingMessage): 401 | 403 | undefined;
  /** Request DSH's bounded graceful application shutdown after the caller has replied. */
  requestHostExit(): void;
  /** Run only after DSH commits successful startup; cancelled when this surface unloads. */
  onReady(fn: () => void): () => void;
  /** Add a fixed, non-secret link to the authenticated DSH index. */
  registerManagementLink(): () => void;
}

interface ManagementFiber {
  dispose(): Promise<void>;
}

interface ManagementContext extends DshContextLike {
  get(key: string): unknown;
  inject(dependencies: string[], callback: (ctx: ManagementContext) => void): ManagementFiber;
}

/**
 * The runtime members used here were checked in DSH 0.2.1-rc.5, 0.2.2-alpha.2 and 0.2.2-rc.1:
 * dsh-host-webserver's WebServer, dsh-client-connection's HostConnectionHandle,
 * dsh-app-boot's ProfileContext and dsh-cmdline's AppExit/AppReady. A separate
 * injected child keeps missing Web services and management setup failures from
 * cancelling the report observer in the parent plugin.
 */
export function watchManagementSurface(
  ctx: DshContextLike,
  onReady: (surface: DshManagementSurface) => void | DshManagementDisposer,
  onError: (error: Error) => void,
): () => void {
  const report = (error: unknown): void => {
    // Diagnostics are observers too: a broken logger must not fail DSH's boot.
    try { onError(error instanceof Error ? error : new Error('dr.dsh: management setup failed; check plugin compatibility.')); } catch { /* Preserve the host and reporter. */ }
  };
  const context = ctx as ManagementContext;
  if (typeof context.inject !== 'function' || typeof context.get !== 'function') {
    report(new Error(`dr.dsh: management needs DSH ${VERIFIED_DSH_VERSION}'s optional service injection; reporting remains available.`));
    return () => {};
  }
  let stopped = false;
  let fiber: ManagementFiber | undefined;
  try {
    fiber = context.inject(['webServer', 'connection'], child => {
      if (stopped) return;
      const disposers: DshManagementDisposer[] = [];
      let disposed = false;
      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        for (const stop of disposers.splice(0).reverse()) {
          try { await stop(); } catch (error) { report(error); }
        }
      };
      const own = (stop: () => void): (() => void) => {
        let active = true;
        const release = (): void => {
          if (!active) return;
          active = false;
          stop();
        };
        disposers.push(release);
        return release;
      };
      try {
        child.effect(() => dispose, 'dr.dsh: optional management surface');
        const surface = managementSurface(child, own, report, () => !disposed && !stopped);
        const stop = onReady(surface);
        if (typeof stop === 'function') disposers.push(stop);
      } catch (error) {
        // Catch inside the child: leaving a FAILED fiber would make optional UI
        // setup participate in DSH's startup failure audit.
        void dispose();
        report(error);
      }
    });
  } catch (error) {
    report(error);
  }
  return () => {
    if (stopped) return;
    stopped = true;
    // Cordis owns this child on parent unload; explicit callers may stop early.
    try { void fiber?.dispose().catch(report); } catch (error) { report(error); }
  };
}

function managementSurface(
  ctx: ManagementContext,
  own: (stop: () => void) => () => void,
  report: (error: unknown) => void,
  active: () => boolean,
): DshManagementSurface {
  const server = record(ctx.get('webServer'));
  const connection = record(ctx.get('connection'));
  const profile = record(ctx.get('profileContext'));
  const appExit = ctx.get('appExit');
  const appReady = record(ctx.get('appReady'));
  if (typeof server?.getOrigin !== 'function' || typeof server.register !== 'function'
    || typeof connection?.requestRejection !== 'function' || typeof appExit !== 'function'
    || typeof appReady?.onReady !== 'function') {
    throw new Error(`dr.dsh: this DSH build lacks the Web management lifecycle contract verified with ${VERIFIED_DSH_VERSION}; reporting remains available.`);
  }
  for (const key of ['name', 'home', 'dir', 'cwd', 'installAnchor']) {
    if (typeof profile?.[key] !== 'string' || profile[key] === '') {
      throw new Error(`dr.dsh: DSH did not provide its current profile ${key}; restart through the DSH CLI before managing the daemon.`);
    }
  }
  const port = server.port;
  const origin = new URL(server.getOrigin.call(server) as string);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535
    || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.search || origin.hash || origin.pathname !== '/'
    || Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) !== port) {
    throw new Error('dr.dsh: DSH did not provide a usable listening origin; wait for Web startup before managing the daemon.');
  }
  const ensureActive = (): void => {
    if (!active()) throw new Error('dr.dsh: this management surface has closed; reload the DSH page before retrying.');
  };
  const register = server.register;
  const reject = connection.requestRejection;
  const ready = appReady.onReady;
  let unlink: (() => void) | undefined;
  return {
    origin: origin.origin,
    port,
    profile: Object.freeze({
      name: profile!.name as string,
      home: profile!.home as string,
      dir: profile!.dir as string,
      cwd: profile!.cwd as string,
      installAnchor: profile!.installAnchor as string,
    }),
    attachCredentials() {
      ensureActive();
      // Use the same public launch-token producer as web-app. No cookie forging
      // or trust-fence exemptions are needed for the local native companion.
      if (origin.protocol !== 'http:' || typeof connection.authenticatedUrl !== 'function') {
        throw new Error('dr.dsh: plugin relay access requires DSH HTTP loopback and its authenticatedUrl contract; use a supported local Web listener.');
      }
      const base = `http://127.0.0.1:${port}/`;
      let url: URL;
      try { url = new URL(connection.authenticatedUrl.call(connection, base) as string); }
      catch { throw new Error('dr.dsh: DSH did not provide a valid local launch URL; update the plugin and restart DSH.'); }
      const token = url.searchParams.get('token');
      if (url.origin !== new URL(base).origin || url.pathname !== '/' || url.hash
        || url.username || url.password || !token || !/^[A-Za-z0-9_-]{43}$/u.test(token)
        || [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1) {
        throw new Error('dr.dsh: DSH returned an unsupported local launch credential; update the plugin before connecting the relay.');
      }
      return { port, token };
    },
    registerRoute(path, kind, handler) {
      ensureActive();
      if ((path !== '/_drdsh' && !path.startsWith('/_drdsh/')) || path.endsWith('/')
        || /[?#%\\\u0000-\u0020]/u.test(path) || new URL(path, origin).pathname !== path
        || !['exact', 'prefix'].includes(kind)) {
        throw new Error('dr.dsh: management routes must use a canonical path inside /_drdsh; fix the plugin route registration.');
      }
      return own(register.call(server, { path, kind, handler }) as () => void);
    },
    requestRejection(req) {
      ensureActive();
      const rejection: unknown = reject.call(connection, req);
      if (rejection !== undefined && rejection !== 401 && rejection !== 403) {
        throw new Error('dr.dsh: DSH returned an unknown browser authorization result; update the plugin before managing the daemon.');
      }
      return rejection;
    },
    requestHostExit() {
      ensureActive();
      appExit(0);
    },
    onReady(fn) {
      ensureActive();
      return own(ready.call(appReady, () => {
        if (!active()) return;
        try { fn(); } catch (error) { report(error); }
      }) as () => void);
    },
    registerManagementLink() {
      ensureActive();
      if (unlink !== undefined) return unlink;
      unlink = own(ctx.on('webserver/index-inject', value => {
        if (!active() || !Array.isArray(value)) return;
        value.push({
          kind: 'style',
          text: '#drdsh-management-entry{position:fixed;right:16px;bottom:16px;z-index:1000;padding:7px 11px;border:1px solid #9ca3af;border-radius:8px;background:#fff;color:#111827;font:13px system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px #0002}#drdsh-management-entry:focus-visible{outline:3px solid #2563eb;outline-offset:2px}@media(prefers-color-scheme:dark){#drdsh-management-entry{background:#1f2937;color:#f9fafb;border-color:#6b7280}}',
        }, {
          kind: 'html',
          placement: 'body',
          html: '<a id="drdsh-management-entry" href="./_drdsh/manage" target="_blank" rel="noopener noreferrer">dr.dsh 管理</a>',
        });
      }));
      return unlink;
    },
  };
}
